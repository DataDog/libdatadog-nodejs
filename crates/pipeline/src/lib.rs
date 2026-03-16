use libdatadog_nodejs_capabilities::WasmCapabilities;
use libdd_data_pipeline::trace_exporter::agent_response::AgentResponse;
use libdd_data_pipeline::trace_exporter::TraceExporter;
use std::ffi::CStr;

use wasm_bindgen::prelude::*;

mod span_string;
use span_string::*;

mod span_bytes;

mod trace_data;
use trace_data::*;

use libdd_trace_utils::change_buffer::{ChangeBuffer, ChangeBufferState};

mod utils;
use utils::*;

#[wasm_bindgen(start)]
fn init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct WasmSpanState {
    change_queue: Vec<u8>,
    string_table_input: Vec<u8>,
    exporter: TraceExporter<WasmCapabilities>,
    change_buffer_state: ChangeBufferState<WasmTraceData>,
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
    ) -> Result<WasmSpanState, JsValue> {
        let mut builder = TraceExporter::<WasmCapabilities>::builder();
        builder
            .set_url(url)
            .set_tracer_version(tracer_version)
            .set_language(lang)
            .set_language_version(lang_version)
            .set_language_interpreter(lang_interpreter);

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

        Ok(WasmSpanState {
            change_queue,
            string_table_input: vec![0u8; string_table_input_size as usize],
            exporter,
            change_buffer_state,
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

    #[wasm_bindgen(js_name = "flushChunk")]
    pub async fn flush_chunk(
        &mut self,
        len: u32,
        first_is_local_root: bool,
        chunk: &[u8],
    ) -> Result<JsValue, JsValue> {
        self.change_buffer_state
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
            .change_buffer_state
            .flush_chunk(span_ids, first_is_local_root)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        let resp = self
            .exporter
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

    #[wasm_bindgen(js_name = "flushChangeQueue")]
    pub fn flush_change_queue(&mut self) -> Result<bool, JsValue> {
        self.change_buffer_state
            .flush_change_buffer()
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(true)
    }

    #[wasm_bindgen(js_name = "stringTableInsertOne")]
    pub fn string_table_insert_one(&mut self, key: u32, val: &str) {
        self.change_buffer_state
            .string_table_insert_one(key, val.into());
    }

    #[wasm_bindgen(js_name = "stringTableInsertMany")]
    pub fn string_table_insert_many(&mut self, count: u32) -> Result<(), JsValue> {
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
            self.change_buffer_state
                .string_table_insert_one(key, val.into());
            remaining -= 1;
        }
        Ok(())
    }

    #[wasm_bindgen(js_name = "stringTableEvict")]
    pub fn string_table_evict(&mut self, key: u32) {
        self.change_buffer_state.string_table_evict_one(key);
    }

    fn get_span_f64(&self, id: f64) -> Result<&libdd_trace_utils::span::v04::Span<WasmTraceData>, JsValue> {
        let span_id = id as u64;
        self.change_buffer_state
            .get_span(&span_id)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = "getServiceName")]
    pub fn get_service_name(&mut self, id: f64) -> Result<String, JsValue> {
        self.flush_change_queue()?;
        Ok(self.get_span_f64(id)?.service.to_string())
    }

    #[wasm_bindgen(js_name = "getResourceName")]
    pub fn get_resource_name(&mut self, id: f64) -> Result<String, JsValue> {
        self.flush_change_queue()?;
        Ok(self.get_span_f64(id)?.resource.to_string())
    }

    #[wasm_bindgen(js_name = "getMetaAttr")]
    pub fn get_meta_attr(&mut self, id: f64, name: &str) -> Result<JsValue, JsValue> {
        self.flush_change_queue()?;
        let name: SpanString = name.into();
        Ok(self
            .get_span_f64(id)?
            .meta
            .get(&name)
            .map(|v| JsValue::from_str(&v.to_string()))
            .unwrap_or(JsValue::NULL))
    }

    #[wasm_bindgen(js_name = "getMetricAttr")]
    pub fn get_metric_attr(&mut self, id: f64, name: &str) -> Result<JsValue, JsValue> {
        self.flush_change_queue()?;
        let name: SpanString = name.into();
        Ok(self
            .get_span_f64(id)?
            .metrics
            .get(&name)
            .map(|v| JsValue::from_f64(*v))
            .unwrap_or(JsValue::NULL))
    }

    #[wasm_bindgen(js_name = "getError")]
    pub fn get_error(&mut self, id: f64) -> Result<i32, JsValue> {
        self.flush_change_queue()?;
        Ok(self.get_span_f64(id)?.error)
    }

    #[wasm_bindgen(js_name = "getStart")]
    pub fn get_start(&mut self, id: f64) -> Result<f64, JsValue> {
        self.flush_change_queue()?;
        Ok(self.get_span_f64(id)?.start as f64)
    }

    #[wasm_bindgen(js_name = "getDuration")]
    pub fn get_duration(&mut self, id: f64) -> Result<f64, JsValue> {
        self.flush_change_queue()?;
        Ok(self.get_span_f64(id)?.duration as f64)
    }

    #[wasm_bindgen(js_name = "getType")]
    pub fn get_type(&mut self, id: f64) -> Result<String, JsValue> {
        self.flush_change_queue()?;
        Ok(self.get_span_f64(id)?.r#type.to_string())
    }

    #[wasm_bindgen(js_name = "getName")]
    pub fn get_name(&mut self, id: f64) -> Result<String, JsValue> {
        self.flush_change_queue()?;
        Ok(self.get_span_f64(id)?.name.to_string())
    }

    #[wasm_bindgen(js_name = "getTraceMetaAttr")]
    pub fn get_trace_meta_attr(&mut self, id: f64, name: &str) -> Result<JsValue, JsValue> {
        self.flush_change_queue()?;
        let trace_id = self.get_span_f64(id)?.trace_id;
        let name: SpanString = name.into();
        Ok(self
            .change_buffer_state
            .get_trace(&trace_id)
            .and_then(|t| t.meta.get(&name))
            .map(|v| JsValue::from_str(&v.to_string()))
            .unwrap_or(JsValue::NULL))
    }

    #[wasm_bindgen(js_name = "getTraceMetricAttr")]
    pub fn get_trace_metric_attr(&mut self, id: f64, name: &str) -> Result<JsValue, JsValue> {
        self.flush_change_queue()?;
        let trace_id = self.get_span_f64(id)?.trace_id;
        let name: SpanString = name.into();
        Ok(self
            .change_buffer_state
            .get_trace(&trace_id)
            .and_then(|t| t.metrics.get(&name))
            .map(|v| JsValue::from_f64(*v))
            .unwrap_or(JsValue::NULL))
    }

    #[wasm_bindgen(js_name = "getTraceOrigin")]
    pub fn get_trace_origin(&mut self, id: f64) -> Result<JsValue, JsValue> {
        self.flush_change_queue()?;
        let trace_id = self.get_span_f64(id)?.trace_id;
        Ok(self
            .change_buffer_state
            .get_trace(&trace_id)
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
