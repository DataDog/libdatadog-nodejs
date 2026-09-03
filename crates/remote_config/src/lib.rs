//! Wasm binding for libdatadog's remote config client.

use std::cell::RefCell;
use std::rc::Rc;
use std::str::FromStr;
use std::sync::Arc;

use libdatadog_nodejs_capabilities::{HttpClientCapability, WasmCapabilities};
use libdd_remote_config::fetch::{
    AgentlessConfig, ConfigApplyState, ConfigInvariants, ConfigOptions, SingleChangesFetcher,
};
use libdd_remote_config::file_change_tracker::{Change, FilePath};
use libdd_remote_config::file_storage::{RawFile, SimpleFileStorage};
use libdd_remote_config::{
    RemoteConfigCapabilities, RemoteConfigPath, RemoteConfigProduct, Target,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn init() {
    console_error_panic_hook::set_once();
}

const APPLY_STATE_UNACKNOWLEDGED: u32 = 1;
const APPLY_STATE_ACKNOWLEDGED: u32 = 2;
const APPLY_STATE_ERROR: u32 = 3;

type Fetcher = SingleChangesFetcher<SimpleFileStorage, WasmCapabilities>;

/// A real `Error`, not a bare string: the JS side logs rejections with a logger that identifies a
/// cause by its `stack`, and the pure-JS fallback client rejects with `Error`s too.
fn to_js_err(err: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&err.to_string()).into()
}

/// Deserializing capabilities one name at a time keeps an unrecognized one from discarding
/// the whole set.
fn parse_capability(name: &str) -> Option<RemoteConfigCapabilities> {
    serde_json::from_value(serde_json::Value::String(name.to_string())).ok()
}

/// Options accepted by [`RemoteConfigFetcher::new`]. These populate the `Client`/`ClientTracer` of
/// the remote config request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetcherOptions {
    client_id: String,
    runtime_id: String,
    service: String,
    env: String,
    app_version: String,
    /// Already-formatted `"key:value"` strings.
    tags: Vec<String>,
    /// Already-formatted `"key:value"` strings.
    process_tags: Vec<String>,
    language: String,
    tracer_version: String,
    /// The Datadog site, e.g. `https://api.datadoghq.com`.
    url: String,
    timeout_ms: u64,
    api_key: String,
    hostname: String,
}

/// A single add/update/remove of one remote config file, as diffed against the previous poll.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangeRecord {
    /// One of `"add"`, `"update"`, `"remove"`.
    kind: &'static str,
    /// Full unparsed remote config path, e.g. `datadog/2/APM_TRACING/config-id/name` or
    /// `employee/APM_TRACING/config-id/name`. Pass this back to `setConfigState`.
    path: String,
    product: String,
    config_id: String,
    name: String,
    version: f64,
    /// The hash-verified file contents. Omitted for `"remove"`: the consumer already holds them from
    /// the `"add"`/`"update"` that introduced the config.
    #[serde(skip_serializing_if = "Option::is_none")]
    contents: Option<String>,
}

fn to_record(
    kind: &'static str,
    file: &Arc<RawFile<Vec<u8>>>,
    contents: Option<String>,
) -> ChangeRecord {
    let path = file.path();
    ChangeRecord {
        kind,
        path: path.to_string(),
        product: path.product().to_string(),
        config_id: path.config_id().to_string(),
        name: path.name().to_string(),
        // Read after `contents`: both lock the same mutex, which is not reentrant.
        version: file.version() as f64,
        contents,
    }
}

fn to_contents(file: &Arc<RawFile<Vec<u8>>>) -> Option<String> {
    // Lossy like `Buffer#toString('utf8')`: a config file that is not valid UTF-8 is not valid JSON
    // either, so the consumer rejects it either way.
    Some(String::from_utf8_lossy(file.contents().as_slice()).into_owned())
}

