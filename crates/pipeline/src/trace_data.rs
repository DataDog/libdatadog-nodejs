use libdd_trace_model::{AttributeValue, ValueTypes};
use libdd_trace_utils::span::v04::VecMap;
use libdd_trace_utils::span::TraceData;
use serde::Serialize;

use crate::span_bytes::SpanBytesImpl;
use crate::span_string::SpanString;

// `Serialize` is derived only so the test helper `getSpanEventsJson` can
// serialize `Vec<SpanEvent<WasmTraceData>>` (serde's derive on the generic
// `SpanEvent<T>` requires `T: Serialize`). The unit struct carries no data.
#[derive(Clone, Default, Debug, PartialEq, Serialize)]
pub struct WasmTraceData;

impl ValueTypes for WasmTraceData {
    type Text = SpanString;
    type Bytes = SpanBytesImpl;
    type Array = Vec<AttributeValue<Self>>;
    type Map = VecMap<SpanString, AttributeValue<Self>>;
}

impl TraceData for WasmTraceData {}
