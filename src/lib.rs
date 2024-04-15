use neon::prelude::*;

#[cfg(feature = "data-pipeline")]
mod data_pipeline;
mod collector;

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    collector::register(&mut cx)?;

    #[cfg(feature = "data-pipeline")]
    data_pipeline::register(&mut cx)?;

    Ok(())
}
