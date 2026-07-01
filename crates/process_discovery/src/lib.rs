use napi::{Error, Status};
use napi_derive::napi;

use libdd_library_config::tracer_metadata;
use libdd_trace_protobuf::opentelemetry::proto::common::v1::any_value;

#[napi]
pub struct NapiAnonymousFileHandle {
    _internal: tracer_metadata::AnonymousFileHandle,
}

#[napi]
impl NapiAnonymousFileHandle {}

/// Additional OTel process-context attribute the threadlocal writer wants to
/// publish alongside the key map (e.g. language-runtime layout constants). Set
/// exactly one of `string_value` / `int_value` — the other variants of OTel's
/// `AnyValue` (bool, double, bytes, array, kvlist) are not yet exposed.
/// Passing both set or neither set is rejected as invalid input.
#[derive(Clone)]
#[napi(object)]
pub struct ExtraAttribute {
    pub key: String,
    pub string_value: Option<String>,
    pub int_value: Option<i64>,
}

/// Thread-level context metadata the tracer wants to publish as part of the
/// OTel process context. When present on a [`TracerMetadata`], drives the
/// `threadlocal.*` block in the emitted process context; when absent, no such
/// block is emitted.
#[derive(Clone)]
#[napi(object)]
pub struct ThreadLocalMetadata {
    /// Ordered list of attribute key names for thread-level OTEP-4947 context
    /// records. Wire key indices index into this list. libdatadog implicitly
    /// prepends `datadog.local_root_span_id` at wire index 0, so entry 0 here
    /// is wire key index 1.
    pub attribute_keys: Vec<String>,

    /// Value of the `threadlocal.schema_version` attribute. Identifies the
    /// on-the-wire record schema (e.g. `"tlsdesc_v1_dev"` for libdatadog's own
    /// TLSDESC writer, `"nodejs_v1_dev"` for a Node.js writer). Defaults to
    /// `"tlsdesc_v1_dev"` when omitted.
    pub schema_version: Option<String>,

    /// Extra `threadlocal.*` attributes to publish alongside the key map (e.g.
    /// V8 layout constants a Node.js reader needs to walk from the discovery
    /// TLS symbol into the record).
    pub extra_attributes: Vec<ExtraAttribute>,
}

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
    /// Optional thread-level context metadata; see [`ThreadLocalMetadata`].
    /// `null`/omitted (the default) disables the `threadlocal.*` block in the
    /// emitted OTel process context entirely.
    pub threadlocal_metadata: Option<ThreadLocalMetadata>,
}

fn convert_extra_attribute(ea: &ExtraAttribute) -> napi::Result<(String, any_value::Value)> {
    let value = match (&ea.string_value, ea.int_value) {
        (Some(s), None) => any_value::Value::StringValue(s.clone()),
        (None, Some(i)) => any_value::Value::IntValue(i),
        (Some(_), Some(_)) => {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "ExtraAttribute {:?}: exactly one of stringValue / intValue must be set, both are",
                    ea.key,
                ),
            ));
        }
        (None, None) => {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "ExtraAttribute {:?}: exactly one of stringValue / intValue must be set, neither is",
                    ea.key,
                ),
            ));
        }
    };
    Ok((ea.key.clone(), value))
}

fn convert_threadlocal_metadata(
    tlm: &ThreadLocalMetadata,
) -> napi::Result<tracer_metadata::ThreadLocalMetadata> {
    Ok(tracer_metadata::ThreadLocalMetadata {
        attribute_keys: tlm.attribute_keys.clone(),
        schema_version: tlm.schema_version.clone(),
        extra_attributes: tlm
            .extra_attributes
            .iter()
            .map(convert_extra_attribute)
            .collect::<napi::Result<_>>()?,
    })
}

#[napi]
pub fn store_metadata(data: &TracerMetadata) -> napi::Result<NapiAnonymousFileHandle> {
    let res = tracer_metadata::store_tracer_metadata(&tracer_metadata::TracerMetadata{
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
        threadlocal_metadata: data
            .threadlocal_metadata
            .as_ref()
            .map(convert_threadlocal_metadata)
            .transpose()?,
    });

    match res {
        Ok(handle) => Ok(NapiAnonymousFileHandle{ _internal: handle }),
        Err(e) => {
            let err_msg = format!("Failed to store the tracer configuration: {:?}", e);
            Err(Error::new(Status::GenericFailure, err_msg))
        }
    }
}
