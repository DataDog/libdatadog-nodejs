use crate::span_bytes::NativeSpanBytes;
use crate::span_string::NativeSpanString;
use libdd_trace_utils::span::TraceData;

#[derive(Clone, Default, Debug, PartialEq)]
pub struct NativeTraceData;

impl TraceData for NativeTraceData {
    type Text = NativeSpanString;
    type Bytes = NativeSpanBytes;
}
