use napi::{Env, JsUnknown};
use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestConfig {
    values: Vec<i32>,
}

impl TestConfig {
    pub fn new(mut values: Vec<i32>) -> Self {
        if values.is_empty() {
            values = vec![1, 2, 3];
        }
        Self { values }
    }

    pub fn values(&self) -> &Vec<i32> {
        &self.values
    }
}

#[napi]
pub fn test_with_constructor(values: Vec<i32>) -> Vec<i32> {
    let config = TestConfig::new(values);
    config.values().clone()
}

#[napi]
pub fn test_with_serde(env: Env, config: JsUnknown) -> napi::Result<Vec<i32>> {
    let config: TestConfig = env.from_js_value(config)?;
    Ok(config.values().clone())
}
