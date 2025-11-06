use crate::trace::Trace;
use datadog_trace_utils::span::{Span, SpanText};
use serde::Serialize;
use std::borrow::Borrow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::{Deref, DerefMut};
use std::rc::Rc;

#[derive(Default, Eq, PartialEq, Serialize, Hash, Clone)]
pub struct SpanString(pub String);

impl Borrow<str> for SpanString {
    fn borrow(&self) -> &str {
        self.0.as_str()
    }
}

impl SpanText for SpanString {
    fn from_static_str(value: &'static str) -> Self {
        SpanString(String::from(value))
    }
}

impl From<String> for SpanString {
    fn from(s: String) -> SpanString {
        SpanString(s)
    }
}

pub struct NativeSpan {
    pub span: Span<SpanString>,
    pub trace: Rc<RefCell<Trace>>,
}

impl NativeSpan {
    pub fn copy_in_trace_data(&mut self) {
        // TODO(bengl) can we avoid doing two loops each, somehow?
        let mut meta = HashMap::new();
        for (key, value) in (*self.trace).borrow().meta.iter() {
            meta.insert(key.clone(), value.clone());
        }
        for (key, value) in meta.into_iter() {
            self.meta.insert(key, value);
        }

        let mut metrics = HashMap::new();
        for (key, value) in (*self.trace).borrow().metrics.iter() {
            metrics.insert(key.clone(), value.clone());
        }
        for (key, value) in metrics.into_iter() {
            self.metrics.insert(key, value);
        }
    }
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
    pub fn new(
        all_spans: &HashMap<u64, NativeSpan>,
        span_id: u64,
        parent_id: u64,
        trace_id: u128,
    ) -> Self {
        let maybe_parent = if parent_id == 0 {
            None
        } else {
            all_spans.get(&parent_id)
        };

        let trace = if let Some(parent) = maybe_parent {
            parent.trace.clone()
        } else {
            Rc::new(RefCell::new(Trace::new()))
        };

        NativeSpan {
            span: Span {
                span_id,
                trace_id,
                parent_id,
                ..Default::default()
            },
            trace,
        }
    }
}
