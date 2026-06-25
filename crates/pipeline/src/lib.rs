use libdatadog_nodejs_capabilities::WasmCapabilities;
use libdd_data_pipeline::trace_exporter::agent_response::AgentResponse;
use libdd_data_pipeline::trace_exporter::{TraceExporter, TraceExporterBuilder};
use libdd_shared_runtime::LocalRuntime;
use std::cell::{Cell, RefCell, UnsafeCell};
use std::ffi::CStr;
use std::time::Duration;

use wasm_bindgen::prelude::*;

mod span_string;

mod span_bytes;

mod trace_data;
use trace_data::*;

mod stats;

use libdd_trace_utils::change_buffer::{ChangeBuffer, ChangeBufferState};

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
    /// On wasm the exporter must be built asynchronously (`build_async`), but
    /// the wasm-bindgen constructor is synchronous. We stash the configured
    /// builder here and build the exporter lazily on the first send (the only
    /// path that needs it), inside an async context.
    // On wasm the exporter runs on a single-threaded `LocalRuntime` (workers
    // spawned via wasm_bindgen_futures::spawn_local); the multi-thread
    // ForkSafeRuntime/BasicRuntime are native-only.
    exporter: UnsafeCell<Option<TraceExporter<WasmCapabilities, LocalRuntime>>>,
    builder: UnsafeCell<Option<TraceExporterBuilder<LocalRuntime>>>,
    cbs: RefCell<ChangeBufferState<WasmTraceData>>,
    stats_collector: RefCell<Option<stats::StatsCollector>>,
    prepared_spans: RefCell<Option<Vec<libdd_trace_utils::span::v04::Span<WasmTraceData>>>>,
    /// Re-entrancy guard for `sendPreparedChunk`. wasm-bindgen async exports
    /// can be invoked again from JS before the prior future resolves; without
    /// this, two calls would each take `&mut` out of `exporter`/`builder` and
    /// alias across the await (UB). The guard makes a re-entrant call return
    /// an error instead.
    sending: Cell<bool>,
}

