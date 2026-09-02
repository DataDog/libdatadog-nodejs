use std::env;

fn main() {
    napi_build::setup();

    if env::var("TARGET").as_deref() == Ok("wasm32-unknown-unknown") {
        println!("cargo:rustc-link-arg=--import-undefined");
        println!("cargo:rustc-link-arg=--export=malloc");
        println!("cargo:rustc-link-arg=--export=free");
        println!("cargo:rustc-link-arg=--export-table");
        println!("cargo:rustc-link-arg=--export-dynamic");
        println!("cargo:rustc-link-arg=--export=napi_register_wasm_v1");
        println!("cargo:rustc-link-arg=--export-if-defined=napi_prepare_wasm_env_cleanup");
        println!("cargo:rustc-link-arg=--export-if-defined=napi_wasm_env_cleanup_pending");
    }
}
