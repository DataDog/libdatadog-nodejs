use neon::prelude::*;
use datadog_crashtracker::*;

pub fn register (cx: &mut ModuleContext) -> NeonResult<()> {
    let exports = cx.exports_object()?;
    let start_fn = JsFunction::new(cx, start)?;

    exports.set(cx, "start", start_fn)?;

    cx.export_value("crashtracker", exports)?;

    Ok(())
}

pub fn start (mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let config = parse(cx.argument::<JsString>(0)?.value(&mut cx));
    let receiver_config = parse(cx.argument::<JsString>(1)?.value(&mut cx));
    let metadata = parse(cx.argument::<JsString>(2)?.value(&mut cx));

    init_with_receiver(config, receiver_config, metadata).unwrap();

    Ok(cx.undefined())
}

fn parse<T: serde::de::DeserializeOwned> (json: String) -> T {
    serde_json::from_str(&json).unwrap()
}
