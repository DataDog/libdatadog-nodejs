use datadog_crashtracker::*;
use napi::{Env, JsUnknown};
use napi_derive::napi;

#[napi]
pub fn start(env: Env, config: JsUnknown, receiver_config: JsUnknown, metadata: JsUnknown) -> napi::Result<()> {
    let config = env.from_js_value(config)?;
    let receiver_config = env.from_js_value(receiver_config)?;
    let metadata = env.from_js_value(metadata)?;

    init_with_receiver(config, receiver_config, metadata).unwrap();

    Ok(())
}
