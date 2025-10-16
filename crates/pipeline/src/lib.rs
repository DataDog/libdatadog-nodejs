use data_pipeline::trace_exporter::agent_response::AgentResponse;
use data_pipeline::trace_exporter::TraceExporter;
use data_pipeline::trace_exporter::TraceExporterBuilder;
use serde::Serialize;
use std::borrow::Borrow;
use std::collections::HashMap;
use std::ffi::CStr;

use datadog_trace_utils::span::{Span, SpanText};

use napi::bindgen_prelude::*;
use napi::bindgen_prelude::BigInt;
use napi_derive::napi;

#[derive(Default, Eq, PartialEq, Serialize, Hash, Clone)]
struct SpanString(String);

impl Borrow<str> for SpanString {
    fn borrow(&self) -> &str {
        self.0.as_str()
    }
}

impl SpanText for SpanString {
    fn from_static_str(value: &'static str) -> Self {
        SpanString(String::from(value))
    }
}

impl From<String> for SpanString {
    fn from(s: String) -> SpanString {
        SpanString(s)
    }
}

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
    SetName = 9
    // TODO: SpanLinks, SpanEvents, StructAttr
}

impl OpCode {
    fn from_num(num: u64) -> Self {
        unsafe { std::mem::transmute(num) }
    }
}

#[repr(C)]
struct BufferedOperation {
    opcode: OpCode,
    span_id: u64,
}

#[napi]
pub struct NativeSpanState {
    // TODO(bengl) currently storing change buffer as raw pointer to avoid dealing with slice lifetime.
    // This isn't ideal.
    change_buffer: *const u8, // [BufOp Arg0 Arg1...  BufOp Arg0 Arg1 ... ]
    spans: HashMap<u64, Span<SpanString>>,
    string_table: HashMap<u32, SpanString>,
    string_table_input: Vec<u8>,
    exporter: TraceExporter
}

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
        }
    }

    #[napi]
    pub fn flush_chunk(&mut self, len: u32, chunk: Buffer) -> String {
        let mut count = len;
        let mut spans_vec = Vec::with_capacity(count as usize);
        let chunk_vec: Vec<u8> = chunk.into();
        let mut index: usize = 0;
        while count > 0 {
            let span_id: u64 = get_num(&chunk_vec, &mut index);
            spans_vec.push(self.spans.remove(&span_id).unwrap());
            count -= 1;
        }
        // TODO(bengl) we need an async version of this.
        let resp = self.exporter.send_trace_chunks(vec![spans_vec]);
        let response_str = resp.map(|resp| match resp {
            AgentResponse::Unchanged => "unchanged".to_string(),
            AgentResponse::Changed { body } => body,
        });

        response_str.unwrap_or("Error sending trace chunk".to_string())
    }

    #[napi]
    pub fn flush_change_queue(&mut self, operation_count: u32) -> bool {
        let mut count = operation_count;
        let mut index = 0;

        while count > 0 {
            let opcode: u64 = get_num_raw(self.change_buffer, &mut index);
            let opcode = OpCode::from_num(opcode);
            let span_id: u64 = get_num_raw(self.change_buffer, &mut index);
            let op = BufferedOperation {
                opcode,
                span_id
            };
            self.interpret_operation(&mut index, &op);
            count -= 1;
        }

        true
    }

    fn get_mut_span(&mut self, id: &u64) -> &mut Span<SpanString> {
        self.spans.get_mut(id).unwrap()
    }

    fn get_span(&self, id: &u64) -> &Span<SpanString> {
        self.spans.get(id).unwrap()
    }

    fn interpret_operation(&mut self, index: &mut usize, op: &BufferedOperation) {
        match op.opcode {
            OpCode::Create => {
                self.spans.insert(
                    op.span_id,
                    Span::<SpanString> {
                        span_id: op.span_id,
                        trace_id: self.get_num_arg(index),
                        parent_id: self.get_num_arg(index),
                        ..Default::default()
                    },
                );
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
            },
            OpCode::SetName => {
                self.get_mut_span(&op.span_id).name = self.get_string_arg(index);
            }//_ => panic!("Unsupported opcode")
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
    pub fn get_service_name(&self, id: BigInt) -> String {
        self.get_span(&id.get_u64().1).service.0.clone()
    }

    #[napi]
    pub fn get_resource_name(&self, id: BigInt) -> String {
        self.get_span(&id.get_u64().1).resource.0.clone()
    }

    // TODO(bengl) all read operations
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
    }
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
    let result = &buf[id..(id+size)];
    let result: T = T::from_bytes(&result);
    *index += size;
    result
}

fn get_num_raw<T: Copy + FromBytes>(buf: *const u8, index: &mut usize) -> T {
    let size = std::mem::size_of::<T>();
    let result: &[u8] = unsafe {
        std::slice::from_raw_parts((buf as usize + *index) as *const u8, size)
    };
    let result = T::from_bytes(result);
    *index += size;
    result
}

