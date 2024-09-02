use datadog_crashtracker::CrashtrackerReceiverConfig;
use napi::{Env, JsUnknown};
use napi_derive::napi;
use std::{env::temp_dir, fs, path::{self, Path}};

#[napi]
pub fn init_with_receiver(env: Env, config: JsUnknown, receiver_config: JsUnknown, metadata: JsUnknown) -> napi::Result<()> {
    let config = env.from_js_value(config)?;
    let mut receiver_config = env.from_js_value(receiver_config)?;
    let metadata = env.from_js_value(metadata)?;

    copy_receiver(&mut receiver_config).unwrap();

    datadog_crashtracker::init_with_receiver(config, receiver_config, metadata).unwrap();

    Ok(())
}

#[napi]
pub fn update_config (env: Env, config: JsUnknown) -> napi::Result<()> {
    let config = env.from_js_value(config)?;

    datadog_crashtracker::update_config(config).unwrap();

    Ok(())
}

#[napi]
pub fn update_metadata (env: Env, metadata: JsUnknown) -> napi::Result<()> {
    let metadata = env.from_js_value(metadata)?;

    datadog_crashtracker::update_metadata(metadata).unwrap();

    Ok(())
}

pub fn copy_receiver (receiver_config: &mut CrashtrackerReceiverConfig) -> Result<(), anyhow::Error> {
    let temp = temp_dir();
    let parts: Vec<_> = receiver_config.path_to_receiver_binary.rsplit(path::MAIN_SEPARATOR).collect();
    let file = parts[0];
    let dest = Path::join(temp.as_path(), file);
    let path_to_receiver_binary = dest.clone().to_string_lossy().to_string();

    std::fs::copy(receiver_config.path_to_receiver_binary.clone(), dest.clone())?;

    let mut perms = fs::metadata(dest.clone())?.permissions();

    perms.set_readonly(false);

    fs::set_permissions(dest.clone(), perms)?;

    receiver_config.path_to_receiver_binary = path_to_receiver_binary;

    Ok(())
}
