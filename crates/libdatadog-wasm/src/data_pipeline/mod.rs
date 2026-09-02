use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::rc::Rc;
use std::time::Duration;

use bytes::Bytes;
use futures::channel::oneshot;
use futures::future::{AbortHandle, Abortable};
use js_sys::{Array, Function, Object, Reflect, Uint8Array};
use libdatadog_data_pipeline::{
    send_agentless_v04, AgentlessTraceConfig, ObfuscationConfig, SendAgentlessV04Error,
    TracerMetadata, DEFAULT_AGENTLESS_TIMEOUT,
};
use libdd_capabilities::{HttpClientCapability, HttpError, SleepCapability};
use libdd_common::regex_engine::{Regex, Replacer};
use libdd_trace_obfuscation::json::JsonObfuscator;
use libdd_trace_obfuscation::obfuscation_config::{
    CreditCardConfig, HttpConfig, JsonObfuscatorConfig, MemcachedConfig, RedisConfig,
};
use libdd_trace_obfuscation::replacer::ReplaceRule;
use libdd_trace_obfuscation::sql::{SqlObfuscateConfig, SqlObfuscationMode};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

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
    obfuscation_config: ObfuscationConfig,
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
        let (sender, receiver) = oneshot::channel();
        let complete = Closure::once(move |error: JsValue, response: JsValue| {
            let result = if error.is_undefined() {
                Ok(response)
            } else {
                Err(error)
            };
            let _ = sender.send(result);
        });
        let mut guard = CancelGuard::new(id, self.cancel_request.clone());
        self.request
            .call2(&JsValue::UNDEFINED, &plan, complete.as_ref())
            .map_err(network_error)?;
        let response = receiver
            .await
            .map_err(|_| callback_dropped("request"))?
            .map_err(network_error)?;
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
        let (sender, receiver) = oneshot::channel();
        let complete = Closure::once(move || {
            let _ = sender.send(());
        });
        let mut guard = CancelGuard::new(id, self.cancel_sleep.clone());
        if self
            .sleep
            .call3(
                &JsValue::UNDEFINED,
                &JsValue::from_f64(f64::from(id)),
                &JsValue::from_f64(f64::from(milliseconds)),
                complete.as_ref(),
            )
            .is_ok()
        {
            let _ = receiver.await;
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
    metadata: Rc<TracerMetadata>,
    config: Rc<AgentlessTraceConfig>,
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
            obfuscation_config: optional_obfuscation_config(&value, "obfuscation")?,
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
            obfuscation_config: options.obfuscation_config,
        };
        let capabilities = HostCapabilities {
            request,
            cancel_request,
            sleep,
            cancel_sleep,
            next_call_id: Rc::new(Cell::new(1)),
        };

        Ok(Self {
            metadata: Rc::new(metadata),
            config: Rc::new(config),
            capabilities,
            in_flight: Rc::new(RefCell::new(HashMap::new())),
            next_operation_id: Cell::new(1),
        })
    }

    #[wasm_bindgen(js_name = sendV04)]
    pub fn send_v04(&self, payload: Vec<u8>, done: Function) {
        let operation_id = self.next_operation_id.get();
        self.next_operation_id.set(operation_id.wrapping_add(1));
        let (abort, registration) = AbortHandle::new_pair();
        self.in_flight.borrow_mut().insert(operation_id, abort);
        let capabilities = self.capabilities.clone();
        let config = self.config.clone();
        let in_flight = self.in_flight.clone();
        let metadata = self.metadata.clone();
        spawn_local(async move {
            let _guard = OperationGuard {
                id: operation_id,
                in_flight,
            };
            let send = send_agentless_v04(&capabilities, &payload, &metadata, &config, false);
            let error = match Abortable::new(send, registration).await {
                Ok(Ok(_)) => JsValue::UNDEFINED,
                Ok(Err(error)) => send_error(error),
                Err(_) => JsValue::from_str("data-pipeline export was cancelled"),
            };
            let _ = done.call1(&JsValue::UNDEFINED, &error);
        });
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

fn callback_dropped(name: &str) -> HttpError {
    HttpError::Network(anyhow::anyhow!("JavaScript {name} callback was dropped"))
}

fn send_error(error: SendAgentlessV04Error) -> JsValue {
    JsValue::from_str(&error.to_string())
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

fn optional_obfuscation_config(value: &JsValue, key: &str) -> Result<ObfuscationConfig, JsValue> {
    let value = Reflect::get(value, &JsValue::from_str(key))?;
    if value.is_null() || value.is_undefined() {
        return Ok(ObfuscationConfig::default());
    }
    Ok(ObfuscationConfig {
        tag_replace_rules: optional_replace_rules(&value, "tag_replace_rules")?,
        http: optional_http_config(&value, "http")?,
        memcached: optional_memcached_config(&value, "memcached")?,
        redis: optional_redis_config(&value, "redis")?,
        valkey: optional_redis_config(&value, "valkey")?,
        credit_cards: optional_credit_card_config(&value, "credit_cards")?,
        sql: optional_sql_config(&value, "sql")?,
        elasticsearch: optional_json_obfuscator(&value, "elasticsearch")?,
        opensearch: optional_json_obfuscator(&value, "opensearch")?,
        mongodb: optional_json_obfuscator(&value, "mongodb")?,
    })
}

fn field_bool(object: &JsValue, key: &str, default: bool) -> Result<bool, JsValue> {
    let value = Reflect::get(object, &JsValue::from_str(key))?;
    if value.is_null() || value.is_undefined() {
        return Ok(default);
    }
    value
        .as_bool()
        .ok_or_else(|| JsValue::from_str(&format!("{key} must be a boolean")))
}

fn field_string_set(object: &JsValue, key: &str) -> Result<HashSet<String>, JsValue> {
    let value = Reflect::get(object, &JsValue::from_str(key))?;
    if value.is_null() || value.is_undefined() {
        return Ok(HashSet::new());
    }
    if !Array::is_array(&value) {
        return Err(JsValue::from_str(&format!(
            "{key} must be an array of strings"
        )));
    }
    let array = Array::from(&value);
    let mut set = HashSet::with_capacity(array.length() as usize);
    for item in array.iter() {
        let item = item
            .as_string()
            .ok_or_else(|| JsValue::from_str(&format!("{key} must be an array of strings")))?;
        set.insert(item);
    }
    Ok(set)
}

fn optional_http_config(object: &JsValue, key: &str) -> Result<HttpConfig, JsValue> {
    let value = Reflect::get(object, &JsValue::from_str(key))?;
    if value.is_null() || value.is_undefined() {
        return Ok(HttpConfig::default());
    }
    Ok(HttpConfig {
        remove_query_string: field_bool(&value, "remove_query_string", false)?,
        remove_paths_with_digits: field_bool(&value, "remove_paths_with_digits", false)?,
    })
}

fn optional_memcached_config(object: &JsValue, key: &str) -> Result<MemcachedConfig, JsValue> {
    let default = MemcachedConfig::default();
    let value = Reflect::get(object, &JsValue::from_str(key))?;
    if value.is_null() || value.is_undefined() {
        return Ok(default);
    }
    Ok(MemcachedConfig {
        enabled: field_bool(&value, "enabled", default.enabled)?,
        keep_command: field_bool(&value, "keep_command", default.keep_command)?,
    })
}

fn optional_redis_config(object: &JsValue, key: &str) -> Result<RedisConfig, JsValue> {
    let default = RedisConfig::default();
    let value = Reflect::get(object, &JsValue::from_str(key))?;
    if value.is_null() || value.is_undefined() {
        return Ok(default);
    }
    Ok(RedisConfig {
        enabled: field_bool(&value, "enabled", default.enabled)?,
        remove_all_args: field_bool(&value, "remove_all_args", default.remove_all_args)?,
    })
}

fn optional_credit_card_config(object: &JsValue, key: &str) -> Result<CreditCardConfig, JsValue> {
    let default = CreditCardConfig::default();
    let value = Reflect::get(object, &JsValue::from_str(key))?;
    if value.is_null() || value.is_undefined() {
        return Ok(default);
    }
    Ok(CreditCardConfig {
        enabled: field_bool(&value, "enabled", default.enabled)?,
        luhn: field_bool(&value, "luhn", default.luhn)?,
        keep_values: field_string_set(&value, "keep_values")?,
    })
}

#[allow(deprecated)]
fn field_sql_obfuscation_mode(object: &JsValue, key: &str) -> Result<SqlObfuscationMode, JsValue> {
    let value = Reflect::get(object, &JsValue::from_str(key))?;
    if value.is_null() || value.is_undefined() {
        return Ok(SqlObfuscationMode::default());
    }
    let mode = value
        .as_string()
        .ok_or_else(|| JsValue::from_str(&format!("{key} must be a string")))?;
    match mode.as_str() {
        "unspecified" | "" => Ok(SqlObfuscationMode::Unspecified),
        "normalize_only" => Ok(SqlObfuscationMode::NormalizeOnly),
        "obfuscate_only" => Ok(SqlObfuscationMode::ObfuscateOnly),
        "obfuscate_and_normalize" => Ok(SqlObfuscationMode::ObfuscateAndNormalize),
        _ => Err(JsValue::from_str(&format!(
            "{key} must be one of: unspecified, normalize_only, obfuscate_only, obfuscate_and_normalize"
        ))),
    }
}

fn optional_sql_config(object: &JsValue, key: &str) -> Result<SqlObfuscateConfig, JsValue> {
    let value = Reflect::get(object, &JsValue::from_str(key))?;
    if value.is_null() || value.is_undefined() {
        return Ok(SqlObfuscateConfig::default());
    }
    Ok(SqlObfuscateConfig {
        replace_digits: field_bool(&value, "replace_digits", false)?,
        keep_sql_alias: field_bool(&value, "keep_sql_alias", false)?,
        dollar_quoted_func: field_bool(&value, "dollar_quoted_func", false)?,
        keep_null: field_bool(&value, "keep_null", false)?,
        keep_boolean: field_bool(&value, "keep_boolean", false)?,
        keep_positional_parameter: field_bool(&value, "keep_positional_parameter", false)?,
        keep_trailing_semicolon: field_bool(&value, "keep_trailing_semicolon", false)?,
        keep_identifier_quotation: field_bool(&value, "keep_identifier_quotation", false)?,
        replace_bind_parameter: field_bool(&value, "replace_bind_parameter", false)?,
        remove_space_between_parentheses: field_bool(
            &value,
            "remove_space_between_parentheses",
            false,
        )?,
        keep_json_path: field_bool(&value, "keep_json_path", false)?,
        obfuscation_mode: field_sql_obfuscation_mode(&value, "obfuscation_mode")?,
    })
}

fn optional_json_obfuscator(object: &JsValue, key: &str) -> Result<JsonObfuscator, JsValue> {
    let value = Reflect::get(object, &JsValue::from_str(key))?;
    if value.is_null() || value.is_undefined() {
        return Ok(JsonObfuscator::new(JsonObfuscatorConfig::default()));
    }
    Ok(JsonObfuscator::new(JsonObfuscatorConfig {
        enabled: field_bool(&value, "enabled", true)?,
        keep_keys: field_string_set(&value, "keep_keys")?,
        ..JsonObfuscatorConfig::default()
    }))
}

fn optional_replace_rules(
    object: &JsValue,
    key: &str,
) -> Result<Option<Vec<ReplaceRule>>, JsValue> {
    let value = Reflect::get(object, &JsValue::from_str(key))?;
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    if !Array::is_array(&value) {
        return Err(JsValue::from_str(&format!("{key} must be an array")));
    }
    let array = Array::from(&value);
    let mut rules = Vec::with_capacity(array.length() as usize);
    for item in array.iter() {
        rules.push(replace_rule(&item)?);
    }
    Ok(Some(rules))
}

fn replace_rule(value: &JsValue) -> Result<ReplaceRule, JsValue> {
    let name = required_string(value, "name")?;
    let pattern = required_string(value, "pattern")?;
    let repl = required_string(value, "repl")?;
    let re = Regex::new(&pattern)
        .map_err(|error| JsValue::from_str(&format!("pattern is invalid: {error}")))?;
    let no_expansion = Replacer::no_expansion(&mut repl.as_str()).is_some();
    Ok(ReplaceRule {
        name,
        re,
        repl,
        no_expansion,
    })
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
