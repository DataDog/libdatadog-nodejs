use data_pipeline::trace_exporter::agent_response::AgentResponse;
use data_pipeline::trace_exporter::TraceExporter;
use data_pipeline::trace_exporter::TraceExporterBuilder;
use std::collections::HashMap;
use std::ffi::CStr;

use datadog_trace_utils::span::Span;

mod native_span;
use native_span::*;

mod trace;

use napi::bindgen_prelude::BigInt;
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
#[repr(u64)]
pub enum OpCode {
    Create = 0,
    SetMetaAttr = 1,
    SetMetricAttr = 2,
    SetServiceName = 3,
    SetResourceName = 4,
    SetError = 5,
    SetStart = 6,
    SetDuration = 7,
    SetType = 8,
    SetName = 9,
    SetTraceMetaAttr = 10,
    SetTraceMetricsAttr = 11,
    SetTraceOrigin = 12,
    // TODO: SpanLinks, SpanEvents, StructAttr
}

impl OpCode {
    fn from_num(num: u64) -> Self {
        unsafe { std::mem::transmute(num) }
    }
}

struct BufferedOperation {
    opcode: OpCode,
    span_id: u64,
}

#[napi]
pub struct NativeSpanState {
    // TODO(bengl) currently storing change buffer as raw pointer to avoid dealing with slice lifetime.
    // This isn't ideal.
    change_buffer: *const u8, // [Length BufOp Arg0 Arg1...  BufOp Arg0 Arg1 ... ]
                              // (Length is u64 number of BufOps)
    spans: HashMap<u64, NativeSpan>,
    string_table: HashMap<u32, SpanString>,
    string_table_input: Vec<u8>,
    exporter: TraceExporter,
    pid: f64,
    tracer_service: String,
}

unsafe impl Send for NativeSpanState {}

#[napi]
impl NativeSpanState {
    #[napi(constructor)]
    pub fn new(
        url: String,
        tracer_version: String,
        lang: String,
        lang_version: String,
        lang_interpreter: String,
        change_queue_buffer: Buffer,
        string_table_input_buffer: Buffer,
        pid: f64,
        tracer_service: String,
    ) -> Self {
        let mut builder = TraceExporterBuilder::default();
        builder
            .set_url(&url)
            .set_tracer_version(&tracer_version)
            .set_language(&lang)
            .set_language_version(&lang_version)
            .set_language_interpreter(&lang_interpreter);

        NativeSpanState {
            change_buffer: change_queue_buffer.as_ref().as_ptr(),
            spans: HashMap::new(),
            string_table: HashMap::new(),
            string_table_input: string_table_input_buffer.into(),
            exporter: builder.build().unwrap(),
            pid,
            tracer_service,
        }
    }

    #[napi]
    pub async unsafe fn flush_chunk(&mut self, len: u32, first_is_local_root: bool, chunk: Buffer) -> String {
        self.flush_change_queue();
        let mut count = len;
        let mut spans_vec = Vec::with_capacity(count as usize);
        let chunk_vec: Vec<u8> = chunk.into();
        let mut index: usize = 0;
        let mut is_local_root = first_is_local_root;
        let mut is_chunk_root = true;
        while count > 0 {
            let span_id: u64 = get_num(&chunk_vec, &mut index);
            let mut span = self.spans.remove(&span_id).unwrap();
            if is_local_root {
                span.copy_in_sampling_tags();
                span.metrics.insert("_dd.top_level".into(), 1.0);
                is_local_root = false;
            }
            if is_chunk_root {
                span.copy_in_chunk_tags();
                is_chunk_root = false;
            }
            spans_vec.push(self.process_one_span(span));
            count -= 1;
        }
        let resp = self.exporter.send_trace_chunks_async(vec![spans_vec]).await;
        let response_str = resp.map(|resp| match resp {
            AgentResponse::Unchanged => "unchanged".to_string(),
            AgentResponse::Changed { body } => body,
        });

        response_str.unwrap_or("Error sending trace chunk".to_string())
    }

    #[napi]
    pub fn flush_change_queue(&mut self) -> bool {
        let mut index = 0;
        let mut count: u64 = get_num_raw(self.change_buffer, &mut index);

        while count > 0 {
            let opcode: u64 = get_num_raw(self.change_buffer, &mut index);
            let opcode = OpCode::from_num(opcode);
            let span_id: u64 = get_num_raw(self.change_buffer, &mut index);
            let op = BufferedOperation { opcode, span_id };
            self.interpret_operation(&mut index, &op);
            count -= 1;
        }

        true
    }

