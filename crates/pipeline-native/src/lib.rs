use libdd_capabilities_impl::DefaultHttpClient;
use libdd_data_pipeline::trace_exporter::agent_response::AgentResponse;
use libdd_data_pipeline::trace_exporter::TraceExporter;
use std::cell::{RefCell, UnsafeCell};
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use libdd_trace_utils::change_buffer::{ChangeBuffer, ChangeBufferState};

mod span_string;

mod span_bytes;

mod trace_data;
use trace_data::*;

// Re-use the same utils for parsing numbers from byte buffers
fn get_num<T: FromLeBytes>(buf: &[u8], index: &mut usize) -> T {
    let size = std::mem::size_of::<T>();
    let bytes = &buf[*index..*index + size];
    *index += size;
    T::from_le_bytes(bytes)
}

trait FromLeBytes: Sized {
    fn from_le_bytes(bytes: &[u8]) -> Self;
}

impl FromLeBytes for u32 {
    fn from_le_bytes(bytes: &[u8]) -> Self {
        u32::from_le_bytes(bytes[..4].try_into().unwrap())
    }
}

impl FromLeBytes for u64 {
    fn from_le_bytes(bytes: &[u8]) -> Self {
        u64::from_le_bytes(bytes[..8].try_into().unwrap())
    }
}

#[napi]
pub struct NativeSpanState {
    inner: RefCell<NativeSpanStateInner>,
    /// UnsafeCell because send_trace_chunks_async needs &mut across await.
    /// Node.js is single-threaded — no data races.
    exporter: UnsafeCell<TraceExporter<DefaultHttpClient>>,
    /// Queue of prepared trace chunks awaiting send. prepareChunk pushes,
    /// sendPreparedChunk pops. Prevents leaking spans when prepare outpaces send.
    prepared_chunks: RefCell<Vec<Vec<libdd_trace_utils::span::v04::Span<NativeTraceData>>>>,
}

// SAFETY: Node.js is single-threaded. All access happens on the main thread.
// RefCell provides runtime borrow checking without Mutex overhead.
unsafe impl Send for NativeSpanState {}
unsafe impl Sync for NativeSpanState {}

