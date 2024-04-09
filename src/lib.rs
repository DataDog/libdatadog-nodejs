use neon::prelude::*;
use ::collector::collector::Collector;

mod data_pipeline;
mod collector;

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    collector::COLLECTORS.get_or_init(&mut cx, || Collector::new());

    cx.export_function("send_events", collector::send_events)?;
    cx.export_function("receive_events", collector::receive_events)?;
    cx.export_function("init_trace_exporter", data_pipeline::init_trace_exporter)?;
    cx.export_function("send_traces", data_pipeline::send_traces)?;

    Ok(())
}

