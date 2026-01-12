use libdd_trace_utils::span::SpanText;
use serde::Serialize;
use std::borrow::Borrow;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::fmt::*;

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

impl Display for SpanString {
    fn fmt(&self, formatter: &mut Formatter) -> Result {
        write!(formatter, "{}", self.0)
    }
}
