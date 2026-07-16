// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm implementation of [`EnvCapability`] backed by Node.js `process.env`.

use wasm_bindgen::prelude::*;

use libdd_capabilities::env::{EnvCapability, EnvError};

#[wasm_bindgen(module = "/src/env_transport.js")]
extern "C" {
    #[wasm_bindgen(js_name = "get")]
    fn js_env_get(name: &str) -> JsValue;

    #[wasm_bindgen(js_name = "set")]
    fn js_env_set(name: &str, value: &str);

    #[wasm_bindgen(js_name = "unset")]
    fn js_env_unset(name: &str);
}

#[derive(Debug, Clone)]
pub struct WasmEnvCapability;

impl EnvCapability for WasmEnvCapability {
    fn new() -> Self {
        Self
    }

    fn get(&self, name: &str) -> Result<Option<String>, EnvError> {
        // Node coerces every process.env value to a string, so NotUnicode is unreachable here.
        let value = js_env_get(name);
        if value.is_undefined() || value.is_null() {
            Ok(None)
        } else {
            Ok(value.as_string())
        }
    }

    unsafe fn set(&self, name: &str, value: &str) -> Result<(), EnvError> {
        // SAFETY: Wasm is single-threaded; no concurrent env access is possible.
        js_env_set(name, value);
        Ok(())
    }

    unsafe fn unset(&self, name: &str) -> Result<(), EnvError> {
        // SAFETY: Wasm is single-threaded; no concurrent env access is possible.
        js_env_unset(name);
        Ok(())
    }
}
