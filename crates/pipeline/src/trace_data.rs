use libdd_trace_utils::span::TraceData;

use crate::span_bytes::SpanBytesImpl;

#[derive(Clone, Default, Debug, PartialEq)]
pub struct WasmTraceData;

impl TraceData for WasmTraceData {
    type Text = &'static str;
    type Bytes = SpanBytesImpl;
}
