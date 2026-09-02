use napi::{Env, JsUnknown};
use napi_derive::napi;

mod unhandled_exception;

/// Ensures that if signals is empty, default signals are applied.
/// This is necessary because NAPI deserialization bypasses the
/// CrashtrackerConfiguration::new() constructor where the default
/// signals logic exists.
fn apply_default_signals(
    config: libdd_crashtracker::CrashtrackerConfiguration,
) -> libdd_crashtracker::CrashtrackerConfiguration {
    if config.signals().is_empty() {
        let mut value = serde_json::to_value(&config).unwrap();
        value["signals"] = serde_json::to_value(libdd_crashtracker::default_signals()).unwrap();
        serde_json::from_value(value).unwrap()
    } else {
        config
    }
}

#[napi]
pub fn init(
    env: Env,
    config: JsUnknown,
    receiver_config: JsUnknown,
    metadata: JsUnknown,
) -> napi::Result<()> {
    let config: libdd_crashtracker::CrashtrackerConfiguration = env.from_js_value(config)?;
    let receiver_config = env.from_js_value(receiver_config)?;
    let metadata = env.from_js_value(metadata)?;

    let config = apply_default_signals(config);

    libdd_crashtracker::init(config, receiver_config, metadata).unwrap();

    Ok(())
}

#[napi]
pub fn update_config(env: Env, config: JsUnknown) -> napi::Result<()> {
    let config: libdd_crashtracker::CrashtrackerConfiguration = env.from_js_value(config)?;

    let config = apply_default_signals(config);

    libdd_crashtracker::update_config(config).unwrap();

    Ok(())
}

#[napi]
pub fn update_metadata(env: Env, metadata: JsUnknown) -> napi::Result<()> {
    let metadata = env.from_js_value(metadata)?;

    libdd_crashtracker::update_metadata(metadata).unwrap();

    Ok(())
}

#[napi]
pub fn begin_profiler_serializing(_env: Env) -> napi::Result<()> {
    let _ = libdd_crashtracker::begin_op(libdd_crashtracker::OpTypes::ProfilerSerializing);

    Ok(())
}

#[napi]
pub fn end_profiler_serializing(_env: Env) -> napi::Result<()> {
    let _ = libdd_crashtracker::end_op(libdd_crashtracker::OpTypes::ProfilerSerializing);

    Ok(())
}
