use crate::span_bytes::NativeSpanBytes;
use libdd_trace_utils::span::TraceData;

#[derive(Clone, Default, Debug, PartialEq)]
pub struct NativeTraceData;

impl TraceData for NativeTraceData {
    type Text = &'static str;
    type Bytes = NativeSpanBytes;
}
