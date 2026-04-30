use libdatadog_nodejs_capabilities::WasmCapabilities;
use libdd_data_pipeline::trace_exporter::agent_response::AgentResponse;
use libdd_data_pipeline::trace_exporter::TraceExporter;
use std::cell::{RefCell, UnsafeCell};
use std::ffi::CStr;
use std::time::Duration;

use wasm_bindgen::prelude::*;

mod span_string;
use span_string::*;

mod span_bytes;

mod trace_data;
use trace_data::*;

mod stats;

use libdd_trace_utils::change_buffer::{ChangeBuffer, ChangeBufferState};

/// Insert or update a key-value pair in a Vec-based associative array.
fn vec_insert<K: PartialEq, V>(vec: &mut Vec<(K, V)>, key: K, value: V) {
    for entry in vec.iter_mut() {
        if entry.0 == key {
            entry.1 = value;
            return;
        }
    }
    vec.push((key, value));
}

mod utils;
use utils::*;

#[wasm_bindgen(start)]
fn init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
/// All mutable state is behind RefCell to allow `&self` methods on the
/// wasm-bindgen wrapper. This prevents re-entrant borrow panics when:
/// - Plugin instrumentation triggers span creation inside another span's
///   creation (e.g., http client span created during express handler)
/// - Async `flushChunk` holds a borrow across await points while other
///   span operations need access
pub struct WasmSpanState {
    change_queue: Vec<u8>,
    string_table_input: Vec<u8>,
    /// UnsafeCell because send_trace_chunks_async needs &mut self across an
    /// await point. WASM is single-threaded so this is safe — we just need
    /// to ensure no overlapping mutable borrows (guaranteed by the JS-side
    /// _flushInFlight guard which serializes sendPreparedChunk calls).
    exporter: UnsafeCell<TraceExporter<WasmCapabilities>>,
    cbs: RefCell<ChangeBufferState<WasmTraceData>>,
    stats_collector: RefCell<Option<stats::StatsCollector>>,
    prepared_spans: RefCell<Option<Vec<libdd_trace_utils::span::v04::Span<WasmTraceData>>>>,
}

#[wasm_bindgen]
impl WasmSpanState {
    #[wasm_bindgen(constructor)]
    pub fn new(
        url: &str,
        tracer_version: &str,
        lang: &str,
        lang_version: &str,
        lang_interpreter: &str,
        change_queue_size: u32,
        string_table_input_size: u32,
        pid: u32,
        tracer_service: &str,
        stats_enabled: bool,
        hostname: &str,
        env: &str,
        app_version: &str,
        runtime_id: &str,
    ) -> Result<WasmSpanState, JsValue> {
        let mut builder = TraceExporter::<WasmCapabilities>::builder();
        builder
            .set_url(url)
            .set_tracer_version(tracer_version)
            .set_language(lang)
            .set_language_version(lang_version)
            .set_language_interpreter(lang_interpreter)
            .enable_agent_rates_payload_version();

        let mut change_queue = vec![0u8; change_queue_size as usize];
        let change_buffer =
            unsafe { ChangeBuffer::from_raw_parts(change_queue.as_mut_ptr(), change_queue.len()) };
        let change_buffer_state = ChangeBufferState::new(
            change_buffer,
            tracer_service.into(),
            lang.into(),
            pid,
        );

        let exporter = builder
            .build()
            .map_err(|e| JsValue::from_str(&format!("{:?}", e)))?;

        let stats_collector = if stats_enabled {
            Some(stats::StatsCollector::new(
                Duration::from_secs(10),
                url.to_string(),
                stats::StatsMeta {
                    hostname: hostname.to_string(),
                    env: env.to_string(),
                    version: app_version.to_string(),
                    lang: lang.to_string(),
                    tracer_version: tracer_version.to_string(),
                    runtime_id: runtime_id.to_string(),
                    service: tracer_service.to_string(),
                },
            ))
        } else {
            None
        };

        Ok(WasmSpanState {
            change_queue,
            string_table_input: vec![0u8; string_table_input_size as usize],
            exporter: UnsafeCell::new(exporter),
            cbs: RefCell::new(change_buffer_state),
            stats_collector: RefCell::new(stats_collector),
            prepared_spans: RefCell::new(None),
        })
    }

