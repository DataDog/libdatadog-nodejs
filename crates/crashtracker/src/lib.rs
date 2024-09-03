use datadog_crashtracker::CrashtrackerReceiverConfig;
use napi::{Env, JsUnknown};
use napi_derive::napi;
use std::{env::temp_dir, fs, path::{self}};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

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
    let parts: Vec<_> = receiver_config.path_to_receiver_binary.rsplit(path::MAIN_SEPARATOR).collect();
    let mut dest = temp_dir();
    dest.push(parts[0]);

    std::fs::copy(&receiver_config.path_to_receiver_binary, &dest).expect("failed to copy");

    let mut perms = fs::metadata(&dest)?.permissions();

    #[cfg(unix)]
    perms.set_mode(0o777);

    fs::set_permissions(&dest, perms)?;

    receiver_config.path_to_receiver_binary = dest.to_string_lossy().to_string();

    Ok(())
}
