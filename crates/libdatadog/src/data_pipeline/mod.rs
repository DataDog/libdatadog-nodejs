use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use futures::future::{AbortHandle, Abortable};
use libdatadog_data_pipeline::{
    send_agentless_v04, AgentlessTraceConfig, TracerMetadata, DEFAULT_AGENTLESS_TIMEOUT,
};
use libdd_capabilities::{HttpClientCapability, HttpError, SleepCapability};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use napi_derive::napi;

type RequestFunction = ThreadsafeFunction<
    AgentlessRequest,
    Promise<AgentlessResponse>,
    AgentlessRequest,
    Status,
    false,
    true,
>;
type SleepArgs = FnArgs<(u32, u32)>;
type SleepFunction = ThreadsafeFunction<SleepArgs, Promise<()>, SleepArgs, Status, false, true>;
type CancelFunction = ThreadsafeFunction<u32, (), u32, Status, false, true>;

#[napi(object)]
pub struct AgentlessExporterOptions {
    pub endpoint: String,
    pub api_key: String,
    pub hostname: Option<String>,
    pub env: Option<String>,
    pub service: Option<String>,
    pub version: Option<String>,
    pub runtime_id: Option<String>,
    pub container_id: Option<String>,
    pub tracer_version: String,
    pub language_version: String,
    pub language_interpreter: String,
    pub timeout_ms: Option<u32>,
}

#[napi(object)]
pub struct AgentlessRequestHeader {
    pub name: String,
    pub value: String,
}

#[napi(object)]
pub struct AgentlessRequest {
    pub id: u32,
    pub url: String,
    pub method: String,
    pub headers: Vec<AgentlessRequestHeader>,
    pub body: Buffer,
}

#[napi(object)]
pub struct AgentlessResponse {
    pub status: u16,
    pub body: Buffer,
}

#[derive(Clone)]
pub(crate) struct HostCapabilities {
    request: Arc<RequestFunction>,
    cancel_request: Arc<CancelFunction>,
    sleep: Arc<SleepFunction>,
    cancel_sleep: Arc<CancelFunction>,
    next_call_id: Arc<AtomicU32>,
}

impl fmt::Debug for HostCapabilities {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("HostCapabilities")
    }
}

impl HostCapabilities {
    pub(crate) fn new(
        request: Function<'_, AgentlessRequest, Promise<AgentlessResponse>>,
        cancel_request: Function<'_, u32, ()>,
        sleep: Function<'_, FnArgs<(u32, u32)>, Promise<()>>,
        cancel_sleep: Function<'_, u32, ()>,
    ) -> Result<Self> {
        Ok(Self {
            request: Arc::new(
                request
                    .build_threadsafe_function::<AgentlessRequest>()
                    .weak::<true>()
                    .build()?,
            ),
            cancel_request: Arc::new(
                cancel_request
                    .build_threadsafe_function::<u32>()
                    .weak::<true>()
                    .build()?,
            ),
            sleep: Arc::new(
                sleep
                    .build_threadsafe_function::<SleepArgs>()
                    .weak::<true>()
                    .build()?,
            ),
            cancel_sleep: Arc::new(
                cancel_sleep
                    .build_threadsafe_function::<u32>()
                    .weak::<true>()
                    .build()?,
            ),
            next_call_id: Arc::new(AtomicU32::new(1)),
        })
    }

    fn next_call_id(&self) -> u32 {
        self.next_call_id.fetch_add(1, Ordering::Relaxed)
    }
}

impl HttpClientCapability for HostCapabilities {
    fn new_client() -> Self {
        panic!("host capabilities must be constructed with JavaScript functions")
    }

    fn new_without_connection_pooling() -> Self {
        Self::new_client()
    }

