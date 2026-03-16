use libdd_trace_utils::span::TraceData;

use crate::span_bytes::SpanBytesImpl;
use crate::span_string::SpanString;

#[derive(Clone, Default, Debug, PartialEq)]
pub struct WasmTraceData;

impl TraceData for WasmTraceData {
    type Text = SpanString;
    type Bytes = SpanBytesImpl;
}
