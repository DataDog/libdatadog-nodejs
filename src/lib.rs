use neon::prelude::*;

#[cfg(feature = "data-pipeline")]
mod data_pipeline;
#[cfg(feature = "collector")]
mod collector;
#[cfg(feature = "crashtracker")]
mod crashtracker;

#[neon::main]
fn main(mut _cx: ModuleContext) -> NeonResult<()> {
    #[cfg(feature = "collector")]
    collector::register(&mut _cx)?;

    #[cfg(feature = "data-pipeline")]
    data_pipeline::register(&mut _cx)?;

    #[cfg(feature = "crashtracker")]
    crashtracker::register(&mut _cx)?;

    Ok(())
}
