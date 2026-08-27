use libdd_ddsketch::DDSketch as InnerDDSketch;
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(js_name = "DDSketch")]
#[derive(Default)]
pub struct DDSketch {
    inner: InnerDDSketch,
}

#[napi]
impl DDSketch {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi]
    pub fn add(&mut self, point: f64) -> Result<()> {
        self.inner
            .add(point)
            .map_err(|error| Error::from_reason(error.to_string()))
    }

    #[napi(js_name = "addWithCount")]
    pub fn add_with_count(&mut self, point: f64, count: f64) -> Result<()> {
        self.inner
            .add_with_count(point, count)
            .map_err(|error| Error::from_reason(error.to_string()))
    }

    #[napi]
    pub fn count(&self) -> f64 {
        self.inner.count()
    }

    #[napi]
    pub fn encode(&self) -> Buffer {
        self.inner.clone().encode_to_vec().into()
    }
}
