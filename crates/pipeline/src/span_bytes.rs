use libdd_trace_utils::span::SpanBytes;
use serde::Serialize;
use std::borrow::Borrow;
use std::hash::{Hash, Hasher};

#[derive(Default, Debug, Eq, PartialEq, Clone, Serialize)]
pub struct SpanBytesImpl(pub Vec<u8>);

impl Hash for SpanBytesImpl {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.0.hash(state);
    }
}

impl Borrow<[u8]> for SpanBytesImpl {
    fn borrow(&self) -> &[u8] {
        &self.0
    }
}

impl SpanBytes for SpanBytesImpl {
    fn from_static_bytes(value: &'static [u8]) -> Self {
        SpanBytesImpl(value.to_vec())
    }
}
