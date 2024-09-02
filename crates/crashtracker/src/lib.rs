use napi::{Env, JsUnknown};
use napi_derive::napi;

#[napi]
pub fn init_with_receiver(env: Env, config: JsUnknown, receiver_config: JsUnknown, metadata: JsUnknown) -> napi::Result<()> {
    let config = env.from_js_value(config)?;
    let receiver_config = env.from_js_value(receiver_config)?;
    let metadata = env.from_js_value(metadata)?;

    datadog_crashtracker::init_with_receiver(config, receiver_config, metadata).unwrap();

    Ok(())
}

#[napi]
pub fn update_config (env: Env, config: JsUnknown) -> napi::Result<()> {
    let config = env.from_js_value(config)?;

    let _ = datadog_crashtracker::update_config(config);

    Ok(())
}

#[napi]
pub fn update_metadata (env: Env, metadata: JsUnknown) -> napi::Result<()> {
    let metadata = env.from_js_value(metadata)?;

    let _ = datadog_crashtracker::update_metadata(metadata);

    Ok(())
}
