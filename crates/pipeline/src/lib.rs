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

mod change_buffer;
use change_buffer::{OpCode, BufferedOperation};

mod utils;
use utils::*;


#[napi]
pub struct NativeSpanState {
    change_buffer: Vec<u8>, // [Length BufOp Arg0 Arg1...  BufOp Arg0 Arg1 ... ]
    // (Length is u64 number of BufOps)
    spans: HashMap<u64, NativeSpan>,
    string_table: HashMap<u32, SpanString>,
    string_table_input: Vec<u8>,
    exporter: TraceExporter,
    pid: f64,
    tracer_service: String,
    sampling_buffer: Vec<u8>,
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
        sampling_buffer: Buffer,
    ) -> Result<Self> {
        let mut builder = TraceExporterBuilder::default();
        builder
            .set_url(&url)
            .set_tracer_version(&tracer_version)
            .set_language(&lang)
            .set_language_version(&lang_version)
            .set_language_interpreter(&lang_interpreter);

        Ok(NativeSpanState {
            change_buffer: change_queue_buffer.into(),
            spans: HashMap::new(),
            string_table: HashMap::new(),
            string_table_input: string_table_input_buffer.into(),
            exporter: builder
                .build()
                .map_err(|e| Error::new(Status::GenericFailure, format!("{}", e)))?,
            pid,
            tracer_service,
            sampling_buffer: sampling_buffer.into(),
        })
    }

    #[napi]
    pub async unsafe fn flush_chunk(
        &mut self,
        len: u32,
        first_is_local_root: bool,
        chunk: Buffer,
    ) -> Result<String> {
        self.flush_change_queue()?;
        let mut count = len;
        let mut spans_vec = Vec::with_capacity(count as usize);
        let chunk_vec: Vec<u8> = chunk.into();
        let mut index: usize = 0;
        let mut is_local_root = first_is_local_root;
        let mut is_chunk_root = true;
        while count > 0 {
            let span_id: u64 = get_num(&chunk_vec, &mut index);
            let maybe_span = self.spans.remove(&span_id);

            let mut span = maybe_span.ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    format!("span not found internally: {}", span_id),
                )
            })?;
            if is_local_root {
                span.copy_in_sampling_tags();
                span.set_metric("_dd.top_level", 1);
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

        response_str.map_err(|e| Error::new(Status::GenericFailure, format!("{}", e)))
    }

    #[napi]
    pub fn flush_change_queue(&mut self) -> Result<bool> {
        let mut index = 0;
        let mut count: u64 = get_num_raw(&self.change_buffer, &mut index);

        while count > 0 {
            let op = BufferedOperation::from_buf(&self.change_buffer, &mut index);
            self.interpret_operation(&mut index, &op)?;
            count -= 1;
        }

        Ok(true)
    }

    #[napi]
    pub fn sample(&mut self) -> Result<bool> {
        self.flush_change_queue()?;
        let span_id: u64 = get_num(&self.sampling_buffer, &mut 0);
        let span = self.get_mut_span(&span_id);
        let result = span?.sample();
        if let Some(result) = result {
            for (i, elem) in result.iter().enumerate() {
                self.sampling_buffer[i] = *elem;
            }
        }
        Ok(result.is_some())
    }

    fn get_mut_span(&mut self, id: &u64) -> Result<&mut NativeSpan> {
        self.spans.get_mut(id).ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                format!("span not found internally: {}", id),
            )
        })
    }

    fn get_span(&self, id: &u64) -> Result<&NativeSpan> {
        self.spans.get(id).ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                format!("span not found internally: {}", id),
            )
        })
    }

    fn get_span_bigint(&self, id: BigInt) -> Result<&NativeSpan> {
        self.get_span(&id.get_u64().1)
    }

    fn interpret_operation(&mut self, index: &mut usize, op: &BufferedOperation) -> Result<()> {
        match op.opcode {
            OpCode::Create => {
                let trace_id = self.get_num_arg(index);
                let parent_id = self.get_num_arg(index);
                let span = NativeSpan::new(&self.spans, op.span_id, trace_id, parent_id);
                self.spans.insert(op.span_id, span);
            }
            OpCode::SetMetaAttr => {
                let name = self.get_string_arg(index)?;
                let val = self.get_string_arg(index)?;
                self.get_mut_span(&op.span_id)?.set_meta(name, val);
            }
            OpCode::SetMetricAttr => {
                let name = self.get_string_arg(index)?;
                let val: f64 = self.get_num_arg(index);
                self.get_mut_span(&op.span_id)?.set_metric(name, val);
            }
            OpCode::SetServiceName => {
                self.get_mut_span(&op.span_id)?.service = self.get_string_arg(index)?;
            }
            OpCode::SetResourceName => {
                self.get_mut_span(&op.span_id)?.resource = self.get_string_arg(index)?;
            }
            OpCode::SetError => {
                self.get_mut_span(&op.span_id)?.error = self.get_num_arg(index);
            }
            OpCode::SetStart => {
                self.get_mut_span(&op.span_id)?.start = self.get_num_arg(index);
            }
            OpCode::SetDuration => {
                self.get_mut_span(&op.span_id)?.duration = self.get_num_arg(index);
            }
            OpCode::SetType => {
                self.get_mut_span(&op.span_id)?.r#type = self.get_string_arg(index)?;
            }
            OpCode::SetName => {
                self.get_mut_span(&op.span_id)?.name = self.get_string_arg(index)?;
            }
            OpCode::SetTraceMetaAttr => {
                let name = self.get_string_arg(index)?;
                let val = self.get_string_arg(index)?;

                let span = self.get_mut_span(&op.span_id)?;
                span.trace.borrow_mut().meta.insert(name, val);
            }
            OpCode::SetTraceMetricsAttr => {
                let name = self.get_string_arg(index)?;
                let val = self.get_num_arg(index);

                let span = self.get_mut_span(&op.span_id)?;
                span.trace.borrow_mut().metrics.insert(name, val);
            }
            OpCode::SetTraceOrigin => {
                let origin = self.get_string_arg(index)?;
                let span = self.get_mut_span(&op.span_id)?;
                span.trace.borrow_mut().origin = Some(origin);
            }
        };

        Ok(())
    }

    fn get_string_arg(&self, index: &mut usize) -> Result<SpanString> {
        let num: u32 = self.get_num_arg(index);
        self.string_table.get(&num).cloned().ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                format!("string not found internally: {}", num),
            )
        })
    }

    fn get_num_arg<T: Copy + FromBytes>(&self, index: &mut usize) -> T {
        get_num_raw(&self.change_buffer, index)
    }

    #[napi]
    pub fn string_table_insert_one(&mut self, key: u32, val: String) {
        self.string_table.insert(key, val.into());
    }

    #[napi]
    pub fn string_table_insert_many(&mut self, count: u32) -> Result<()> {
        let mut index: usize = 0;
        let mut remaining = count as usize;
        while remaining > 0 {
            let key: u32 = get_num(&self.string_table_input, &mut index);
            let str_slice = &self.string_table_input[index..];
            let val = unsafe {
                CStr::from_ptr(str_slice.as_ptr() as *const _)
                    .to_str()
                    .map_err(|e| Error::new(Status::GenericFailure, format!("{}", e)))?
            }
            .to_owned();
            index += val.len();
            self.string_table.insert(key, val.into());
            remaining -= 1;
        }

        Ok(())
    }

    #[napi]
    pub fn string_table_evict(&mut self, key: u32) {
        self.string_table.remove(&key);
    }

    #[napi]
    pub fn get_service_name(&mut self, id: BigInt) -> Result<String> {
        self.flush_change_queue()?;
        Ok(self.get_span_bigint(id)?.service.0.clone())
    }

    #[napi]
    pub fn get_resource_name(&mut self, id: BigInt) -> Result<String> {
        self.flush_change_queue()?;
        Ok(self.get_span_bigint(id)?.resource.0.clone())
    }

    #[napi]
    pub fn get_meta_attr(&mut self, id: BigInt, name: String) -> Result<Option<String>> {
        self.flush_change_queue()?;
        let name: SpanString = name.clone().into();
        Ok(self
            .get_span_bigint(id)?
            .meta
            .get(&name)
            .map(|v| v.0.clone()))
    }

    #[napi]
    pub fn get_metric_attr(&mut self, id: BigInt, name: String) -> Result<Option<f64>> {
        self.flush_change_queue()?;
        let name: SpanString = name.clone().into();
        Ok(self.get_span_bigint(id)?.metrics.get(&name).copied())
    }

    #[napi]
    pub fn get_error(&mut self, id: BigInt) -> Result<i32> {
        self.flush_change_queue()?;
        Ok(self.get_span_bigint(id)?.error)
    }

    #[napi]
    pub fn get_start(&mut self, id: BigInt) -> Result<i64> {
        self.flush_change_queue()?;
        Ok(self.get_span_bigint(id)?.start)
    }

    #[napi]
    pub fn get_duration(&mut self, id: BigInt) -> Result<i64> {
        self.flush_change_queue()?;
        Ok(self.get_span_bigint(id)?.duration)
    }

    #[napi]
    pub fn get_type(&mut self, id: BigInt) -> Result<String> {
        self.flush_change_queue()?;
        Ok(self.get_span_bigint(id)?.r#type.0.clone())
    }

    #[napi]
    pub fn get_name(&mut self, id: BigInt) -> Result<String> {
        self.flush_change_queue()?;
        Ok(self.get_span_bigint(id)?.name.0.clone())
    }

    fn process_one_span(&self, mut span: NativeSpan) -> Span<SpanString> {
        // TODO Is this the correct time to do this? In the JS implementation, this is done on span
        // finish. Maybe this is equivalent enough? When does sampling _have_ to be done?
        span.sample();

        let kind_key: SpanString = "kind".into();
        if let Some(kind) = span.meta.get(&kind_key) {
            let internal_val = String::from("internal");
            if kind.0 != internal_val {
                span.set_metric("_dd.measured", 1);
            }
        }
        if span.service.0 != self.tracer_service {
            span.set_meta("_dd.base_service", self.tracer_service.clone());
            // TODO span.service should be added to the "extra services" used by RC, which is not
            // yet imlemented here on the Rust side.
        }

        // SKIP setting single-span ingestion tags. They should be set when sampling is finalized
        // for the span.

        span.set_meta("language", "javascript");
        span.set_metric("process_id", self.pid);
        let origin = &span.trace.borrow().origin.clone();
        if let Some(origin) = origin {
            span.set_meta("_dd.origin", origin.clone());
        }
        // SKIP hostname. This can be an option to the span constructor, so we'll set the tag at
        // that point.

        // TODO Sampling priority, if we're not doing that ahead of time.
        span.span
    }
}
