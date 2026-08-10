use libdd_ddsketch::DDSketch as InnerDDSketch;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Default)]
pub struct DDSketch {
    inner: InnerDDSketch,
}

#[wasm_bindgen]
impl DDSketch {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, point: f64) -> Result<(), JsError> {
        self.inner
            .add(point)
            .map_err(|error| JsError::new(&error.to_string()))
    }

    #[wasm_bindgen(js_name = addWithCount)]
    pub fn add_with_count(&mut self, point: f64, count: f64) -> Result<(), JsError> {
        self.inner
            .add_with_count(point, count)
            .map_err(|error| JsError::new(&error.to_string()))
    }

    pub fn count(&self) -> f64 {
        self.inner.count()
    }

    pub fn encode(&self) -> Vec<u8> {
        self.inner.clone().encode_to_vec()
    }
}
