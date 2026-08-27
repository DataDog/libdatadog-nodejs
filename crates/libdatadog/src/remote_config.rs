use std::sync::{Arc, Mutex, MutexGuard};

use futures::lock::Mutex as AsyncMutex;
use libdatadog_remote_config::{
    ChangeRecord, PendingUpdates, RemoteConfigClient, RemoteConfigOptions,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::data_pipeline::{AgentlessRequest, AgentlessResponse, HostCapabilities};

#[napi(object)]
pub struct RemoteConfigFetcherOptions {
    pub client_id: String,
    pub runtime_id: String,
    pub service: String,
    pub env: String,
    pub app_version: String,
    pub tags: Vec<String>,
    pub process_tags: Vec<String>,
    pub language: String,
    pub tracer_version: String,
    pub url: String,
    pub timeout_ms: u32,
    pub api_key: String,
    pub hostname: String,
}

impl From<RemoteConfigFetcherOptions> for RemoteConfigOptions {
    fn from(options: RemoteConfigFetcherOptions) -> Self {
        Self {
            client_id: options.client_id,
            runtime_id: options.runtime_id,
            service: options.service,
            env: options.env,
            app_version: options.app_version,
            tags: options.tags,
            process_tags: options.process_tags,
            language: options.language,
            tracer_version: options.tracer_version,
            url: options.url,
            timeout_ms: u64::from(options.timeout_ms),
            api_key: options.api_key,
            hostname: options.hostname,
        }
    }
}

#[napi(object)]
pub struct RemoteConfigChange {
    pub kind: String,
    pub path: String,
    pub product: String,
    pub config_id: String,
    pub name: String,
    pub version: f64,
    pub contents: Option<String>,
}

impl From<ChangeRecord> for RemoteConfigChange {
    fn from(change: ChangeRecord) -> Self {
        Self {
            kind: change.kind.to_string(),
            path: change.path,
            product: change.product,
            config_id: change.config_id,
            name: change.name,
            version: change.version,
            contents: change.contents,
        }
    }
}

#[napi]
pub struct RemoteConfigFetcher {
    client: Arc<AsyncMutex<RemoteConfigClient<HostCapabilities>>>,
    pending: Arc<Mutex<PendingUpdates>>,
}

#[napi]
impl RemoteConfigFetcher {
    #[napi(constructor)]
    pub fn new(
        options: RemoteConfigFetcherOptions,
        request: Function<'_, AgentlessRequest, Promise<AgentlessResponse>>,
        cancel_request: Function<'_, u32, ()>,
        sleep: Function<'_, FnArgs<(u32, u32)>, Promise<()>>,
        cancel_sleep: Function<'_, u32, ()>,
    ) -> Result<Self> {
        let capabilities = HostCapabilities::new(request, cancel_request, sleep, cancel_sleep)?;
        let client =
            RemoteConfigClient::new(options.into(), capabilities).map_err(Error::from_reason)?;

        Ok(Self {
            client: Arc::new(AsyncMutex::new(client)),
            pending: Arc::new(Mutex::new(PendingUpdates::default())),
        })
    }

    #[napi]
    pub async fn fetch_changes(&self) -> Result<Vec<RemoteConfigChange>> {
        let updates = std::mem::take(&mut *lock(&self.pending));
        let mut client = self.client.lock().await;
        client
            .fetch_changes(updates)
            .await
            .map(|changes| changes.into_iter().map(Into::into).collect())
            .map_err(|error| Error::from_reason(error.to_string()))
    }

    #[napi]
    pub fn set_config_state(
        &self,
        path: String,
        apply_state: u32,
        apply_error: Option<String>,
    ) -> Result<()> {
        lock(&self.pending)
            .set_config_state(&path, apply_state, apply_error)
            .map_err(Error::from_reason)
    }

    #[napi]
    pub fn set_extra_services(&self, services: Vec<String>) {
        lock(&self.pending).set_extra_services(services);
    }

    #[napi]
    pub fn set_product_capabilities(
        &self,
        products: Vec<String>,
        capabilities: Vec<String>,
    ) -> Vec<String> {
        lock(&self.pending).set_product_capabilities(products, capabilities)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}
