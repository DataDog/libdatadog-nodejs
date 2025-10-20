use std::borrow::BorrowMut;
use std::sync::Mutex;
use std::cell::OnceCell;
use data_pipeline::trace_exporter::agent_response::AgentResponse;
use neon::prelude::*;
use neon::types::buffer::TypedArray;
use data_pipeline::trace_exporter::TraceExporter;
use data_pipeline::trace_exporter::TraceExporterBuilder;

static EXPORTER: Mutex<OnceCell<TraceExporter>> = Mutex::new(OnceCell::new());

#[neon::main]
fn main (mut cx: ModuleContext) -> NeonResult<()> {
    register(&mut cx)
}

fn register (cx: &mut ModuleContext) -> NeonResult<()> {
    cx.export_function("init_trace_exporter", init_trace_exporter)?;
    cx.export_function("send_traces", send_traces)?;

    Ok(())
}

fn trace_exporter_init(
    url: &str,
    timeout: u64,
    tracer_version: &str,
    lang: &str,
    lang_version: &str,
    lang_interpreter: &str) {

    EXPORTER.lock().unwrap().get_or_init(|| {
        let mut builder = TraceExporterBuilder::default();
        builder
            .set_url(url)
            .set_tracer_version(tracer_version)
            .set_language(lang)
            .set_language_version(lang_version)
            .set_language_interpreter(lang_interpreter)
            .set_connection_timeout(Some(timeout));

        builder.build().unwrap()

    });
}

fn init_trace_exporter(mut cx: FunctionContext) -> JsResult<JsUndefined>{
    let url = cx.argument::<JsString>(0)?.value(cx.borrow_mut());
    let timeout = cx.argument::<JsNumber>(1)?.value(cx.borrow_mut());
    let tracer_version = cx.argument::<JsString>(2)?.value(cx.borrow_mut());
    let lang = cx.argument::<JsString>(3)?.value(cx.borrow_mut());
    let lang_version = cx.argument::<JsString>(4)?.value(cx.borrow_mut());
    let lang_interpreter = cx.argument::<JsString>(5)?.value(cx.borrow_mut());

    trace_exporter_init(
        &url,
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

    let ret = match response {
        Ok(r) => match r {
            AgentResponse::Unchanged => "".to_string(),
            AgentResponse::Changed{body} =>  body,
        },
        Err(_) => "Error sending traces".to_string(),
    };

    Ok(cx.string(ret))
}


