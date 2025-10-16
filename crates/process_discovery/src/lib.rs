use napi::{Error, Status};
use napi_derive::napi;

use datadog_library_config::tracer_metadata;

#[napi]
pub struct NapiAnonymousFileHandle {
    _internal: tracer_metadata::AnonymousFileHandle,
}

#[napi]
impl NapiAnonymousFileHandle {}

#[napi(constructor)]
pub struct TracerMetadata {
    pub runtime_id: Option<String>,
    pub tracer_version: String,
    pub hostname: String,
    pub service_name: Option<String>,
    pub service_env: Option<String>,
    pub service_version: Option<String>,
    pub process_tags: Option<String>,
    pub container_id: Option<String>,
}

#[napi]
pub fn store_metadata(data: &TracerMetadata) -> napi::Result<NapiAnonymousFileHandle> {
    let res = tracer_metadata::store_tracer_metadata(&tracer_metadata::TracerMetadata {
        schema_version: 1,
        runtime_id: data.runtime_id.clone(),
        tracer_language: String::from("nodejs"),
        tracer_version: data.tracer_version.clone(),
        hostname: data.hostname.clone(),
        service_name: data.service_name.clone(),
        service_env: data.service_env.clone(),
        service_version: data.service_version.clone(),
        process_tags: data.process_tags.clone(),
        container_id: data.container_id.clone(),
    });

    match res {
        Ok(handle) => Ok(NapiAnonymousFileHandle { _internal: handle }),
        Err(e) => {
            let err_msg = format!("Failed to store the tracer configuration: {:?}", e);
            Err(Error::new(Status::GenericFailure, err_msg))
        }
    }
}
