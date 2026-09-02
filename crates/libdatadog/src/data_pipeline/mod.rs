use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use futures::future::{AbortHandle, Abortable};
use libdatadog_data_pipeline::{
    send_agentless_v04, AgentlessTraceConfig, SendAgentlessV04Error, TracerMetadata,
    DEFAULT_AGENTLESS_TIMEOUT,
};
use libdd_capabilities::{HttpClientCapability, HttpError, SleepCapability};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
#[cfg(not(target_arch = "wasm32"))]
use napi::{sys, JsValue};
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
type RequestCallback = FunctionRef<AgentlessRequest, Promise<AgentlessResponse>>;
type SleepCallback = FunctionRef<SleepArgs, Promise<()>>;
type CancelCallback = FunctionRef<u32, ()>;

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
    pub obfuscation: Option<serde_json::Value>,
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
    functions: Arc<Mutex<HostFunctions>>,
    next_call_id: Arc<AtomicU32>,
    #[cfg(not(target_arch = "wasm32"))]
    _context: Option<Arc<AsyncContext>>,
}

struct HostFunctions {
    request: Arc<RequestFunction>,
    cancel_request: Arc<CancelFunction>,
    sleep: Arc<SleepFunction>,
    cancel_sleep: Arc<CancelFunction>,
}

#[derive(Clone)]
pub(crate) struct HostCallbacks {
    request: Arc<RequestCallback>,
    cancel_request: Arc<CancelCallback>,
    sleep: Arc<SleepCallback>,
    cancel_sleep: Arc<CancelCallback>,
    next_call_id: Arc<AtomicU32>,
}

#[cfg(not(target_arch = "wasm32"))]
struct AsyncContext {
    env: sys::napi_env,
    resource: sys::napi_ref,
    value: sys::napi_async_context,
}

// SAFETY: this binding always installs the CurrentThread runtime. The context
// is created, used, and destroyed on its owning JavaScript thread.
#[cfg(not(target_arch = "wasm32"))]
unsafe impl Send for AsyncContext {}
#[cfg(not(target_arch = "wasm32"))]
unsafe impl Sync for AsyncContext {}