/// Clears an in-flight flag on drop, so an early return or a dropped future
/// still resets it.
struct InFlightGuard<'a>(&'a Cell<bool>);
impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
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
        let mut builder = TraceExporterBuilder::<LocalRuntime>::new();
        builder
            .set_url(url)
            .set_tracer_version(tracer_version)
            .set_language(lang)
            .set_language_version(lang_version)
            .set_language_interpreter(lang_interpreter)
            // Populate the payload-level TracerMetadata (service/env/hostname/
            // app_version) the agent receives. These values are already passed
            // in for the stats collector; without these calls the trace
            // payload's tracer metadata is sent empty.
            .set_service(tracer_service)
            .set_env(env)
            .set_hostname(hostname)
            .set_app_version(app_version)
            .enable_agent_rates_payload_version();

        let mut change_queue = vec![0u8; change_queue_size as usize];
        let change_buffer = unsafe {
            ChangeBuffer::from_raw_parts(
                std::ptr::NonNull::new(change_queue.as_mut_ptr()).unwrap(),
                change_queue.len(),
            )
        };
        let change_buffer_state = ChangeBufferState::new(
            change_buffer,
            tracer_service.into(),
            lang.into(),
            pid,
        );

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
            exporter: UnsafeCell::new(None),
            builder: UnsafeCell::new(Some(builder)),
            cbs: RefCell::new(change_buffer_state),
            stats_collector: RefCell::new(stats_collector),
            prepared_spans: RefCell::new(None),
            sending: Cell::new(false),
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
    /// extracts spans, feeds stats. Returns `true` if a chunk was prepared
    /// (there are spans to send) and `false` if there was nothing to send.
    /// Must be followed by `sendPreparedChunk()` to actually send.
    #[wasm_bindgen(js_name = "prepareChunk")]
    pub fn prepare_chunk(
        &self,
        len: u32,
        first_is_local_root: bool,
        chunk: &[u8],
    ) -> Result<bool, JsValue> {
        // Validate the JS-supplied count against the actual buffer size before
        // doing any work: each span id is a u64 (8 bytes). This prevents an
        // out-of-bounds read panic (and a huge `Vec::with_capacity`) when the
        // caller passes a `len` larger than the chunk can hold.
        if (len as usize).saturating_mul(8) > chunk.len() {
            return Err(JsValue::from_str(
                "prepareChunk: len exceeds the span-id bytes available in chunk",
            ));
        }
        if len == 0 {
            // Nothing to send: drop any previously prepared-but-unsent chunk so
            // a caller that ignores this `false` cannot later resend a stale one.
            if let Some(old_spans) = self.prepared_spans.borrow_mut().take() {
                self.cbs.borrow_mut().recycle_spans(old_spans);
            }
            return Ok(false);
        }

        self.cbs.borrow_mut()
            .flush_change_buffer()
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        let mut count = len;
        let mut index = 0;
        let mut span_ids = Vec::with_capacity(count as usize);
        while count > 0 {
            let span_id: u64 = get_num(chunk, &mut index);
            span_ids.push(span_id);
            count -= 1;
        }

        let spans_vec = self
            .cbs.borrow_mut()
            .flush_chunk(&span_ids, first_is_local_root)
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
        let has_spans = !spans_vec.is_empty();
        *self.prepared_spans.borrow_mut() = Some(spans_vec);
        Ok(has_spans)
    }

    /// Send the previously prepared chunk.
    ///
    /// Uses `&self` (not `&mut self`); exclusive access to the exporter is
    /// enforced at runtime by the `sending` re-entrancy guard below rather
    /// than by the borrow checker. WASM is single-threaded, so the only way
    /// two `&mut` to the exporter could co-exist is async re-entrancy (JS
    /// calling this again before the prior future resolves) — the guard
    /// rejects that with an error instead of allowing aliasing (UB).
    #[wasm_bindgen(js_name = "sendPreparedChunk")]
    pub async fn send_prepared_chunk(&self) -> Result<JsValue, JsValue> {
        if self.sending.get() {
            return Err(JsValue::from_str("sendPreparedChunk is already in flight"));
        }
        self.sending.set(true);
        let _in_flight = InFlightGuard(&self.sending);

        let spans_vec = self
            .prepared_spans
            .borrow_mut()
            .take()
            .ok_or_else(|| JsValue::from_str("no prepared chunk to send"))?;

        // SAFETY: WASM is single-threaded and the `sending` guard above
        // guarantees no overlapping invocation, so this is the only live
        // reference to the exporter for the duration of the awaits.
        let exporter_slot = unsafe { &mut *self.exporter.get() };
        if exporter_slot.is_none() {
            // First send: build the exporter asynchronously. `build` is not
            // available on wasm (it needs a blocking runtime), so we drive
            // `build_async` here where we already have an async context.
            let builder = unsafe { &mut *self.builder.get() }
                .take()
                .ok_or_else(|| JsValue::from_str("exporter builder already consumed"))?;
            let built = builder
                .build_async::<WasmCapabilities>()
                .await
                .map_err(|e| JsValue::from_str(&format!("{:?}", e)))?;
            *exporter_slot = Some(built);
        }
        let exporter = exporter_slot.as_mut().unwrap();
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
        // Take the collector out of the RefCell so no borrow is held across the
        // await (the send is async). This also guards re-entrancy: a second
        // flushStats (or stats access from prepareChunk) during the await sees
        // `None` and is a no-op instead of a double-borrow panic.
        let mut collector = match self.stats_collector.borrow_mut().take() {
            Some(collector) => collector,
            None => return Ok(false),
        };
        let result = collector.flush(force).await;
        *self.stats_collector.borrow_mut() = Some(collector);
        result.map_err(|e| JsValue::from_str(&e))
    }

    /// Flush the queued change-buffer operations. On success always returns
    /// `true` (the bool exists only for signature symmetry with the other
    /// flush methods); failures surface as a thrown error.
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

    #[wasm_bindgen(js_name = "stringTableInsertMany")]
    pub fn string_table_insert_many(&self, count: u32) -> Result<(), JsValue> {
        let mut index: usize = 0;
        let mut remaining = count as usize;
        // Hold one mutable borrow for the whole bulk insert rather than
        // re-borrowing the RefCell once per string.
        let mut cbs = self.cbs.borrow_mut();
        let buf = &self.string_table_input;
        while remaining > 0 {
            // Bound the read against the untrusted `count`: a count larger than
            // the encoded entries must error, not index out of bounds.
            if index + 4 > buf.len() {
                return Err(JsValue::from_str(
                    "stringTableInsertMany: count exceeds the entries in the input buffer",
                ));
            }
            let key: u32 = get_num(buf, &mut index);
            let str_slice = &buf[index..];
            // Bound the NUL scan to the input slice so a non-terminated string
            // can't read past the buffer, and advance past the NUL terminator
            // (+ 1) so the next entry parses from the right offset.
            let cstr = CStr::from_bytes_until_nul(str_slice)
                .map_err(|e| JsValue::from_str(&format!("{}", e)))?;
            let val = cstr
                .to_str()
                .map_err(|e| JsValue::from_str(&format!("{}", e)))?;
            index += val.len() + 1;
            // From<&str> for SpanString is a single Arc<str> allocation — no
            // intermediate owned String.
            cbs.string_table_insert_one(key, val.into());
            remaining -= 1;
        }
        Ok(())
    }

    #[wasm_bindgen(js_name = "stringTableEvict")]
    pub fn string_table_evict(&self, key: u32) {
        self.cbs.borrow_mut().string_table_evict_one(key);
    }

    // Absent-entity convention: span-level getters return an error (JS throw)
    // for an unknown span_id, while trace-level getters and attribute lookups
    // return null for an unknown segment / unset attribute.
    #[wasm_bindgen(js_name = "getServiceName")]
    pub fn get_service_name(&self, span_id: u64) -> Result<String, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(span_id).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(span.service.to_string())
    }

    #[wasm_bindgen(js_name = "getResourceName")]
    pub fn get_resource_name(&self, span_id: u64) -> Result<String, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(span_id).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(span.resource.to_string())
    }

    #[wasm_bindgen(js_name = "getMetaAttr")]
    pub fn get_meta_attr(&self, span_id: u64, name: &str) -> Result<JsValue, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(span_id).map_err(|e| JsValue::from_str(&e.to_string()))?;
        // VecMap::get accepts &str directly (SpanString: Borrow<str>), so no
        // SpanString allocation is needed for the lookup.
        Ok(span.meta.get(name)
            .map(|v| JsValue::from_str(v.0.as_ref()))
            .unwrap_or(JsValue::NULL))
    }

    #[wasm_bindgen(js_name = "getMetricAttr")]
    pub fn get_metric_attr(&self, span_id: u64, name: &str) -> Result<JsValue, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(span_id).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(span.metrics.get(name)
            .map(|v| JsValue::from_f64(*v))
            .unwrap_or(JsValue::NULL))
    }

    #[wasm_bindgen(js_name = "getError")]
    pub fn get_error(&self, span_id: u64) -> Result<i32, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(span_id).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(span.error)
    }

    // start/duration are i64 nanoseconds. Returning them as JS BigInt (not
    // f64) preserves full precision — real epoch-ns values exceed 2^53 and
    // would be silently truncated as f64.
    #[wasm_bindgen(js_name = "getStart")]
    pub fn get_start(&self, span_id: u64) -> Result<i64, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(span_id).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(span.start)
    }

    #[wasm_bindgen(js_name = "getDuration")]
    pub fn get_duration(&self, span_id: u64) -> Result<i64, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(span_id).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(span.duration)
    }

    #[wasm_bindgen(js_name = "getType")]
    pub fn get_type(&self, span_id: u64) -> Result<String, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(span_id).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(span.r#type.to_string())
    }

    #[wasm_bindgen(js_name = "getName")]
    pub fn get_name(&self, span_id: u64) -> Result<String, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(span_id).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(span.name.to_string())
    }

    // `meta_struct` carries msgpack-encoded structured data (e.g. AppSec, Code
    // Origin, Dynamic Instrumentation). There is no change-buffer opcode for it,
    // so the value is written directly onto the span after draining the queue —
    // meta_struct does not depend on any other queued op, so bypassing the queue
    // ordering is safe (subsequent ops are applied on the next flush and never
    // touch meta_struct).
    #[wasm_bindgen(js_name = "setMetaStruct")]
    pub fn set_meta_struct(
        &self,
        span_id: u64,
        key: &str,
        value: &[u8],
    ) -> Result<(), JsValue> {
        self.flush_change_queue()?;
        let mut cbs = self.cbs.borrow_mut();
        let span = cbs
            .span_mut(span_id)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        span.meta_struct
            .insert(key.into(), span_bytes::SpanBytesImpl(value.to_vec()));
        Ok(())
    }

    #[wasm_bindgen(js_name = "getMetaStruct")]
    pub fn get_meta_struct(&self, span_id: u64, key: &str) -> Result<JsValue, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        let span = cbs.get_span(span_id).map_err(|e| JsValue::from_str(&e.to_string()))?;
        // VecMap::get accepts &str directly (SpanString: Borrow<str>).
        Ok(span.meta_struct.get(key)
            .map(|v| JsValue::from(js_sys::Uint8Array::from(v.0.as_slice())))
            .unwrap_or(JsValue::NULL))
    }

    // Trace-level attributes live on the Segment (keyed by segment_id, which
    // JS allocates and shares across spans in the same local trace).
    #[wasm_bindgen(js_name = "getTraceMetaAttr")]
    pub fn get_trace_meta_attr(&self, segment_id: u64, name: &str) -> Result<JsValue, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        Ok(cbs.get_segment(&segment_id)
            .and_then(|s| s.meta.get(name))
            .map(|v| JsValue::from_str(v.0.as_ref()))
            .unwrap_or(JsValue::NULL))
    }

    #[wasm_bindgen(js_name = "getTraceMetricAttr")]
    pub fn get_trace_metric_attr(&self, segment_id: u64, name: &str) -> Result<JsValue, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        Ok(cbs.get_segment(&segment_id)
            .and_then(|s| s.metrics.get(name))
            .map(|v| JsValue::from_f64(*v))
            .unwrap_or(JsValue::NULL))
    }

    #[wasm_bindgen(js_name = "getTraceOrigin")]
    pub fn get_trace_origin(&self, segment_id: u64) -> Result<JsValue, JsValue> {
        self.flush_change_queue()?;
        let cbs = self.cbs.borrow();
        Ok(cbs.get_segment(&segment_id)
            .and_then(|s| s.origin.as_ref())
            .map(|v| JsValue::from_str(v.0.as_ref()))
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

#[wasm_bindgen(js_name = "setResponseHeaderObserver")]
pub fn set_response_header_observer(observer: &JsValue) {
    libdatadog_nodejs_capabilities::http::set_response_header_observer(observer);
}