    fn get_mut_span(&mut self, id: &u64) -> &mut NativeSpan {
        self.spans.get_mut(id).unwrap()
    }

    fn get_span(&self, id: &u64) -> &NativeSpan {
        self.spans.get(id).unwrap()
    }

    fn get_span_bigint(&self, id: BigInt) -> &NativeSpan {
        self.get_span(&id.get_u64().1)
    }

    fn interpret_operation(&mut self, index: &mut usize, op: &BufferedOperation) {
        match op.opcode {
            OpCode::Create => {
                let trace_id = self.get_num_arg(index);
                let parent_id = self.get_num_arg(index);
                let span = NativeSpan::new(&self.spans, op.span_id, trace_id, parent_id);
                self.spans.insert(op.span_id, span);
            }
            OpCode::SetMetaAttr => {
                let name = self.get_string_arg(index);
                let val = self.get_string_arg(index);
                self.get_mut_span(&op.span_id).meta.insert(name, val);
            }
            OpCode::SetMetricAttr => {
                let name = self.get_string_arg(index);
                let val = self.get_num_arg(index);
                self.get_mut_span(&op.span_id).metrics.insert(name, val);
            }
            OpCode::SetServiceName => {
                self.get_mut_span(&op.span_id).service = self.get_string_arg(index);
            }
            OpCode::SetResourceName => {
                self.get_mut_span(&op.span_id).resource = self.get_string_arg(index);
            }
            OpCode::SetError => {
                self.get_mut_span(&op.span_id).error = self.get_num_arg(index);
            }
            OpCode::SetStart => {
                self.get_mut_span(&op.span_id).start = self.get_num_arg(index);
            }
            OpCode::SetDuration => {
                self.get_mut_span(&op.span_id).duration = self.get_num_arg(index);
            }
            OpCode::SetType => {
                self.get_mut_span(&op.span_id).r#type = self.get_string_arg(index);
            }
            OpCode::SetName => {
                self.get_mut_span(&op.span_id).name = self.get_string_arg(index);
            }
            OpCode::SetTraceMetaAttr => {
                let name = self.get_string_arg(index);
                let val = self.get_string_arg(index);

                let span = self.get_mut_span(&op.span_id);
                span.trace.borrow_mut().meta.insert(name, val);
            }
            OpCode::SetTraceMetricsAttr => {
                let name = self.get_string_arg(index);
                let val = self.get_num_arg(index);

                let span = self.get_mut_span(&op.span_id);
                span.trace.borrow_mut().metrics.insert(name, val);
            }
            OpCode::SetTraceOrigin => {
                let origin = self.get_string_arg(index);
                let span = self.get_mut_span(&op.span_id);
                span.trace.borrow_mut().origin = Some(origin);
            }
        };
    }

    fn get_string_arg(&self, index: &mut usize) -> SpanString {
        let num: u32 = self.get_num_arg(index);
        self.string_table.get(&num).unwrap().clone()
    }

    fn get_num_arg<T: Copy + FromBytes>(&self, index: &mut usize) -> T {
        get_num_raw(self.change_buffer, index)
    }

    #[napi]
    pub fn string_table_insert_one(&mut self, key: u32, val: String) {
        self.string_table.insert(key, val.into());
    }

    #[napi]
    pub fn string_table_insert_many(&mut self, count: u32) {
        let mut index: usize = 0;
        let mut remaining = count as usize;
        while remaining > 0 {
            let key: u32 = get_num(&self.string_table_input, &mut index);
            let str_slice = &self.string_table_input[index..];
            let val = unsafe {
                CStr::from_ptr(str_slice.as_ptr() as *const _)
                    .to_str()
                    .unwrap()
            }
            .to_owned();
            index += val.len();
            self.string_table.insert(key, val.into());
            remaining -= 1;
        }
    }

    #[napi]
    pub fn string_table_evict(&mut self, key: u32) {
        self.string_table.remove(&key);
    }

    #[napi]
    pub fn get_service_name(&mut self, id: BigInt) -> String {
        self.flush_change_queue();
        self.get_span_bigint(id).service.0.clone()
    }