    #[wasm_bindgen]
    pub fn change_queue_ptr(&self) -> *const u8 {
        self.change_queue.as_ptr()
    }

    #[wasm_bindgen]
    pub fn change_queue_len(&self) -> u32 {
        self.change_queue.len() as u32
    }

    #[wasm_bindgen]
    pub fn string_table_input_ptr(&self) -> *const u8 {
        self.string_table_input.as_ptr()
    }

    #[wasm_bindgen]
    pub fn string_table_input_len(&self) -> u32 {
        self.string_table_input.len() as u32
    }

    /// Prepare a chunk of spans for sending. Flushes the change buffer,
    /// extracts spans, feeds stats. Returns `true` if there are spans to send.
    /// Must be followed by `sendPreparedChunk()` to actually send.
    #[wasm_bindgen(js_name = "prepareChunk")]
    pub fn prepare_chunk(
        &self,
        len: u32,
        first_is_local_root: bool,
        chunk: &[u8],
    ) -> Result<bool, JsValue> {
        self.cbs.borrow_mut()
            .flush_change_buffer()
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        let mut count = len;
        let mut index = 0;
        let mut slots = Vec::with_capacity(count as usize);
        while count > 0 {
            let slot: u32 = get_num(chunk, &mut index);
            slots.push(slot);
            count -= 1;
        }

        let spans_vec = self
            .cbs.borrow_mut()
            .flush_chunk(slots, first_is_local_root)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        if let Some(collector) = self.stats_collector.borrow_mut().as_mut() {
            collector.add_spans(&spans_vec);
        }

        // Recycle any previously prepared spans that were never sent (e.g.
        // if the prior send was skipped by JS back-pressure). Reusing the
        // pre-allocated HashMaps avoids allocator fragmentation in WASM.
        if let Some(old_spans) = self.prepared_spans.borrow_mut().take() {
            self.cbs.borrow_mut().recycle_spans(old_spans);
        }

        // Store prepared spans for the subsequent sendPreparedChunk call
        *self.prepared_spans.borrow_mut() = Some(spans_vec);
        Ok(true)
    }

    /// Send the previously prepared chunk. Takes &mut self because the
    /// exporter needs exclusive access for the HTTP send.
    #[wasm_bindgen(js_name = "sendPreparedChunk")]
    pub async fn send_prepared_chunk(&self) -> Result<JsValue, JsValue> {
        let spans_vec = self
            .prepared_spans
            .borrow_mut()
            .take()
            .ok_or_else(|| JsValue::from_str("no prepared chunk to send"))?;

        // SAFETY: WASM is single-threaded. The JS-side _flushInFlight guard
        // ensures only one sendPreparedChunk runs at a time. No other code
        // accesses the exporter during the await.
        let exporter = unsafe { &mut *self.exporter.get() };
        let resp = exporter
            .send_trace_chunks_async(vec![spans_vec])
            .await;
        let response_str = resp.map(|resp| match resp {
            AgentResponse::Unchanged => "unchanged".to_string(),
            AgentResponse::Changed { body } => body,
        });

        response_str
            .map(|s| JsValue::from_str(&s))
            .map_err(|e| JsValue::from_str(&format!("{:?}", e)))
    }

    /// Flush aggregated stats to the agent's /v0.6/stats endpoint.
    ///
    /// Should be called periodically (e.g. every 10s) from JS, and with
    /// `force=true` on shutdown.
    #[wasm_bindgen(js_name = "flushStats")]
    pub async fn flush_stats(&self, force: bool) -> Result<bool, JsValue> {
        if let Some(collector) = self.stats_collector.borrow_mut().as_mut() {
            collector
                .flush(force)
                .await
                .map_err(|e| JsValue::from_str(&e))
        } else {
            Ok(false)
        }
    }

    #[wasm_bindgen(js_name = "flushChangeQueue")]
    pub fn flush_change_queue(&self) -> Result<bool, JsValue> {
        self.cbs.borrow_mut()
            .flush_change_buffer()
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(true)
    }

