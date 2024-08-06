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

    let uri = Uri::from_static("http://localhost:8126");
    let endpoint = Endpoint::from_url(uri);
    let resolve_frames = crashtracker::StacktraceCollection::Disabled;
    let wait_for_receiver = false;
    let config = CrashtrackerConfiguration::new(vec![], false, Some(endpoint), resolve_frames, wait_for_receiver).unwrap();

    let path_to_receiver_library = "/tmp/foo".to_string();
    let receiver_config = crashtracker::CrashtrackerReceiverConfig::new(vec![], vec![], path_to_receiver_library, None, None).unwrap();

    let library_name = "dd-trace-js".to_string();
    let library_version = "0.0.0".to_string();
    let metadata = crashtracker::CrashtrackerMetadata::new(library_name, library_version, "nodejs".to_string(), vec![]);

    crashtracker::init_with_receiver(config, receiver_config, metadata).unwrap();

    Ok(cx.undefined())
}
