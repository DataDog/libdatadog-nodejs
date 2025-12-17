use datadog_trace_utils::span::{Span, SpanText};
use serde::Serialize;
use std::borrow::Borrow;
use std::hash::{Hash, Hasher};
use std::ops::{Deref, DerefMut};
use std::sync::Arc;

#[derive(Default, Eq, PartialEq, Serialize, Clone)]
pub struct SpanString(pub Arc<str>);

impl Hash for SpanString {
    fn hash<H: Hasher>(&self, state: &mut H) {
        // Hash the string content, not the Arc pointer
        self.0.as_ref().hash(state);
    }
}

impl Borrow<str> for SpanString {
    fn borrow(&self) -> &str {
        &self.0
    }
}

impl SpanText for SpanString {
    fn from_static_str(value: &'static str) -> Self {
        SpanString(Arc::from(value))
    }
}

impl From<String> for SpanString {
    fn from(s: String) -> SpanString {
        SpanString(Arc::from(s))
    }
}

impl From<&str> for SpanString {
    fn from(value: &str) -> SpanString {
        SpanString(Arc::from(value))
    }
}

pub struct NativeSpan {
    pub span: Span<SpanString>,
    pub sampling_finalized: bool,
}

impl Deref for NativeSpan {
    type Target = Span<SpanString>;

    fn deref(&self) -> &Self::Target {
        &self.span
    }
}

impl DerefMut for NativeSpan {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.span
    }
}

impl NativeSpan {
    pub fn new(span_id: u64, parent_id: u64, trace_id: u128) -> Self {
        NativeSpan {
            span: Span {
                span_id,
                trace_id,
                parent_id,
                ..Default::default()
            },
            sampling_finalized: false,
        }
    }

    pub fn sample(&mut self) -> Option<[u8; 8]> {
        if self.sampling_finalized {
            // TODO can we also do this check before flushing the queue, in case we don't have to?
            return None;
        }

        // TODO Something correct here. This is all just a placeholder until
        // we actually implement sampling.
        // BEGIN PLACEHOLDER
        let sampling_info: u64 = self.span_id + self.trace_id as u64;
        let sampling_info_bytes = sampling_info.to_be_bytes();
        // END PLACEHOLDER

        Some(sampling_info_bytes)
    }

    pub fn set_metric<T: Into<SpanString>, U: Into<f64>>(&mut self, name: T, val: U) {
        self.span.metrics.insert(name.into(), val.into());
    }

    pub fn set_meta<T: Into<SpanString>, U: Into<SpanString>>(&mut self, name: T, val: U) {
        self.span.meta.insert(name.into(), val.into());
    }
}