    /// Set default meta tags applied to every new span.
    /// Takes a flat array of key-value pairs: [key1, val1, key2, val2, ...]
    #[wasm_bindgen(js_name = "setDefaultMeta")]
    pub fn set_default_meta(&self, pairs: Vec<JsValue>) -> Result<(), JsValue> {
        let mut tags = Vec::with_capacity(pairs.len() / 2);
        let mut i = 0;
        while i + 1 < pairs.len() {
            let key = pairs[i]
                .as_string()
                .ok_or_else(|| JsValue::from_str("default meta key must be a string"))?;
            let val = pairs[i + 1]
                .as_string()
                .ok_or_else(|| JsValue::from_str("default meta value must be a string"))?;
            tags.push((key.into(), val.into()));
            i += 2;
        }
        self.cbs.borrow_mut().set_default_meta(tags);
        Ok(())
    }

    #[wasm_bindgen(js_name = "stringTableInsertOne")]
    pub fn string_table_insert_one(&self, key: u32, val: &str) {
        self.cbs.borrow_mut()
            .string_table_insert_one(key, val.into());
    }

    /// Set a meta tag using pre-resolved string table IDs.
    /// No string marshalling — just integer args. Bypasses the change buffer.
    #[wasm_bindgen(js_name = "setMetaById")]
    pub fn set_meta_by_id(&self, slot: u32, key_id: u32, val_id: u32) -> Result<(), JsValue> {
        let mut cbs = self.cbs.borrow_mut();
        let key = cbs
            .get_string(key_id)
            .ok_or_else(|| JsValue::from_str("key string not found"))?;
        let val = cbs
            .get_string(val_id)
            .ok_or_else(|| JsValue::from_str("value string not found"))?;
        let span = cbs.span_mut(&slot)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        vec_insert(&mut span.meta, key, val);
        Ok(())
    }

    /// Set a metric tag using a pre-resolved string table ID for the key.
    #[wasm_bindgen(js_name = "setMetricById")]
    pub fn set_metric_by_id(&self, slot: u32, key_id: u32, val: f64) -> Result<(), JsValue> {
        let mut cbs = self.cbs.borrow_mut();
        let key = cbs
            .get_string(key_id)
            .ok_or_else(|| JsValue::from_str("key string not found"))?;
        let span = cbs.span_mut(&slot)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        vec_insert(&mut span.metrics, key, val);
        Ok(())
    }

    #[wasm_bindgen(js_name = "stringTableInsertMany")]
    pub fn string_table_insert_many(&self, count: u32) -> Result<(), JsValue> {
        let mut index: usize = 0;
        let mut remaining = count as usize;
        while remaining > 0 {
            let key: u32 = get_num(&self.string_table_input, &mut index);
            let str_slice = &self.string_table_input[index..];
            let val = unsafe {
                CStr::from_ptr(str_slice.as_ptr() as *const _)
                    .to_str()
                    .map_err(|e| JsValue::from_str(&format!("{}", e)))?
            }
            .to_owned();
            index += val.len();
            self.cbs.borrow_mut()
                .string_table_insert_one(key, val.into());
            remaining -= 1;
        }
        Ok(())
    }

    #[wasm_bindgen(js_name = "stringTableEvict")]
    pub fn string_table_evict(&self, key: u32) {
        self.cbs.borrow_mut().string_table_evict_one(key);
    }

