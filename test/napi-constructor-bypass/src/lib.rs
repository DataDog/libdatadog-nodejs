use napi::{Env, JsUnknown};
use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestConfig {
    values: Vec<i32>,
}

impl TestConfig {
    pub fn new(mut values: Vec<i32>) -> Self {
        // if empty, use defaults
        if values.is_empty() {
            println!("empty array detected, applying defaults [1, 2, 3]");
            values = vec![1, 2, 3];
        } else {
            println!("using provided values {:?}", values);
        }
        Self { values }
    }

    pub fn values(&self) -> &Vec<i32> {
        &self.values
    }
}

#[napi]
pub fn test_with_constructor(values: Vec<i32>) -> Vec<i32> {
    println!("\n=== test_with_constructor called ===");
    let config = TestConfig::new(values);
    let result = config.values().clone();
    println!("Result: {:?}\n", result);
    result
}

#[napi]
pub fn test_with_serde(env: Env, config: JsUnknown) -> napi::Result<Vec<i32>> {
    println!("\n=== test_with_serde called ===");
    let config: TestConfig = env.from_js_value(config)?;
    let result = config.values().clone();
    println!("Deserialized config.values: {:?}", result);
    println!("Result: {:?}\n", result);
    Ok(result)
}
