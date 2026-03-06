// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm binding for `TraceExporter<WasmCapabilities>`.
//!
//! This crate exposes libdatadog's trace exporter to JavaScript via
//! `wasm_bindgen`. The generic parameter is pinned to `WasmCapabilities`,
//! which routes I/O (HTTP, etc.) back into JavaScript.

use libdatadog_nodejs_capabilities::WasmCapabilities;
use libdd_data_pipeline::trace_exporter::{
    agent_response::AgentResponse, TraceExporter, TraceExporterInputFormat,
    TraceExporterOutputFormat,
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct JsTraceExporter {
    inner: TraceExporter<WasmCapabilities>,
}

#[wasm_bindgen]
impl JsTraceExporter {
    #[wasm_bindgen(constructor)]
    pub fn new(url: &str, service: &str) -> Result<JsTraceExporter, JsValue> {
        let mut builder = TraceExporter::<WasmCapabilities>::builder();
        builder
            .set_url(url)
            .set_service(service)
            .set_language("javascript")
            .set_language_version("")
            .set_language_interpreter("nodejs")
            .set_input_format(TraceExporterInputFormat::V04)
            .set_output_format(TraceExporterOutputFormat::V04);

        let exporter = builder
            .build()
            .map_err(|e| JsValue::from_str(&format!("{:?}", e)))?;

        Ok(JsTraceExporter { inner: exporter })
    }

    #[wasm_bindgen]
    pub async fn send(&self, data: &[u8]) -> Result<JsValue, JsValue> {
        let result = self
            .inner
            .send_async(data)
            .await
            .map_err(|e| JsValue::from_str(&format!("{:?}", e)))?;

        match result {
            AgentResponse::Changed { body } => Ok(JsValue::from_str(&body)),
            AgentResponse::Unchanged => Ok(JsValue::NULL),
        }
    }
}
