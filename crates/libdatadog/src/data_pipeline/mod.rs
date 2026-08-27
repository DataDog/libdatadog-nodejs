use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(target_arch = "wasm32")]
use std::cell::RefCell;
#[cfg(target_arch = "wasm32")]
use std::future::Future;
#[cfg(target_arch = "wasm32")]
use std::pin::Pin;
#[cfg(target_arch = "wasm32")]
use std::rc::Rc;
#[cfg(target_arch = "wasm32")]
use std::task::{Context, Poll};

use bytes::Bytes;
use futures::future::{AbortHandle, Abortable};
#[cfg(target_arch = "wasm32")]
use js_sys::{Function as JsFunction, Promise as JsPromise, Reflect};
use libdatadog_data_pipeline::{
    send_agentless_v04, AgentlessTraceConfig, SendAgentlessV04Error, TracerMetadata,
    DEFAULT_AGENTLESS_TIMEOUT,
};
use libdd_capabilities::{HttpClientCapability, HttpError, SleepCapability};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use napi_derive::napi;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::{JsCast, JsValue};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_futures::JsFuture;

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
    host: Option<Arc<HostFunctions>>,
}

struct HostFunctions {
    request: Arc<RequestFunction>,
    cancel_request: Arc<CancelFunction>,
    sleep: Arc<SleepFunction>,
    cancel_sleep: Arc<CancelFunction>,
    next_call_id: AtomicU32,
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
            host: Some(Arc::new(HostFunctions {
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
                next_call_id: AtomicU32::new(1),
            })),
        })
    }
}

impl HttpClientCapability for HostCapabilities {
    fn new_client() -> Self {
        Self { host: None }
    }

    fn new_without_connection_pooling() -> Self {
        Self::new_client()
    }

    async fn request(
        &self,
        request: http::Request<Bytes>,
    ) -> std::result::Result<http::Response<Bytes>, HttpError> {
        let host = self.host.as_ref().ok_or_else(|| {
            HttpError::Network(anyhow::anyhow!("host HTTP capability is unavailable"))
        })?;
        let id = host.next_call_id.fetch_add(1, Ordering::Relaxed);
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
        let mut guard = CancelGuard::new(id, host.cancel_request.clone());
        let promise = host
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
        Self { host: None }
    }

    async fn sleep(&self, duration: Duration) {
        let Some(host) = &self.host else {
            sleep_without_host(duration).await;
            return;
        };
        let id = host.next_call_id.fetch_add(1, Ordering::Relaxed);
        let milliseconds = duration_millis(duration);
        let mut guard = CancelGuard::new(id, host.cancel_sleep.clone());
        if let Ok(promise) = host.sleep.call_async((id, milliseconds).into()).await {
            let _ = promise.await;
        }
        guard.disarm();
    }
}

#[cfg(not(target_arch = "wasm32"))]
async fn sleep_without_host(duration: Duration) {
    tokio::time::sleep(duration).await;
}

#[cfg(target_arch = "wasm32")]
async fn sleep_without_host(duration: Duration) {
    WasmSendFuture(Box::pin(async move {
        let global = js_sys::global();
        let Ok(set_timeout) = Reflect::get(&global, &JsValue::from_str("setTimeout"))
            .and_then(|value| value.dyn_into::<JsFunction>())
        else {
            return;
        };
        let clear_timeout = Reflect::get(&global, &JsValue::from_str("clearTimeout"))
            .and_then(|value| value.dyn_into::<JsFunction>())
            .ok();
        let handle = Rc::new(RefCell::new(None));
        let promise_handle = handle.clone();
        let promise_global = global.clone();
        let milliseconds = duration_millis(duration);
        let promise = JsPromise::new(&mut move |resolve, _| {
            let result = set_timeout.call2(
                &promise_global,
                resolve.as_ref(),
                &JsValue::from_f64(f64::from(milliseconds)),
            );
            match result {
                Ok(value) => {
                    if let Ok(unref) = Reflect::get(&value, &JsValue::from_str("unref"))
                        .and_then(|value| value.dyn_into::<JsFunction>())
                    {
                        let _ = unref.call0(&value);
                    }
                    *promise_handle.borrow_mut() = Some(value);
                }
                Err(_) => {
                    let _ = resolve.call0(&JsValue::UNDEFINED);
                }
            }
        });
        let mut guard = GlobalTimerGuard {
            clear_timeout,
            global: global.into(),
            handle,
        };
        let _ = JsFuture::from(promise).await;
        guard.disarm();
    }))
    .await;
}

#[cfg(target_arch = "wasm32")]
struct WasmSendFuture(Pin<Box<dyn Future<Output = ()>>>);

// SAFETY: wasm32-unknown-unknown uses the single-thread NAPI runtime, so this
// future cannot move to another thread while it contains JavaScript values.
#[cfg(target_arch = "wasm32")]
unsafe impl Send for WasmSendFuture {}

#[cfg(target_arch = "wasm32")]
impl Future for WasmSendFuture {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        self.0.as_mut().poll(context)
    }
}

#[cfg(target_arch = "wasm32")]
struct GlobalTimerGuard {
    clear_timeout: Option<JsFunction>,
    global: JsValue,
    handle: Rc<RefCell<Option<JsValue>>>,
}

#[cfg(target_arch = "wasm32")]
impl GlobalTimerGuard {
    fn disarm(&mut self) {
        self.handle.borrow_mut().take();
    }
}

#[cfg(target_arch = "wasm32")]
impl Drop for GlobalTimerGuard {
    fn drop(&mut self) {
        if let (Some(clear_timeout), Some(handle)) =
            (&self.clear_timeout, self.handle.borrow_mut().take())
        {
            let _ = clear_timeout.call1(&self.global, &handle);
        }
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
                Ok(Err(error)) => Err(send_error(error)),
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

fn send_error(error: SendAgentlessV04Error) -> Error {
    Error::from_reason(format!("failed to send data-pipeline export: {error}"))
}
