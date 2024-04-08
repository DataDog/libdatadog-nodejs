use events::collector::Collector;
use events::runtime::RUNTIME;
use neon::prelude::*;
use neon::thread::LocalKey;
use neon::types::buffer::TypedArray;

// TODO: Use a single collector for all worker threads.
static COLLECTORS: LocalKey<Collector> = LocalKey::new();

#[cfg(feature = "data-pipeline")]
mod data_pipeline;

 #[cfg(feature = "data-pipeline")]
fn export_data_pipeline(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("init_trace_exporter", data_pipeline::init_trace_exporter)?;
    cx.export_function("send_traces", data_pipeline::send_traces)?;
    Ok(())
}

#[cfg(not(feature = "data-pipeline"))]
#[inline]
fn export_data_pipeline(_cx: ModuleContext) -> NeonResult<()> {
    Ok(())
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
    export_data_pipeline(cx)?;
    Ok(())
}

