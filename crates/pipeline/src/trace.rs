use std::collections::HashMap;

use crate::native_span::SpanString;

pub struct Trace {
    pub meta: HashMap<SpanString, SpanString>,
    pub metrics: HashMap<SpanString, f64>,
}

impl Trace {
    pub fn new() -> Self {
        Trace {
            meta: HashMap::new(),
            metrics: HashMap::new(),
        }
    }
}
