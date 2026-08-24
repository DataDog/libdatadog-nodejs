use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::fmt;
use std::rc::Rc;
use std::time::Duration;

use bytes::Bytes;
use futures::future::{AbortHandle, Abortable};
use js_sys::{Array, Function, Object, Promise, Reflect, Uint8Array};
use libdd_capabilities::{HttpClientCapability, HttpError, SleepCapability};
use libdd_data_pipeline_core::{
    prepare_agentless_v04_request, AgentlessTraceConfig, TracerMetadata, DEFAULT_AGENTLESS_TIMEOUT,
};
use libdd_trace_utils::send_with_retry::{send_prepared_with_retry, SendWithRetryError};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[derive(Clone)]
struct AgentlessExporterOptions {
    endpoint: String,
    api_key: String,
    hostname: Option<String>,
    env: Option<String>,
    service: Option<String>,
    version: Option<String>,
    runtime_id: Option<String>,
    container_id: Option<String>,
    tracer_version: String,
    language_version: String,
    language_interpreter: String,
    timeout_ms: Option<u32>,
}

#[derive(Clone)]
struct HostCapabilities {
    request: Function,
    cancel_request: Function,
    sleep: Function,
    cancel_sleep: Function,
    next_call_id: Rc<Cell<u32>>,
}

impl fmt::Debug for HostCapabilities {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("HostCapabilities")
    }
}

impl HostCapabilities {
    fn next_call_id(&self) -> u32 {
        let id = self.next_call_id.get();
        self.next_call_id.set(id.wrapping_add(1));
        id
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
    ) -> Result<http::Response<Bytes>, HttpError> {
        let id = self.next_call_id();
        let plan = request_value(id, request)?;
        let mut guard = CancelGuard::new(id, self.cancel_request.clone());
        let promise = self
            .request
            .call1(&JsValue::UNDEFINED, &plan)
            .map(|value| Promise::resolve(&value))
            .map_err(network_error)?;
        let response = JsFuture::from(promise).await.map_err(network_error)?;
        guard.disarm();

        let status = required_number(&response, "status")?;
        let status =
            u16::try_from(status).map_err(|error| HttpError::InvalidRequest(error.into()))?;
        let body = Reflect::get(&response, &JsValue::from_str("body")).map_err(network_error)?;
        http::Response::builder()
            .status(status)
            .body(Bytes::from(Uint8Array::new(&body).to_vec()))
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
        if let Ok(value) = self.sleep.call2(
            &JsValue::UNDEFINED,
            &JsValue::from_f64(f64::from(id)),
            &JsValue::from_f64(f64::from(milliseconds)),
        ) {
            let _ = JsFuture::from(Promise::resolve(&value)).await;
        }
        guard.disarm();
    }
}

struct CancelGuard {
    id: u32,
    cancel: Function,
    armed: bool,
}

impl CancelGuard {
    fn new(id: u32, cancel: Function) -> Self {
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
            let _ = self
                .cancel
                .call1(&JsValue::UNDEFINED, &JsValue::from_f64(f64::from(self.id)));
        }
    }
}

#[wasm_bindgen]
pub struct AgentlessExporter {
    metadata: TracerMetadata,
    config: AgentlessTraceConfig,
    capabilities: HostCapabilities,
    in_flight: Rc<RefCell<HashMap<u32, AbortHandle>>>,
    next_operation_id: Cell<u32>,
}

#[wasm_bindgen]
impl AgentlessExporter {
    #[wasm_bindgen(constructor)]
    pub fn new(
        value: JsValue,
        request: Function,
        cancel_request: Function,
        sleep: Function,
        cancel_sleep: Function,
    ) -> Result<AgentlessExporter, JsValue> {
        let options = AgentlessExporterOptions {
            endpoint: required_string(&value, "endpoint")?,
            api_key: required_string(&value, "apiKey")?,
            hostname: optional_string(&value, "hostname")?,
            env: optional_string(&value, "env")?,
            service: optional_string(&value, "service")?,
            version: optional_string(&value, "version")?,
            runtime_id: optional_string(&value, "runtimeId")?,
            container_id: optional_string(&value, "containerId")?,
            tracer_version: required_string(&value, "tracerVersion")?,
            language_version: required_string(&value, "languageVersion")?,
            language_interpreter: required_string(&value, "languageInterpreter")?,
            timeout_ms: optional_number(&value, "timeoutMs")?,
        };
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
        let timeout = options
            .timeout_ms
            .map(|timeout_ms| Duration::from_millis(u64::from(timeout_ms)))
            .unwrap_or(DEFAULT_AGENTLESS_TIMEOUT);
        let config = AgentlessTraceConfig {
            endpoint_url: options.endpoint,
            api_key: options.api_key,
            timeout,
        };
        let capabilities = HostCapabilities {
            request,
            cancel_request,
            sleep,
            cancel_sleep,
            next_call_id: Rc::new(Cell::new(1)),
        };

        Ok(Self {
            metadata,
            config,
            capabilities,
            in_flight: Rc::new(RefCell::new(HashMap::new())),
            next_operation_id: Cell::new(1),
        })
    }

