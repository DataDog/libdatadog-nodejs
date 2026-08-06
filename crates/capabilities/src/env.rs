// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm implementation of [`EnvCapability`] backed by Node.js `process.env`.

use wasm_bindgen::prelude::*;

use libdd_capabilities::env::{EnvCapability, EnvError};

#[wasm_bindgen(module = "/src/env_transport.js")]
extern "C" {
    #[wasm_bindgen(js_name = "get")]
    fn js_env_get(name: &str) -> JsValue;
}

#[derive(Debug, Clone)]
pub struct WasmEnvCapability;

impl EnvCapability for WasmEnvCapability {
    fn new() -> Self {
        Self
    }

    fn get(&self, name: &str) -> Result<Option<String>, EnvError> {
        // Node coerces every process.env value to a string, so NotUnicode is unreachable here.
        Ok(js_env_get(name).as_string())
    }
}