    #[wasm_bindgen(js_name = "getServiceName")]
    pub fn get_service_name(&self, slot: u32) -> Result<String, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(slot).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(span.service.to_string())
    }

    #[wasm_bindgen(js_name = "getResourceName")]
    pub fn get_resource_name(&self, slot: u32) -> Result<String, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(slot).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(span.resource.to_string())
    }

    #[wasm_bindgen(js_name = "getMetaAttr")]
    pub fn get_meta_attr(&self, slot: u32, name: &str) -> Result<JsValue, JsValue> {
        self.flush_change_queue()?;
        self.cbs.borrow_mut().materialize_slot(slot);
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(slot).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let name: SpanString = name.into();
        Ok(span.meta.iter().find(|(k, _)| *k == name)
            .map(|(_, v)| JsValue::from_str(&v.to_string()))
            .unwrap_or(JsValue::NULL))
    }

    #[wasm_bindgen(js_name = "getMetricAttr")]
    pub fn get_metric_attr(&self, slot: u32, name: &str) -> Result<JsValue, JsValue> {
        self.flush_change_queue()?;
        self.cbs.borrow_mut().materialize_slot(slot);
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(slot).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let name: SpanString = name.into();
        Ok(span.metrics.iter().find(|(k, _)| *k == name)
            .map(|(_, v)| JsValue::from_f64(*v))
            .unwrap_or(JsValue::NULL))
    }

    #[wasm_bindgen(js_name = "getError")]
    pub fn get_error(&self, slot: u32) -> Result<i32, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(slot).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(span.error)
    }

    #[wasm_bindgen(js_name = "getStart")]
    pub fn get_start(&self, slot: u32) -> Result<f64, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(slot).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(span.start as f64)
    }

    #[wasm_bindgen(js_name = "getDuration")]
    pub fn get_duration(&self, slot: u32) -> Result<f64, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(slot).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(span.duration as f64)
    }

    #[wasm_bindgen(js_name = "getType")]
    pub fn get_type(&self, slot: u32) -> Result<String, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(slot).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(span.r#type.to_string())
    }

    #[wasm_bindgen(js_name = "getName")]
    pub fn get_name(&self, slot: u32) -> Result<String, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(slot).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(span.name.to_string())
    }

    #[wasm_bindgen(js_name = "getTraceMetaAttr")]
    pub fn get_trace_meta_attr(&self, slot: u32, name: &str) -> Result<JsValue, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let trace_id = cbs.get_span(slot)
            .map_err(|e| JsValue::from_str(&e.to_string()))?.trace_id;
        let name: SpanString = name.into();
        Ok(cbs.get_trace(&trace_id)
            .and_then(|t| t.meta.iter().find(|(k, _)| *k == name))
            .map(|(_, v)| JsValue::from_str(&v.to_string()))
            .unwrap_or(JsValue::NULL))
    }

    #[wasm_bindgen(js_name = "getTraceMetricAttr")]
    pub fn get_trace_metric_attr(&self, slot: u32, name: &str) -> Result<JsValue, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let trace_id = cbs.get_span(slot)
            .map_err(|e| JsValue::from_str(&e.to_string()))?.trace_id;
        let name: SpanString = name.into();
        Ok(cbs.get_trace(&trace_id)
            .and_then(|t| t.metrics.iter().find(|(k, _)| *k == name))
            .map(|(_, v)| JsValue::from_f64(*v))
            .unwrap_or(JsValue::NULL))
    }

    #[wasm_bindgen(js_name = "getTraceOrigin")]
    pub fn get_trace_origin(&self, slot: u32) -> Result<JsValue, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let trace_id = cbs.get_span(slot)
            .map_err(|e| JsValue::from_str(&e.to_string()))?.trace_id;
        Ok(cbs.get_trace(&trace_id)
            .and_then(|t| t.origin.as_ref())
            .map(|v| JsValue::from_str(&v.to_string()))
            .unwrap_or(JsValue::NULL))
    }
}

/// Export WASM memory so JS can create views into it
#[wasm_bindgen(js_name = "getWasmMemory")]
pub fn get_wasm_memory() -> JsValue {
    wasm_bindgen::memory()
}

/// Export OpCode values as a JS object.
/// Values match the `#[repr(u64)]` OpCode enum in libdd-trace-utils.
#[wasm_bindgen(js_name = "getOpCodes")]
pub fn get_op_codes() -> JsValue {
    let obj = js_sys::Object::new();
    let entries: &[(&str, u32)] = &[
        ("Create", 0),
        ("SetMetaAttr", 1),
        ("SetMetricAttr", 2),
        ("SetServiceName", 3),
        ("SetResourceName", 4),
        ("SetError", 5),
        ("SetStart", 6),
        ("SetDuration", 7),
        ("SetType", 8),
        ("SetName", 9),
        ("SetTraceMetaAttr", 10),
        ("SetTraceMetricsAttr", 11),
        ("SetTraceOrigin", 12),
    ];
    for (name, val) in entries {
        js_sys::Reflect::set(&obj, &JsValue::from_str(name), &JsValue::from_f64(*val as f64))
            .unwrap();
    }
    obj.into()
}

#[wasm_bindgen(js_name = "setStorage")]
pub fn set_storage(new_storage: &JsValue) {
    libdatadog_nodejs_capabilities::http::set_storage(new_storage);
}
