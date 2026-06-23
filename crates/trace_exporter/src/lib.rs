// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm binding for `TraceExporter<WasmCapabilities>`.
//!
//! This crate exposes libdatadog's trace exporter to JavaScript via
//! `wasm_bindgen`. The generic parameter is pinned to `WasmCapabilities`,
//! which routes I/O (HTTP, etc.) back into JavaScript.
//!
//! This is a lower-level, secondary path that sends pre-encoded v0.4 trace
//! bytes directly; the primary span pipeline (and its richer tracer metadata)
//! lives in the `pipeline` crate's `WasmSpanState`. `JsTraceExporter` hardcodes
//! its language metadata accordingly.

use std::cell::{Cell, UnsafeCell};

use libdatadog_nodejs_capabilities::WasmCapabilities;
use libdd_data_pipeline::trace_exporter::{
    agent_response::AgentResponse, TraceExporter, TraceExporterBuilder, TraceExporterInputFormat,
    TraceExporterOutputFormat,
};
use libdd_shared_runtime::LocalRuntime;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct JsTraceExporter {
    /// Built lazily on first send: `build` is unavailable on wasm (it needs a
    /// blocking runtime), so the configured builder is stashed and driven via
    /// `build_async` inside the async send path.
    // wasm uses the single-threaded LocalRuntime (spawn_local), not the
    // native multi-thread runtimes.
    inner: UnsafeCell<Option<TraceExporter<WasmCapabilities, LocalRuntime>>>,
    builder: UnsafeCell<Option<TraceExporterBuilder<LocalRuntime>>>,
    /// Re-entrancy guard for `send`. wasm-bindgen async exports can be
    /// re-invoked from JS before the prior future resolves; without this, two
    /// calls would each take `&mut` out of `inner`/`builder` and alias across
    /// the await (UB). A re-entrant call returns an error instead.
    sending: Cell<bool>,
}

// SAFETY: wasm is single-threaded; there are no concurrent accesses.
unsafe impl Send for JsTraceExporter {}
unsafe impl Sync for JsTraceExporter {}

/// Clears the in-flight flag on drop (covers early returns / dropped futures).
struct InFlightGuard<'a>(&'a Cell<bool>);
impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}

#[wasm_bindgen]
impl JsTraceExporter {
    #[wasm_bindgen(constructor)]
    pub fn new(url: &str, service: &str) -> Result<JsTraceExporter, JsValue> {
        let mut builder = TraceExporterBuilder::<LocalRuntime>::new();
        builder
            .set_url(url)
            .set_service(service)
            .set_language("javascript")
            .set_language_version("")
            .set_language_interpreter("nodejs")
            .set_input_format(TraceExporterInputFormat::V04)
            .set_output_format(TraceExporterOutputFormat::V04);

        Ok(JsTraceExporter {
            inner: UnsafeCell::new(None),
            builder: UnsafeCell::new(Some(builder)),
            sending: Cell::new(false),
        })
    }

    #[wasm_bindgen]
    pub async fn send(&self, data: &[u8]) -> Result<JsValue, JsValue> {
        if self.sending.get() {
            return Err(JsValue::from_str("send is already in flight"));
        }
        self.sending.set(true);
        let _in_flight = InFlightGuard(&self.sending);

        // SAFETY: wasm is single-threaded and the `sending` guard above rejects
        // re-entrant calls, so this is the only live reference across the await.
        let slot = unsafe { &mut *self.inner.get() };
        if slot.is_none() {
            let builder = unsafe { &mut *self.builder.get() }
                .take()
                .ok_or_else(|| JsValue::from_str("exporter builder already consumed"))?;
            let built = builder
                .build_async::<WasmCapabilities>()
                .await
                .map_err(|e| JsValue::from_str(&format!("{:?}", e)))?;
            *slot = Some(built);
        }
        let inner = slot.as_ref().unwrap();

        let result = inner
            .send_async(data)
            .await
            .map_err(|e| JsValue::from_str(&format!("{:?}", e)))?;

        // Mirror WasmSpanState.sendPreparedChunk's representation so both send
        // paths report an unchanged agent response identically.
        match result {
            AgentResponse::Changed { body } => Ok(JsValue::from_str(&body)),
            AgentResponse::Unchanged => Ok(JsValue::from_str("unchanged")),
        }
    }
}
