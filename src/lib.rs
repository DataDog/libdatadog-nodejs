use std::borrow::BorrowMut;
use std::sync::Mutex;
use std::cell::OnceCell;
use collector::collector::Collector;
use collector::runtime::RUNTIME;
use neon::prelude::*;
use data_pipeline::trace_exporter::TraceExporter;
use data_pipeline::trace_exporter::TraceExporterBuilder;
use neon::thread::LocalKey;
use neon::types::buffer::TypedArray;

// TODO: Use a single collector for all worker threads.
static COLLECTORS: LocalKey<Collector> = LocalKey::new();
static EXPORTER: Mutex<OnceCell<TraceExporter>> = Mutex::new(OnceCell::new());

fn hello(mut cx: FunctionContext) -> JsResult<JsString> {
    Ok(cx.string("hello node"))
}

fn trace_exporter_init(
    host: &str,
    port: u16,
    timeout: u64,
    tracer_version: &str,
    lang: &str,
    lang_version: &str,
    lang_interpreter: &str) {

    EXPORTER.lock().unwrap().get_or_init(|| {
        TraceExporterBuilder::default()
            .set_host(host)
            .set_port(port)
            .set_tracer_version(tracer_version)
            .set_language(lang)
            .set_language_version(lang_version)
            .set_language_interpreter(lang_interpreter)
            .set_timeout(timeout)
            .build()
            .unwrap()

   });
}

fn init_trace_exporter(mut cx: FunctionContext) -> JsResult<JsUndefined>{
    let host = cx.argument::<JsString>(0)?.value(cx.borrow_mut());
    let port = cx.argument::<JsNumber>(1)?.value(cx.borrow_mut());
    let timeout = cx.argument::<JsNumber>(2)?.value(cx.borrow_mut());
    let tracer_version = cx.argument::<JsString>(3)?.value(cx.borrow_mut());
    let lang = cx.argument::<JsString>(4)?.value(cx.borrow_mut());
    let lang_version = cx.argument::<JsString>(5)?.value(cx.borrow_mut());
    let lang_interpreter = cx.argument::<JsString>(5)?.value(cx.borrow_mut());

    trace_exporter_init(
        &host,
        port as u16,
        timeout as u64,
        &tracer_version,
        &lang,
        &lang_version,
        &lang_interpreter);

    Ok(cx.undefined())
}

fn send_traces(mut cx: FunctionContext) -> JsResult<JsString> {
    let trace_count = cx.argument::<JsNumber>(1)?.value(cx.borrow_mut());
    let data = cx.argument::<JsBuffer>(0)?.as_slice(cx.borrow_mut());

    let response = EXPORTER.lock().unwrap().get().unwrap().send(data, trace_count as usize);

    Ok(cx.string(response.unwrap_or("Error sending traces".to_string())))
}

fn send_events(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let payload = cx.argument::<JsBuffer>(0).unwrap().as_slice(&mut cx).to_vec();
    let collector = COLLECTORS.get(&mut cx).unwrap();

    collector.write(payload.as_slice());

    Ok(cx.undefined())
}

// TODO: Do we need an unsubscribe?
fn receive_events(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let collector = COLLECTORS.get(&mut cx).unwrap();
    let mut cb = cx.argument::<JsFunction>(0)?.root(&mut cx);
    let ch = cx.channel();
    let mut rx = collector.subscribe();

    RUNTIME.spawn_blocking(move || {
        while let Ok(payload) = rx.blocking_recv() {
            cb = ch.send(move |mut cx| {
                let buf = JsBuffer::from_slice(&mut cx, payload.as_slice()).unwrap();
                let this = cx.undefined();
                let args = vec![buf.upcast()];

                cb.to_inner(&mut cx).call(&mut cx, this, args).unwrap();

                Ok(cb)
            }).join().unwrap();
        }
    });

    Ok(cx.undefined())
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    COLLECTORS.get_or_init(&mut cx, || Collector::new());

    cx.export_function("send_events", send_events)?;
    cx.export_function("receive_events", receive_events)?;
    cx.export_function("hello", hello)?;
    cx.export_function("init_trace_exporter", init_trace_exporter)?;
    cx.export_function("send_traces", send_traces)?;

    Ok(())
}