fn to_change_record(change: Change<Arc<RawFile<Vec<u8>>>, Vec<u8>>) -> ChangeRecord {
    match change {
        Change::Add(file) => to_record("add", &file, to_contents(&file)),
        Change::Update(file, _old_contents) => to_record("update", &file, to_contents(&file)),
        Change::Remove(file) => to_record("remove", &file, None),
    }
}

/// Mutations recorded by the setters while a poll may be in flight, applied at the start of the next
/// one. `fetchChanges` holds the fetcher borrow across its whole round trip, so the setters must not
/// take it -- they would find it already borrowed and have nowhere to put the update.
#[derive(Default)]
struct PendingUpdates {
    product_capabilities: Option<(Vec<RemoteConfigProduct>, Vec<RemoteConfigCapabilities>)>,
    extra_services: Option<Vec<String>>,
    config_states: Vec<(RemoteConfigPath, ConfigApplyState)>,
}

/// Everything needed to build the fetcher, kept around because building it is deferred.
struct FetcherConfig {
    target: Target,
    runtime_id: String,
    client_id: String,
    invariants: ConfigInvariants,
    agentless: AgentlessConfig,
}

impl FetcherConfig {
    async fn build(&self) -> Result<Fetcher, JsValue> {
        Ok(SingleChangesFetcher::new_agentless(
            SimpleFileStorage::default(),
            self.target.clone(),
            self.runtime_id.clone(),
            ConfigOptions {
                invariants: self.invariants.clone(),
                // Products and capabilities are only known once the subsystems that own them have
                // registered their handlers, which always happens before the first poll.
                products: vec![],
                capabilities: vec![],
            },
            self.agentless.clone(),
            WasmCapabilities::new_without_connection_pooling(),
        )
        .await
        .map_err(to_js_err)?
        .with_client_id(self.client_id.clone()))
    }
}

/// The fetcher is built on the first poll rather than in the constructor to be able to await..
struct FetcherState {
    config: FetcherConfig,
    fetcher: Option<Fetcher>,
}

#[wasm_bindgen]
pub struct RemoteConfigFetcher {
    state: Rc<RefCell<FetcherState>>,
    pending: Rc<RefCell<PendingUpdates>>,
}

#[wasm_bindgen]
impl RemoteConfigFetcher {
    #[wasm_bindgen(constructor)]
    pub fn new(options: JsValue) -> Result<RemoteConfigFetcher, JsValue> {
        let options: FetcherOptions = serde_wasm_bindgen::from_value(options).map_err(to_js_err)?;

        let url = libdd_common::parse_uri(&options.url).map_err(to_js_err)?;

        // Validate, otherwise libdatadog will panic here
        if url.scheme().is_none() || url.authority().is_none() {
            return Err(to_js_err(format!(
                "Remote config agent URL needs both a scheme and a host: {}",
                options.url
            )));
        }

        let endpoint = libdd_common::Endpoint {
            url,
            timeout_ms: options.timeout_ms,
            api_key: Some(options.api_key.into()),
            ..Default::default()
        };

        let agentless = AgentlessConfig::new(options.hostname, &endpoint).map_err(to_js_err)?;

        let config = FetcherConfig {
            target: Target::new(
                options.service,
                options.env,
                options.app_version,
                options.tags,
                options.process_tags,
            ),
            runtime_id: options.runtime_id,
            client_id: options.client_id,
            invariants: ConfigInvariants {
                language: options.language,
                tracer_version: options.tracer_version,
                endpoint,
                agentless: None,
            },
            agentless,
        };

        Ok(RemoteConfigFetcher {
            state: Rc::new(RefCell::new(FetcherState {
                config,
                fetcher: None,
            })),
            pending: Rc::new(RefCell::new(PendingUpdates::default())),
        })
    }

