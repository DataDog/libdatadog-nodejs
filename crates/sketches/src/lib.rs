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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_points_and_counts() {
        let mut sketch = DDSketch::new();

        sketch.add(1.0).unwrap();
        sketch.add_with_count(2.0, 3.0).unwrap();

        assert_eq!(sketch.count(), 4.0);
    }

    #[test]
    fn encodes_as_protobuf_without_consuming_the_sketch() {
        let mut sketch = DDSketch::new();
        sketch.add_with_count(42.0, 2.0).unwrap();

        let encoded = sketch.encode();
        let decoded = InnerDDSketch::from_encoded(&encoded).unwrap();

        assert_eq!(decoded.count(), 2.0);

        sketch.add(43.0).unwrap();
        let encoded = sketch.encode();
        let decoded = InnerDDSketch::from_encoded(&encoded).unwrap();

        assert_eq!(decoded.count(), 3.0);
    }
}