    #[wasm_bindgen(js_name = sendV04)]
    pub async fn send_v04(&self, payload: &[u8]) -> Result<(), JsValue> {
        let prepared = prepare_agentless_v04_request(payload, &self.metadata, &self.config)
            .map_err(|error| {
                JsValue::from_str(&format!("failed to prepare data-pipeline export: {error}"))
            })?;
        let operation_id = self.next_operation_id.get();
        self.next_operation_id.set(operation_id.wrapping_add(1));
        let (abort, registration) = AbortHandle::new_pair();
        self.in_flight.borrow_mut().insert(operation_id, abort);
        let _guard = OperationGuard {
            id: operation_id,
            in_flight: self.in_flight.clone(),
        };
        let send = send_prepared_with_retry(
            &self.capabilities,
            prepared.request_plan(),
            prepared.retry_strategy(),
        );

        match Abortable::new(send, registration).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(send_error(error)),
            Err(_) => Err(JsValue::from_str("data-pipeline export was cancelled")),
        }
    }

    #[wasm_bindgen(js_name = cancelAll)]
    pub fn cancel_all(&self) {
        for abort in self.in_flight.borrow().values() {
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
    in_flight: Rc<RefCell<HashMap<u32, AbortHandle>>>,
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        self.in_flight.borrow_mut().remove(&self.id);
    }
}

fn request_value(id: u32, request: http::Request<Bytes>) -> Result<JsValue, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = Array::new();
    for (name, value) in &parts.headers {
        let value = value
            .to_str()
            .map_err(|error| HttpError::InvalidRequest(error.into()))?;
        let header = Object::new();
        Reflect::set(
            &header,
            &JsValue::from_str("name"),
            &JsValue::from_str(name.as_str()),
        )
        .map_err(network_error)?;
        Reflect::set(
            &header,
            &JsValue::from_str("value"),
            &JsValue::from_str(value),
        )
        .map_err(network_error)?;
        headers.push(&header);
    }

    let plan = Object::new();
    set(&plan, "id", &JsValue::from_f64(f64::from(id)))?;
    set(&plan, "url", &JsValue::from_str(&parts.uri.to_string()))?;
    set(&plan, "method", &JsValue::from_str(parts.method.as_str()))?;
    set(&plan, "headers", &headers)?;
    set(&plan, "body", &Uint8Array::from(body.as_ref()))?;
    Ok(plan.into())
}

fn set(object: &Object, key: &str, value: &JsValue) -> Result<(), HttpError> {
    Reflect::set(object, &JsValue::from_str(key), value)
        .map(|_| ())
        .map_err(network_error)
}

fn duration_millis(duration: Duration) -> u32 {
    u32::try_from(duration.as_millis()).unwrap_or(u32::MAX)
}

fn network_error(error: JsValue) -> HttpError {
    HttpError::Network(anyhow::anyhow!(js_error_message(error)))
}

fn send_error(error: SendWithRetryError) -> JsValue {
    JsValue::from_str(&format!("failed to send data-pipeline export: {error}"))
}

fn js_error_message(value: JsValue) -> String {
    Reflect::get(&value, &JsValue::from_str("message"))
        .ok()
        .and_then(|message| message.as_string())
        .or_else(|| value.as_string())
        .unwrap_or_else(|| "JavaScript transport error".to_string())
}

fn required_string(value: &JsValue, key: &str) -> Result<String, JsValue> {
    optional_string(value, key)?
        .ok_or_else(|| JsValue::from_str(&format!("{key} must be a string")))
}

fn optional_string(value: &JsValue, key: &str) -> Result<Option<String>, JsValue> {
    let value = Reflect::get(value, &JsValue::from_str(key))?;
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    value
        .as_string()
        .ok_or_else(|| JsValue::from_str(&format!("{key} must be a string")))
        .map(Some)
}

fn optional_number(value: &JsValue, key: &str) -> Result<Option<u32>, JsValue> {
    let value = Reflect::get(value, &JsValue::from_str(key))?;
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    let number = value
        .as_f64()
        .filter(|number| {
            number.is_finite()
                && *number >= 0.0
                && *number <= f64::from(u32::MAX)
                && number.fract() == 0.0
        })
        .ok_or_else(|| JsValue::from_str(&format!("{key} must be an unsigned integer")))?;
    Ok(Some(u32::try_from(number as u64).map_err(|_| {
        JsValue::from_str(&format!("{key} must be an unsigned integer"))
    })?))
}

fn required_number(value: &JsValue, key: &str) -> Result<u32, HttpError> {
    let number = Reflect::get(value, &JsValue::from_str(key))
        .map_err(network_error)?
        .as_f64()
        .filter(|number| {
            number.is_finite()
                && *number >= 0.0
                && *number <= f64::from(u32::MAX)
                && number.fract() == 0.0
        })
        .ok_or_else(|| HttpError::InvalidRequest(anyhow::anyhow!("{key} must be an integer")))?;
    Ok(number as u32)
}
