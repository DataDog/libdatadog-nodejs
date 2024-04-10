use neon::prelude::*;

mod data_pipeline;
mod collector;

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    collector::register(&mut cx)?;
    data_pipeline::register(&mut cx)?;

    Ok(())
}
