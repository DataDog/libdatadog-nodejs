use std::str::FromStr;
use std::sync::Arc;

use libdd_capabilities::{HttpClientCapability, SleepCapability};
use libdd_remote_config::fetch::{
    AgentlessConfig, ConfigApplyState, ConfigInvariants, ConfigOptions, SingleChangesFetcher,
};
use libdd_remote_config::file_change_tracker::{Change, FilePath};
use libdd_remote_config::file_storage::{RawFile, SimpleFileStorage};
use libdd_remote_config::{
    RemoteConfigCapabilities, RemoteConfigPath, RemoteConfigProduct, Target,
};

type Fetcher<C> = SingleChangesFetcher<SimpleFileStorage, C>;

pub struct RemoteConfigOptions {
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
    pub timeout_ms: u64,
    pub api_key: String,
    pub hostname: String,
}

pub struct ChangeRecord {
    pub kind: &'static str,
    pub path: String,
    pub product: String,
    pub config_id: String,
    pub name: String,
    pub version: f64,
    pub contents: Option<String>,
}

#[derive(Default)]
pub struct PendingUpdates {
    product_capabilities: Option<(Vec<RemoteConfigProduct>, Vec<RemoteConfigCapabilities>)>,
    extra_services: Option<Vec<String>>,
    config_states: Vec<(RemoteConfigPath, ConfigApplyState)>,
}

impl PendingUpdates {
    pub fn set_config_state(
        &mut self,
        path: &str,
        apply_state: u32,
        apply_error: Option<String>,
    ) -> Result<(), String> {
        let state = match apply_state {
            1 => ConfigApplyState::Unacknowledged,
            2 => ConfigApplyState::Acknowledged,
            3 => ConfigApplyState::Error(apply_error.unwrap_or_default()),
            other => return Err(format!("Unknown apply state {other}")),
        };
        let path = RemoteConfigPath::try_parse(path).map_err(|error| error.to_string())?;
        self.config_states.push((path.into(), state));
        Ok(())
    }

    pub fn set_extra_services(&mut self, services: Vec<String>) {
        self.extra_services = Some(services);
    }

    pub fn set_product_capabilities(
        &mut self,
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

        self.product_capabilities = Some((products, capabilities));
        unknown
    }
}

struct FetcherConfig<C> {
    target: Target,
    runtime_id: String,
    client_id: String,
    invariants: ConfigInvariants,
    capabilities: C,
}

impl<C> FetcherConfig<C>
where
    C: HttpClientCapability + SleepCapability,
{
    async fn build(&self) -> anyhow::Result<Fetcher<C>> {
        Ok(SingleChangesFetcher::new(
            SimpleFileStorage::default(),
            self.target.clone(),
            self.runtime_id.clone(),
            ConfigOptions {
                invariants: self.invariants.clone(),
                products: vec![],
                capabilities: vec![],
            },
            self.capabilities.clone(),
        )
        .await?
        .with_client_id(self.client_id.clone()))
    }
}

pub struct RemoteConfigClient<C>
where
    C: HttpClientCapability + SleepCapability,
{
    config: FetcherConfig<C>,
    fetcher: Option<Fetcher<C>>,
}

impl<C> RemoteConfigClient<C>
where
    C: HttpClientCapability + SleepCapability,
{
    pub fn new(options: RemoteConfigOptions, capabilities: C) -> Result<Self, String> {
        let url = libdd_common::parse_uri(&options.url).map_err(|error| error.to_string())?;
        if url.scheme().is_none() || url.authority().is_none() {
            return Err(format!(
                "Remote config agent URL needs both a scheme and a host: {}",
                options.url
            ));
        }

        let endpoint = libdd_common::Endpoint {
            url,
            timeout_ms: options.timeout_ms,
            api_key: Some(options.api_key.into()),
            ..Default::default()
        };
        let agentless =
            AgentlessConfig::new(options.hostname, &endpoint).map_err(|error| error.to_string())?;

        Ok(Self {
            config: FetcherConfig {
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
                    agentless: Some(agentless),
                },
                capabilities,
            },
            fetcher: None,
        })
    }

    pub async fn fetch_changes(
        &mut self,
        updates: PendingUpdates,
    ) -> anyhow::Result<Vec<ChangeRecord>> {
        if self.fetcher.is_none() {
            self.fetcher = Some(self.config.build().await?);
        }
        let fetcher = self.fetcher.as_mut().expect("fetcher was initialized");

        if let Some((products, capabilities)) = updates.product_capabilities {
            fetcher.set_product_capabilities(products, capabilities);
        }
        if let Some(services) = updates.extra_services {
            fetcher.set_extra_services(services);
        }
        for (path, state) in updates.config_states {
            fetcher.fetcher.set_config_state(&path, state);
        }

        Ok(fetcher
            .fetch_changes::<Vec<u8>>()
            .await?
            .into_iter()
            .map(to_change_record)
            .collect())
    }
}

fn parse_capability(name: &str) -> Option<RemoteConfigCapabilities> {
    serde_json::from_value(serde_json::Value::String(name.to_string())).ok()
}

fn to_change_record(change: Change<Arc<RawFile<Vec<u8>>>, Vec<u8>>) -> ChangeRecord {
    match change {
        Change::Add(file) => to_record("add", &file, contents(&file)),
        Change::Update(file, _) => to_record("update", &file, contents(&file)),
        Change::Remove(file) => to_record("remove", &file, None),
    }
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
        version: file.version() as f64,
        contents,
    }
}

fn contents(file: &Arc<RawFile<Vec<u8>>>) -> Option<String> {
    Some(String::from_utf8_lossy(file.contents().as_slice()).into_owned())
}
