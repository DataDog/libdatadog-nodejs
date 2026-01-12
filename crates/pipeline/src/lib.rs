use libdd_data_pipeline::trace_exporter::agent_response::AgentResponse;
use libdd_data_pipeline::trace_exporter::TraceExporter;
use libdd_data_pipeline::trace_exporter::TraceExporterBuilder;
use std::ffi::CStr;

use napi::bindgen_prelude::BigInt;
use napi::bindgen_prelude::*;
use napi_derive::napi;

mod span_string;
use span_string::*;

use libdd_trace_utils::change_buffer::{ChangeBuffer, ChangeBufferState};
use libdd_trace_utils::span::Span;

mod utils;
use utils::*;

#[napi]
pub struct NativeSpanState {
    // (Length is u64 number of BufOps)
    string_table_input: Vec<u8>,
    exporter: TraceExporter,
    // sampling_buffer: SendPtr,
    change_buffer_state: ChangeBufferState<SpanString>,
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
        // sampling_buffer: Buffer,
    ) -> Result<Self> {
        let mut builder = TraceExporterBuilder::default();
        builder
            .set_url(&url)
            .set_tracer_version(&tracer_version)
            .set_language(&lang)
            .set_language_version(&lang_version)
            .set_language_interpreter(&lang_interpreter);

        let buf = change_queue_buffer.as_ref();
        let change_buffer = unsafe { ChangeBuffer::from_raw_parts(buf.as_ref().as_ptr(), buf.len()) };
        let change_buffer_state =
            ChangeBufferState::new(change_buffer, tracer_service.into(), lang.into(), pid);
        Ok(NativeSpanState {
            change_buffer_state,
            string_table_input: string_table_input_buffer.into(),
            exporter: builder
                .build()
                .map_err(|e| Error::new(Status::GenericFailure, format!("{}", e)))?,
            // sampling_buffer: SendPtr(sampling_buffer.as_ref().as_ptr()),
        })
    }

    #[napi]
    pub async unsafe fn flush_chunk(
        &mut self,
        len: u32,
        first_is_local_root: bool,
        chunk: Buffer,
    ) -> Result<String> {
        self.change_buffer_state
            .flush_change_buffer()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let mut count = len;
        let mut index = 0;
        let chunk_vec: Vec<u8> = chunk.into();
        let mut span_ids = Vec::with_capacity(count as usize);
        while count > 0 {
            let span_id: u64 = get_num(&chunk_vec, &mut index);
            span_ids.push(span_id);
            count -= 1;
        }

        let spans_vec = self
            .change_buffer_state
            .flush_chunk(span_ids, first_is_local_root)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let resp = self.exporter.send_trace_chunks_async(vec![spans_vec]).await;
        let response_str = resp.map(|resp| match resp {
            AgentResponse::Unchanged => "unchanged".to_string(),
            AgentResponse::Changed { body } => body,
        });

        response_str.map_err(|e| Error::new(Status::GenericFailure, format!("{}", e)))
    }

    #[napi]
    pub fn flush_change_queue(&mut self) -> Result<bool> {
        self.change_buffer_state
            .flush_change_buffer()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        Ok(true)
    }

    #[napi]
    pub fn sample(&mut self) -> Result<bool> {
        // self.flush_change_queue()?;
        // let span_id: u64 = get_num_raw(*self.sampling_buffer, &mut 0);
        // let span = self.get_mut_span(&span_id);
        // let result = span?.sample();
        // if let Some(result) = result {
        //     let buf_mut = *self.sampling_buffer as *mut u8;
        //     unsafe {
        //         std::ptr::copy_nonoverlapping(result.as_ptr(), buf_mut, result.len());
        //     }
        // }
        // Ok(result.is_some())

        Ok(true)
    }

    fn get_span_bigint(&self, id: BigInt) -> Result<&Span<SpanString>> {
        self.change_buffer_state
            .get_span(&id.get_u64().1)
            .map_err(|x| Error::from_reason(x.to_string()))
    }

    #[napi]
    pub fn string_table_insert_one(&mut self, key: u32, val: String) {
        self.change_buffer_state
            .string_table_insert_one(key, val.into());
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
            self.change_buffer_state
                .string_table_insert_one(key, val.into());
            remaining -= 1;
        }

        Ok(())
    }

    #[napi]
    pub fn string_table_evict(&mut self, key: u32) {
        self.change_buffer_state.string_table_evict_one(key);
    }

    #[napi]
    pub fn get_service_name(&mut self, id: BigInt) -> Result<String> {
        self.flush_change_queue()?;
        Ok(self.get_span_bigint(id)?.service.to_string())
    }

    #[napi]
    pub fn get_resource_name(&mut self, id: BigInt) -> Result<String> {
        self.flush_change_queue()?;
        Ok(self.get_span_bigint(id)?.resource.to_string())
    }

    #[napi]
    pub fn get_meta_attr(&mut self, id: BigInt, name: String) -> Result<Option<String>> {
        self.flush_change_queue()?;
        let name: SpanString = name.into();
        Ok(self
            .get_span_bigint(id)?
            .meta
            .get(&name)
            .map(|v| v.to_string()))
    }

    #[napi]
    pub fn get_metric_attr(&mut self, id: BigInt, name: String) -> Result<Option<f64>> {
        self.flush_change_queue()?;
        let name: SpanString = name.into();
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
        Ok(self.get_span_bigint(id)?.r#type.to_string())
    }

    #[napi]
    pub fn get_name(&mut self, id: BigInt) -> Result<String> {
        self.flush_change_queue()?;
        Ok(self.get_span_bigint(id)?.name.to_string())
    }

    #[napi]
    pub fn get_trace_meta_attr(&mut self, id: BigInt, name: String) -> Result<Option<String>> {
        self.flush_change_queue()?;
        let trace_id = self.get_span_bigint(id)?.trace_id;
        let name: SpanString = name.into();
        Ok(self
            .change_buffer_state
            .get_trace(&trace_id)
            .and_then(|t| t.meta.get(&name))
            .map(|v| v.to_string()))
    }

    #[napi]
    pub fn get_trace_metric_attr(&mut self, id: BigInt, name: String) -> Result<Option<f64>> {
        self.flush_change_queue()?;
        let trace_id = self.get_span_bigint(id)?.trace_id;
        let name: SpanString = name.into();
        Ok(self
            .change_buffer_state
            .get_trace(&trace_id)
            .and_then(|t| t.metrics.get(&name))
            .copied())
    }

    #[napi]
    pub fn get_trace_origin(&mut self, id: BigInt) -> Result<Option<String>> {
        self.flush_change_queue()?;
        let trace_id = self.get_span_bigint(id)?.trace_id;
        Ok(self
            .change_buffer_state
            .get_trace(&trace_id)
            .and_then(|t| t.origin.as_ref())
            .map(|v| v.to_string()))
    }
}