    async fn request(
        &self,
        request: http::Request<Bytes>,
    ) -> std::result::Result<http::Response<Bytes>, HttpError> {
        let id = self.next_call_id();
        let (parts, body) = request.into_parts();
        let headers = parts
            .headers
            .iter()
            .map(|(name, value)| {
                value
                    .to_str()
                    .map(|value| AgentlessRequestHeader {
                        name: name.to_string(),
                        value: value.to_string(),
                    })
                    .map_err(|error| HttpError::InvalidRequest(error.into()))
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let request = AgentlessRequest {
            id,
            url: parts.uri.to_string(),
            method: parts.method.to_string(),
            headers,
            body: body.to_vec().into(),
        };
        let mut guard = CancelGuard::new(id, self.cancel_request.clone());
        let promise = self
            .request
            .call_async(request)
            .await
            .map_err(network_error)?;
        let response = promise.await.map_err(network_error)?;
        guard.disarm();

        http::Response::builder()
            .status(response.status)
            .body(Bytes::from(response.body.to_vec()))
            .map_err(|error| HttpError::InvalidRequest(error.into()))
    }
}

impl SleepCapability for HostCapabilities {
    fn new() -> Self {
        panic!("host capabilities must be constructed with JavaScript functions")
    }

    async fn sleep(&self, duration: Duration) {
        let id = self.next_call_id();
        let milliseconds = duration_millis(duration);
        let mut guard = CancelGuard::new(id, self.cancel_sleep.clone());
        if let Ok(promise) = self.sleep.call_async((id, milliseconds).into()).await {
            let _ = promise.await;
        }
        guard.disarm();
    }
}

struct CancelGuard {
    id: u32,
    cancel: Arc<CancelFunction>,
    armed: bool,
}

impl CancelGuard {
    fn new(id: u32, cancel: Arc<CancelFunction>) -> Self {
        Self {
            id,
            cancel,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if self.armed {
            self.cancel
                .call(self.id, ThreadsafeFunctionCallMode::NonBlocking);
        }
    }
}

#[napi]
pub struct AgentlessExporter {
    metadata: TracerMetadata,
    config: AgentlessTraceConfig,
    capabilities: HostCapabilities,
    in_flight: Arc<Mutex<HashMap<u32, AbortHandle>>>,
    next_operation_id: Arc<AtomicU32>,
}

#[napi]
impl AgentlessExporter {
    #[napi(constructor)]
    pub fn new(
        options: AgentlessExporterOptions,
        request: Function<'_, AgentlessRequest, Promise<AgentlessResponse>>,
        cancel_request: Function<'_, u32, ()>,
        sleep: Function<'_, FnArgs<(u32, u32)>, Promise<()>>,
        cancel_sleep: Function<'_, u32, ()>,
    ) -> Result<Self> {
        let timeout = options
            .timeout_ms
            .map(|timeout_ms| Duration::from_millis(u64::from(timeout_ms)))
            .unwrap_or(DEFAULT_AGENTLESS_TIMEOUT);
        let metadata = TracerMetadata {
            hostname: options.hostname.unwrap_or_default(),
            env: options.env.unwrap_or_default(),
            app_version: options.version.unwrap_or_default(),
            runtime_id: options.runtime_id.unwrap_or_default(),
            service: options.service.unwrap_or_default(),
            tracer_version: options.tracer_version,
            language: "nodejs".to_string(),
            language_version: options.language_version,
            language_interpreter: options.language_interpreter,
            container_id: options.container_id.unwrap_or_default(),
            ..Default::default()
        };
        let config = AgentlessTraceConfig {
            endpoint_url: options.endpoint,
            api_key: options.api_key,
            timeout,
        };
        let capabilities = HostCapabilities::new(request, cancel_request, sleep, cancel_sleep)?;

        Ok(Self {
            metadata,
            config,
            capabilities,
            in_flight: Arc::new(Mutex::new(HashMap::new())),
            next_operation_id: Arc::new(AtomicU32::new(1)),
        })
    }

    #[napi]
    pub fn send_v04<'env>(&self, env: &'env Env, payload: Buffer) -> Result<PromiseRaw<'env, ()>> {
        let operation_id = self.next_operation_id.fetch_add(1, Ordering::Relaxed);
        let (abort, registration) = AbortHandle::new_pair();
        lock(&self.in_flight).insert(operation_id, abort);
        let capabilities = self.capabilities.clone();
        let metadata = self.metadata.clone();
        let config = self.config.clone();
        let in_flight = self.in_flight.clone();
        let cleanup = in_flight.clone();
        let future = async move {
            let _guard = OperationGuard {
                id: operation_id,
                in_flight,
            };
            let send = send_agentless_v04(&capabilities, payload.as_ref(), &metadata, &config);

            match Abortable::new(send, registration).await {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(error)) => Err(Error::from_reason(error.to_string())),
                Err(_) => Err(Error::from_reason("data-pipeline export was cancelled")),
            }
        };

        match env.spawn_future(future) {
            Ok(promise) => Ok(promise),
            Err(error) => {
                lock(&cleanup).remove(&operation_id);
                Err(error)
            }
        }
    }

    #[napi]
    pub fn cancel_all(&self) {
        for abort in lock(&self.in_flight).values() {
            abort.abort();
        }
    }
}

impl Drop for AgentlessExporter {
    fn drop(&mut self) {
        self.cancel_all();
    }
}

struct OperationGuard {
    id: u32,
    in_flight: Arc<Mutex<HashMap<u32, AbortHandle>>>,
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        lock(&self.in_flight).remove(&self.id);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

fn duration_millis(duration: Duration) -> u32 {
    u32::try_from(duration.as_millis()).unwrap_or(u32::MAX)
}

fn network_error(error: napi::Error) -> HttpError {
    HttpError::Network(anyhow::anyhow!(error.reason))
}
