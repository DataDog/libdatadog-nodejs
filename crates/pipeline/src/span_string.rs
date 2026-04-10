// String type for WASM spans: a raw `&'static str` backed by the
// ChangeBufferState arena.  No Arc, no atomic operations.
pub type SpanString = &'static str;
