use std::env;
use std::path::PathBuf;

use anyhow::{Context, Result};
use wasm_bindgen_cli_support::Bindgen;

fn main() -> Result<()> {
    let mut arguments = env::args_os().skip(1);
    let input = PathBuf::from(arguments.next().context("missing input path")?);
    let output = PathBuf::from(arguments.next().context("missing output directory")?);
    anyhow::ensure!(arguments.next().is_none(), "unexpected extra arguments");

    Bindgen::new()
        .input_path(input)
        .nodejs(true)?
        .keep_lld_exports(true)
        .generate(output)?;
    Ok(())
}