#[cfg(not(target_arch = "wasm32"))]
struct SendUnknown(Unknown<'static>);

#[cfg(not(target_arch = "wasm32"))]
impl ToNapiValue for SendUnknown {
    unsafe fn to_napi_value(_env: sys::napi_env, value: Self) -> Result<sys::napi_value> {
        Ok(value.0.raw())
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl AsyncContext {
    fn new(env: &Env) -> Result<Self> {
        let resource = Object::new(env)?;
        let name = env.create_string("libdatadog operation")?;
        let mut resource_ref = std::ptr::null_mut();
        check_status!(unsafe {
            sys::napi_create_reference(env.raw(), resource.raw(), 1, &mut resource_ref)
        })?;
        let mut value = std::ptr::null_mut();
        let status =
            unsafe { sys::napi_async_init(env.raw(), resource.raw(), name.raw(), &mut value) };
        if status != sys::Status::napi_ok {
            unsafe { sys::napi_delete_reference(env.raw(), resource_ref) };
            check_status!(status)?;
        }
        Ok(Self {
            env: env.raw(),
            resource: resource_ref,
            value,
        })
    }

    fn make_callback<Args, Return>(
        &self,
        env: &Env,
        callback: &Function<'_, Args, Return>,
        args: Args,
    ) -> Result<SendUnknown>
    where
        Args: JsValuesTupleIntoVec,
    {
        let mut receiver = std::ptr::null_mut();
        check_status!(unsafe {
            sys::napi_get_reference_value(env.raw(), self.resource, &mut receiver)
        })?;
        let args = args.into_vec(env.raw())?;
        let mut result = std::ptr::null_mut();
        check_pending_exception!(env.raw(), unsafe {
            sys::napi_make_callback(
                env.raw(),
                self.value,
                receiver,
                callback.raw(),
                args.len(),
                args.as_ptr(),
                &mut result,
            )
        })?;
        if result.is_null() {
            return Err(Error::from_reason("JavaScript callback returned no value"));
        }
        Ok(SendUnknown(unsafe {
            Unknown::from_raw_unchecked(env.raw(), result)
        }))
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Drop for AsyncContext {
    fn drop(&mut self) {
        let status = unsafe { sys::napi_async_destroy(self.env, self.value) };
        debug_assert_eq!(status, sys::Status::napi_ok);
        let status = unsafe { sys::napi_delete_reference(self.env, self.resource) };
        debug_assert_eq!(status, sys::Status::napi_ok);
    }
}

impl fmt::Debug for HostCapabilities {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("HostCapabilities")
    }
}

impl HostCapabilities {
    fn next_call_id(&self) -> u32 {
        self.next_call_id.fetch_add(1, Ordering::Relaxed)
    }

    pub(crate) fn replace_functions(&self, capabilities: &Self) {
        let replacement = lock(&capabilities.functions);
        let mut functions = lock(&self.functions);
        functions.request = replacement.request.clone();
        functions.cancel_request = replacement.cancel_request.clone();
        functions.sleep = replacement.sleep.clone();
        functions.cancel_sleep = replacement.cancel_sleep.clone();
    }
}

impl HostCallbacks {
    pub(crate) fn new(
        request: Function<'_, AgentlessRequest, Promise<AgentlessResponse>>,
        cancel_request: Function<'_, u32, ()>,
        sleep: Function<'_, SleepArgs, Promise<()>>,
        cancel_sleep: Function<'_, u32, ()>,
    ) -> Result<Self> {
        Ok(Self {
            request: Arc::new(request.create_ref()?),
            cancel_request: Arc::new(cancel_request.create_ref()?),
            sleep: Arc::new(sleep.create_ref()?),
            cancel_sleep: Arc::new(cancel_sleep.create_ref()?),
            next_call_id: Arc::new(AtomicU32::new(1)),
        })
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn capabilities(&self, env: &Env) -> Result<HostCapabilities> {
        let context = Arc::new(AsyncContext::new(env)?);
        Ok(HostCapabilities {
            functions: Arc::new(Mutex::new(HostFunctions {
                request: Arc::new(contextual_request(env, &context, self.request.clone())?),
                cancel_request: Arc::new(contextual_cancel(
                    env,
                    &context,
                    self.cancel_request.clone(),
                )?),
                sleep: Arc::new(contextual_sleep(env, &context, self.sleep.clone())?),
                cancel_sleep: Arc::new(contextual_cancel(
                    env,
                    &context,
                    self.cancel_sleep.clone(),
                )?),
            })),
            next_call_id: self.next_call_id.clone(),
            _context: Some(context),
        })
    }

    #[cfg(target_arch = "wasm32")]
    pub(crate) fn capabilities(&self, env: &Env) -> Result<HostCapabilities> {
        Ok(HostCapabilities {
            functions: Arc::new(Mutex::new(HostFunctions {
                request: Arc::new(
                    self.request
                        .borrow_back(env)?
                        .build_threadsafe_function::<AgentlessRequest>()
                        .weak::<true>()
                        .build()?,
                ),
                cancel_request: Arc::new(
                    self.cancel_request
                        .borrow_back(env)?
                        .build_threadsafe_function::<u32>()
                        .weak::<true>()
                        .build()?,
                ),
                sleep: Arc::new(
                    self.sleep
                        .borrow_back(env)?
                        .build_threadsafe_function::<SleepArgs>()
                        .weak::<true>()
                        .build()?,
                ),
                cancel_sleep: Arc::new(
                    self.cancel_sleep
                        .borrow_back(env)?
                        .build_threadsafe_function::<u32>()
                        .weak::<true>()
                        .build()?,
                ),
            })),
            next_call_id: self.next_call_id.clone(),
        })
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn contextual_request(
    env: &Env,
    context: &Arc<AsyncContext>,
    callback: Arc<RequestCallback>,
) -> Result<RequestFunction> {
    let context = context.clone();
    let function: Function<'_, AgentlessRequest, SendUnknown> =
        env.create_function_from_closure("libdatadogRequest", move |call| {
            let callback = callback.borrow_back(call.env)?;
            context.make_callback(call.env, &callback, call.first_arg()?)
        })?;
    let function = unsafe {
        Function::<AgentlessRequest, Promise<AgentlessResponse>>::from_napi_value(
            env.raw(),
            function.raw(),
        )?
    };
    function
        .build_threadsafe_function::<AgentlessRequest>()
        .weak::<true>()
        .build()
}

#[cfg(not(target_arch = "wasm32"))]
fn contextual_sleep(
    env: &Env,
    context: &Arc<AsyncContext>,
    callback: Arc<SleepCallback>,
) -> Result<SleepFunction> {
    let context = context.clone();
    let function: Function<'_, SleepArgs, SendUnknown> =
        env.create_function_from_closure("libdatadogSleep", move |call| {
            let callback = callback.borrow_back(call.env)?;
            let args = call.args::<(u32, u32)>()?;
            context.make_callback(call.env, &callback, args.into())
        })?;
    let function =
        unsafe { Function::<SleepArgs, Promise<()>>::from_napi_value(env.raw(), function.raw())? };
    function
        .build_threadsafe_function::<SleepArgs>()
        .weak::<true>()
        .build()
}

#[cfg(not(target_arch = "wasm32"))]
fn contextual_cancel(
    env: &Env,
    context: &Arc<AsyncContext>,
    callback: Arc<CancelCallback>,
) -> Result<CancelFunction> {
    let context = context.clone();
    let function: Function<'_, u32, SendUnknown> =
        env.create_function_from_closure("libdatadogCancel", move |call| {
            let callback = callback.borrow_back(call.env)?;
            context.make_callback(call.env, &callback, call.first_arg()?)
        })?;
    let function = unsafe { Function::<u32, ()>::from_napi_value(env.raw(), function.raw())? };
    function
        .build_threadsafe_function::<u32>()
        .weak::<true>()
        .build()
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
        let (request_function, cancel_request) = {
            let functions = lock(&self.functions);
            (functions.request.clone(), functions.cancel_request.clone())
        };
        let mut guard = CancelGuard::new(id, cancel_request);
        let promise = request_function
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
        let (sleep, cancel_sleep) = {
            let functions = lock(&self.functions);
            (functions.sleep.clone(), functions.cancel_sleep.clone())
        };
        let mut guard = CancelGuard::new(id, cancel_sleep);
        if let Ok(promise) = sleep.call_async((id, milliseconds).into()).await {
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
    config: Arc<AgentlessTraceConfig>,
    callbacks: HostCallbacks,
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
        let obfuscation_config = options
            .obfuscation
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| Error::from_reason(error.to_string()))?
            .unwrap_or_default();
        let config = Arc::new(AgentlessTraceConfig {
            endpoint_url: options.endpoint,
            api_key: options.api_key,
            timeout,
            obfuscation_config,
        });
        let callbacks = HostCallbacks::new(request, cancel_request, sleep, cancel_sleep)?;

        Ok(Self {
            metadata,
            config,
            callbacks,
            in_flight: Arc::new(Mutex::new(HashMap::new())),
            next_operation_id: Arc::new(AtomicU32::new(1)),
        })
    }

    #[napi]
    pub fn send_v04<'env>(&self, env: &'env Env, payload: Buffer) -> Result<PromiseRaw<'env, ()>> {
        let operation_id = self.next_operation_id.fetch_add(1, Ordering::Relaxed);
        let (abort, registration) = AbortHandle::new_pair();
        lock(&self.in_flight).insert(operation_id, abort);
        let capabilities = self.callbacks.capabilities(env)?;
        let metadata = self.metadata.clone();
        let config = self.config.clone();
        let in_flight = self.in_flight.clone();
        let cleanup = in_flight.clone();
        let future = async move {
            let _guard = OperationGuard {
                id: operation_id,
                in_flight,
            };
            let send = send_agentless_v04(
                &capabilities,
                payload.as_ref(),
                &metadata,
                config.as_ref(),
                false,
            );

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
    Error::from_reason(error.to_string())
}
