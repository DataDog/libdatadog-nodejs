use neon::prelude::*;
use neon::thread::LocalKey;
use neon::types::buffer::TypedArray;
use collector::runtime::RUNTIME;
use collector::collector::Collector;

// TODO: Use a single collector for all worker threads.
pub static COLLECTORS: LocalKey<Collector> = LocalKey::new();

pub fn send_events(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let payload = cx.argument::<JsBuffer>(0).unwrap().as_slice(&mut cx).to_vec();
    let collector = COLLECTORS.get(&mut cx).unwrap();

    collector.write(payload.as_slice());

    Ok(cx.undefined())
}

// TODO: Do we need an unsubscribe?
pub fn receive_events(mut cx: FunctionContext) -> JsResult<JsUndefined> {
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


