use libdd_trace_utils::span::SpanText;
use serde::Serialize;
use std::borrow::Borrow;
use std::fmt::*;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

#[derive(Default, Debug, Eq, PartialEq, Serialize, Clone)]
pub struct NativeSpanString(pub Arc<str>);

impl Hash for NativeSpanString {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.0.as_ref().hash(state);
    }
}

impl Borrow<str> for NativeSpanString {
    fn borrow(&self) -> &str {
        &self.0
    }
}

impl SpanText for NativeSpanString {
    fn from_static_str(value: &'static str) -> Self {
        NativeSpanString(Arc::from(value))
    }
}

impl From<String> for NativeSpanString {
    fn from(s: String) -> NativeSpanString {
        NativeSpanString(Arc::from(s))
    }
}

impl From<&str> for NativeSpanString {
    fn from(value: &str) -> NativeSpanString {
        NativeSpanString(Arc::from(value))
    }
}

impl Display for NativeSpanString {
    fn fmt(&self, formatter: &mut Formatter) -> Result {
        write!(formatter, "{}", self.0)
    }
}