    /// Polls the agent once and resolves with the changes (add/update/remove) relative to the
    /// previous successful poll. An empty array means nothing changed.
    ///
    /// Holding the borrow across the await is deliberate: on wasm there is one thread, and the
    /// borrow is what serializes polls.
    #[allow(clippy::await_holding_refcell_ref)]
    #[wasm_bindgen(js_name = "fetchChanges")]
    pub async fn fetch_changes(&self) -> Result<JsValue, JsValue> {
        let cell = self.state.clone();
        let pending = self.pending.clone();

        // The scheduler above this only arms the next poll once the previous settled, so an
        // overlapping call is a guard, not a path.
        let mut state = cell
            .try_borrow_mut()
            .map_err(|_| to_js_err("A remote config poll is already in flight"))?;
        let state = &mut *state;

        let fetcher = match &mut state.fetcher {
            Some(fetcher) => fetcher,
            slot => slot.insert(state.config.build().await?),
        };

        let updates = std::mem::take(&mut *pending.borrow_mut());
        if let Some((products, capabilities)) = updates.product_capabilities {
            fetcher.set_product_capabilities(products, capabilities);
        }
        if let Some(services) = updates.extra_services {
            fetcher.set_extra_services(services);
        }
        for (path, state) in updates.config_states {
            fetcher.fetcher.set_config_state(&path, state);
        }

        let changes = fetcher
            .fetch_changes::<Vec<u8>>()
            .await
            .map_err(to_js_err)?;

        let records: Vec<ChangeRecord> = changes.into_iter().map(to_change_record).collect();

        serde_wasm_bindgen::to_value(&records).map_err(to_js_err)
    }

    /// Reports the apply outcome of a previously received change, identified by the `path` handed
    /// back by `fetchChanges`. `applyState` is one of `APPLY_STATE_*` constants.
    #[wasm_bindgen(js_name = "setConfigState")]
    pub fn set_config_state(
        &self,
        path: String,
        apply_state: u32,
        apply_error: Option<String>,
    ) -> Result<(), JsValue> {
        let state = match apply_state {
            APPLY_STATE_UNACKNOWLEDGED => ConfigApplyState::Unacknowledged,
            APPLY_STATE_ACKNOWLEDGED => ConfigApplyState::Acknowledged,
            APPLY_STATE_ERROR => ConfigApplyState::Error(apply_error.unwrap_or_default()),
            other => return Err(to_js_err(format!("Unknown apply state {other}"))),
        };
        let path = RemoteConfigPath::try_parse(&path).map_err(to_js_err)?;

        self.pending
            .borrow_mut()
            .config_states
            .push((path.into(), state));

        Ok(())
    }

    /// Replaces the set of extra services reported to the agent.
    #[wasm_bindgen(js_name = "setExtraServices")]
    pub fn set_extra_services(&self, services: Vec<String>) {
        self.pending.borrow_mut().extra_services = Some(services);
    }

    /// Replaces the set of subscribed products and capabilities.
    ///
    /// Names this build does not know are skipped and returned, so that a tracer whose own list has
    /// moved ahead of libdatadog's keeps working with the names that do resolve. Reporting them is
    /// left to the caller, which owns the logger.
    #[wasm_bindgen(js_name = "setProductCapabilities")]
    pub fn set_product_capabilities(
        &self,
        products: Vec<String>,
        capabilities: Vec<String>,
    ) -> Vec<String> {
        let mut unknown = vec![];

        let products = products
            .into_iter()
            .filter_map(|name| match RemoteConfigProduct::from_str(&name) {
                Ok(product) => Some(product),
                Err(_) => {
                    unknown.push(name);
                    None
                }
            })
            .collect();

        let capabilities = capabilities
            .into_iter()
            .filter_map(|name| match parse_capability(&name) {
                Some(capability) => Some(capability),
                None => {
                    unknown.push(name);
                    None
                }
            })
            .collect();

        self.pending.borrow_mut().product_capabilities = Some((products, capabilities));

        unknown
    }
}

/// Installs the host's async-context hook, so the HTTP request this module issues is not
/// re-instrumented by the tracer's own http plugin.
#[wasm_bindgen(js_name = "setStorage")]
pub fn set_storage(new_storage: &JsValue) {
    libdatadog_nodejs_capabilities::http::set_storage(new_storage);
}