    #[napi]
    pub fn get_resource_name(&mut self, id: BigInt) -> String {
        self.flush_change_queue();
        self.get_span_bigint(id).resource.0.clone()
    }

    #[napi]
    pub fn get_meta_attr(&mut self, id: BigInt, name: String) -> String {
        self.flush_change_queue();
        let name: SpanString = name.clone().into();
        let result = self.get_span_bigint(id).meta.get(&name).unwrap();
        result.0.clone()
    }

    #[napi]
    pub fn get_metric_attr(&mut self, id: BigInt, name: String) -> f64 {
        self.flush_change_queue();
        let name: SpanString = name.clone().into();
        let result = self.get_span_bigint(id).metrics.get(&name).unwrap();
        result.clone()
    }

    #[napi]
    pub fn get_error(&mut self, id: BigInt) -> i32 {
        self.flush_change_queue();
        self.get_span_bigint(id).error
    }

    #[napi]
    pub fn get_start(&mut self, id: BigInt) -> i64 {
        self.flush_change_queue();
        self.get_span_bigint(id).start
    }

    #[napi]
    pub fn get_duration(&mut self, id: BigInt) -> i64 {
        self.flush_change_queue();
        self.get_span_bigint(id).duration
    }

    #[napi]
    pub fn get_type(&mut self, id: BigInt) -> String {
        self.flush_change_queue();
        self.get_span_bigint(id).r#type.0.clone()
    }

    #[napi]
    pub fn get_name(&mut self, id: BigInt) -> String {
        self.flush_change_queue();
        self.get_span_bigint(id).name.0.clone()
    }

    fn process_one_span(&self, mut span: NativeSpan) -> Span<SpanString> {
        let kind_key: SpanString = "kind".into();
        if let Some(kind) = span.meta.get(&kind_key) {
            let internal_val = String::from("internal");
            if kind.0 != internal_val {
                span.metrics
                    .insert("_dd.measured".into(), 1.0);
            }
        }
        if span.service.0 != self.tracer_service {
            span.meta.insert(
                "_dd.base_service".into(),
                self.tracer_service.clone().into(),
            );
            // TODO span.service should be added to the "extra services" used by RC, which is not
            // yet imlemented here on the Rust side.
        }

        // SKIP setting single-span ingestion tags. They should be set when sampling is finalized
        // for the span.

        span.meta.insert("language".into(), "javascript".into());
        span.metrics
            .insert("process_id".into(), self.pid);
        let origin = &span.trace.borrow().origin.clone();
        if let Some(origin) = origin {
            span.meta.insert("_dd.origin".into(), origin.clone());
        }
        // SKIP hostname. This can be an option to the span constructor, so we'll set the tag at
        // that point.

        // TODO Sampling priority, if we're not doing that ahead of time.
        span.span
    }
}

trait FromBytes: Sized {
    type Bytes: ?Sized;
    fn from_bytes(bytes: &[u8]) -> Self;
}

macro_rules! impl_from_bytes {
    ($ty:ty, $len:expr) => {
        impl FromBytes for $ty {
            type Bytes = $ty;

            // Note that this always does a copy into a new variable. This is
            // because the values in the buffer are not aligned. We could save
            // ourselves a copy by ensuring alignment from the managed side.
            fn from_bytes(bytes: &[u8]) -> Self {
                let mut code_buf = [0u8; $len];
                code_buf.copy_from_slice(bytes);
                <$ty>::from_le_bytes(code_buf)
            }
        }
    };
}

impl_from_bytes!(u128, 16);
impl_from_bytes!(u64, 8);
impl_from_bytes!(f64, 8);
impl_from_bytes!(i64, 8);
impl_from_bytes!(i32, 4);
impl_from_bytes!(u32, 4);

fn get_num<T: Copy + FromBytes>(buf: &Vec<u8>, index: &mut usize) -> T {
    let id: usize = index.clone();
    let size = std::mem::size_of::<T>();
    let result = &buf[id..(id + size)];
    let result: T = T::from_bytes(&result);
    *index += size;
    result
}

fn get_num_raw<T: Copy + FromBytes>(buf: *const u8, index: &mut usize) -> T {
    let size = std::mem::size_of::<T>();
    let result: &[u8] =
        unsafe { std::slice::from_raw_parts((buf as usize + *index) as *const u8, size) };
    let result = T::from_bytes(result);
    *index += size;
    result
}
