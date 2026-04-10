// String type for native spans: a raw `&'static str` backed by the
// ChangeBufferState arena.  No Arc, no atomic operations.
pub type NativeSpanString = &'static str;
