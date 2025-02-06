use std::collections::HashMap;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct JsConfigurator {
    configurator: Box<datadog_library_config::Configurator>,
    envp: Vec<String>,
    args: Vec<String>,
}

#[wasm_bindgen]
impl JsConfigurator {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        JsConfigurator {
            configurator: Box::new(datadog_library_config::Configurator::new(false)), // No debug log as WASM can't write to stdout
            envp: Vec::new(),
            args: Vec::new(),
        }
    }

    #[wasm_bindgen]
    pub fn set_envp(&mut self, envp: Box<[JsValue]>) -> Result<(), JsValue> {
        self.envp = envp.iter()
            .filter_map(|val| val.as_string())
            .collect();
        Ok(())
    }

    #[wasm_bindgen]
    pub fn set_args(&mut self, args: Box<[JsValue]>) -> Result<(), JsValue> {
        self.args = args.iter()
            .filter_map(|val| val.as_string())
            .collect();
        Ok(())
    }

    #[wasm_bindgen]
    pub fn get_configuration(
        &self,
        config_string: String,
    ) -> Result<JsValue, JsValue> {
        let envp: Vec<&[u8]> = self
            .envp
            .iter()
            .map(|s| s.as_bytes())
            .collect();

        let args: Vec<_> = self
            .args
            .iter()
            .map(|s| s.as_bytes())
            .collect();

        let res_config = self.configurator.get_config_from_bytes(
            config_string.as_bytes(),
            datadog_library_config::ProcessInfo {
                envp: &envp,
                args: &args,
                language: b"nodejs",
            },
        );

        match res_config {
            Ok(config) => {
                let hashmap: HashMap<String, String> = config.into_iter().map(|c| {
                    let key = c.name.to_str().to_owned();
                    (key, c.value)
                }).collect();
                Ok(serde_wasm_bindgen::to_value(&hashmap)?)
            },
            Err(e) => Err(JsValue::from_str(&format!(
                "Failed to get configuration: {:?}",
                e
            ))),
        }
    }
}