struct NativeSpanStateInner {
    change_queue: Vec<u8>,
    string_table_input: Vec<u8>,
    cbs: ChangeBufferState<NativeTraceData>,
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
        change_queue_size: u32,
        string_table_input_size: u32,
        pid: u32,
        tracer_service: String,
    ) -> Result<Self> {
        let mut builder = TraceExporter::<DefaultHttpClient>::builder();
        builder
            .set_url(&url)
            .set_tracer_version(&tracer_version)
            .set_language(&lang)
            .set_language_version(&lang_version)
            .set_language_interpreter(&lang_interpreter);

        let mut change_queue = vec![0u8; change_queue_size as usize];
        let change_buffer = unsafe {
            ChangeBuffer::from_raw_parts(change_queue.as_mut_ptr(), change_queue.len())
        };
        let change_buffer_state = ChangeBufferState::new(
            change_buffer,
            tracer_service.into(),
            lang.into(),
            pid,
        );

        let exporter = builder
            .build()
            .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

        Ok(NativeSpanState {
            inner: RefCell::new(NativeSpanStateInner {
                change_queue,
                string_table_input: vec![0u8; string_table_input_size as usize],
                cbs: change_buffer_state,
            }),
            exporter: UnsafeCell::new(exporter),
            prepared_chunks: RefCell::new(Vec::new()),
        })
    }

    /// Get the change queue buffer as a Node.js Buffer.
    /// JS can create a DataView over this for direct writes.
    /// The Buffer shares memory with the Rust Vec — no copy.
    #[napi]
    pub fn change_queue_buffer(&self, env: Env) -> Result<napi::JsBuffer> {
        let mut inner = self.inner.borrow_mut();
        let ptr = inner.change_queue.as_mut_ptr();
        let len = inner.change_queue.len();
        // SAFETY: The Vec lives as long as NativeSpanState. The JS Buffer
        // borrows this memory without owning it. Node.js is single-threaded
        // so there are no data races.
        unsafe {
            env.create_buffer_with_borrowed_data(
                ptr,
                len,
                std::ptr::null_mut::<()>(),
                |_, _| {},
            )
        }
        .map(|b| b.into_raw())
    }

    /// Get the string table input buffer as a Node.js Buffer.
    #[napi]
    pub fn string_table_input_buffer(&self, env: Env) -> Result<napi::JsBuffer> {
        let mut inner = self.inner.borrow_mut();
        let ptr = inner.string_table_input.as_mut_ptr();
        let len = inner.string_table_input.len();
        unsafe {
            env.create_buffer_with_borrowed_data(
                ptr,
                len,
                std::ptr::null_mut::<()>(),
                |_, _| {},
            )
        }
        .map(|b| b.into_raw())
    }

    /// Flush the change queue — process all buffered operations.
    #[napi]
    pub fn flush_change_queue(&self) -> Result<bool> {
        let mut inner = self.inner.borrow_mut();
        inner.cbs
            .flush_change_buffer()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(true)
    }

    /// Insert a string into the string table.
    #[napi]
    pub fn string_table_insert_one(&self, key: u32, val: String) {
        let mut inner = self.inner.borrow_mut();
        inner.cbs.string_table_insert_one(key, val.into());
    }

    /// Evict a string from the string table.
    #[napi]
    pub fn string_table_evict(&self, key: u32) {
        let mut inner = self.inner.borrow_mut();
        inner.cbs.string_table_evict_one(key);
    }

    /// Prepare a chunk of spans for sending.
    #[napi]
    pub fn prepare_chunk(
        &self,
        len: u32,
        first_is_local_root: bool,
        chunk: Buffer,
    ) -> Result<bool> {
        let mut inner = self.inner.borrow_mut();
        inner.cbs
            .flush_change_buffer()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let mut count = len;
        let mut index = 0;
        let mut span_ids = Vec::with_capacity(count as usize);
        while count > 0 {
            let span_id: u64 = get_num(&chunk, &mut index);
            span_ids.push(span_id);
            count -= 1;
        }

        let spans_vec = inner.cbs
            .flush_chunk(span_ids, first_is_local_root)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        self.prepared_chunks.borrow_mut().push(spans_vec);
        Ok(true)
    }

    /// Send all queued prepared chunks via the trace exporter.
    #[napi]
    pub async fn send_prepared_chunk(&self) -> Result<String> {
        // Drain all queued chunks
        let chunks: Vec<_> = self.prepared_chunks.borrow_mut().drain(..).collect();
        if chunks.is_empty() {
            return Ok("no chunks".to_string());
        }

        let exporter = unsafe { &mut *self.exporter.get() };

        let mut last_response = String::new();
        for chunk in chunks {
            let resp = exporter
                .send_trace_chunks_async(vec![chunk])
                .await;
            last_response = resp
                .map(|r| match r {
                    AgentResponse::Unchanged => "unchanged".to_string(),
                    AgentResponse::Changed { body } => body,
                })
                .map_err(|e| Error::from_reason(format!("{:?}", e)))?;
        }

        Ok(last_response)
    }

    // -- Getter methods --

    #[napi]
    pub fn get_service_name(&self, id: Buffer) -> Result<String> {
        let mut inner = self.inner.borrow_mut();
        inner.cbs.flush_change_buffer().map_err(|e| Error::from_reason(e.to_string()))?;
        let span_id = parse_span_id(&id)?;
        let span = inner.cbs.get_span(&span_id).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(span.service.to_string())
    }

    #[napi]
    pub fn get_meta_attr(&self, id: Buffer, name: String) -> Result<Option<String>> {
        let mut inner = self.inner.borrow_mut();
        inner.cbs.flush_change_buffer().map_err(|e| Error::from_reason(e.to_string()))?;
        let span_id = parse_span_id(&id)?;
        let span = inner.cbs.get_span(&span_id).map_err(|e| Error::from_reason(e.to_string()))?;
        // NativeSpanString: Borrow<str> with content-based Hash, so &str lookup
        // works correctly without constructing a temporary NativeSpanString.
        Ok(span.meta.get(name.as_str()).map(|v| v.to_string()))
    }

    #[napi]
    pub fn get_metric_attr(&self, id: Buffer, name: String) -> Result<Option<f64>> {
        let mut inner = self.inner.borrow_mut();
        inner.cbs.flush_change_buffer().map_err(|e| Error::from_reason(e.to_string()))?;
        let span_id = parse_span_id(&id)?;
        let span = inner.cbs.get_span(&span_id).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(span.metrics.get(name.as_str()).copied())
    }
}

fn parse_span_id(id: &[u8]) -> Result<u64> {
    let bytes: [u8; 8] = id
        .try_into()
        .map_err(|_| Error::from_reason("span ID must be exactly 8 bytes"))?;
    Ok(u64::from_le_bytes(bytes))
}
