use ddcommon::Endpoint;
use hyper::Uri;
use neon::prelude::*;
use datadog_crashtracker as crashtracker;
use datadog_crashtracker::*;

pub fn register (cx: &mut ModuleContext) -> NeonResult<()> {
    cx.export_function("start", start)?;

    Ok(())
}

pub fn start (mut cx: FunctionContext) -> JsResult<JsUndefined> {
    // TODO: get actual config from cx

    let additional_files = vec![];
    let create_alt_stack = false;
    let uri = Uri::from_static("http://localhost:8126");
    let endpoint = Some(Endpoint::from_url(uri));
    let resolve_frames = StacktraceCollection::Disabled;
    let wait_for_receiver = false;
    let config = CrashtrackerConfiguration::new(
        additional_files,
        create_alt_stack,
        endpoint,
        resolve_frames,
        wait_for_receiver,
    ).unwrap();

    let args = vec![];
    let env = vec![];
    let path_to_receiver_library = "/tmp/foo".to_string();
    let stderr_filename = None;
    let stdout_filename = None;
    let receiver_config = CrashtrackerReceiverConfig::new(
        args,
        env,
        path_to_receiver_library,
        stderr_filename,
        stdout_filename,
    ).unwrap();

    let library_name = "dd-trace-js".to_string();
    let library_version = "0.0.0".to_string();
    let family = "nodejs".to_string();
    let tags = vec![];
    let metadata = CrashtrackerMetadata::new(library_name, library_version, family, tags);

    init_with_receiver(config, receiver_config, metadata).unwrap();

    Ok(cx.undefined())
}
