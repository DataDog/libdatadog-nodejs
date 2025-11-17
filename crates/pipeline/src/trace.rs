use std::collections::HashMap;

use crate::native_span::SpanString;

#[derive(Default)]
pub struct Trace {
    pub meta: HashMap<SpanString, SpanString>,
    pub metrics: HashMap<SpanString, f64>,
    pub origin: Option<SpanString>,
    pub sampling_rule_decision: Option<f64>,
    pub sampling_limit_decision: Option<f64>,
    pub sampling_agent_decision: Option<f64>,
}

impl Trace {
    pub fn new() -> Self {
        Default::default()
    }
}
