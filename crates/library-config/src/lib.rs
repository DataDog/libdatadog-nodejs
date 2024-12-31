use wasm_bindgen::prelude::*;
use datadog_library_config_ffi::slice;

#[wasm_bindgen]
pub struct JsConfigurator {
    configurator: Box<datadog_library_config_ffi::static_config::Configurator>,
    envp: Vec<String>,
    args: Vec<String>,
}

#[wasm_bindgen]
impl JsConfigurator {
    #[wasm_bindgen(constructor)]
    pub fn new(debug_logs: bool) -> Self {
        JsConfigurator {
            configurator: datadog_library_config_ffi::ddog_library_configurator_new(debug_logs),
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
        let envp_slices: Vec<slice::CharSlice> = self
            .envp
            .iter()
            .map(|s| slice::CharSlice::from(s.as_str()))
            .collect();
        let envp_slice = slice::Slice::from(&envp_slices);

        let args_slices: Vec<slice::CharSlice> = self
            .args
            .iter()
            .map(|s| slice::CharSlice::from(s.as_str()))
            .collect();
        let args_slice = slice::Slice::from(&args_slices);

        let res_config = self.configurator.get_configuration_from_bytes(
            datadog_library_config_ffi::static_config::ProcessInfo {
                envp: envp_slice,
                args: args_slice,
                language: slice::CharSlice::from("nodejs"),
            },
            slice::CharSlice::from(config_string.as_str()),
        );

        match res_config {
            Ok(config) => {
                let mut hashmap = std::collections::HashMap::new();
                config.iter().for_each(|c| {
                    let key = String::from_utf8_lossy(c.name.to_env_name().to_bytes()).to_string();
                    let value: String;
                    match &c.value {
                        datadog_library_config_ffi::static_config::LibraryConfigValue::StrVal(
                            v,
                        ) => {
                            value = String::from_utf8_lossy(v.as_cstr().into_std().to_bytes())
                                .to_string();
                        }
                        datadog_library_config_ffi::static_config::LibraryConfigValue::NumVal(
                            v,
                        ) => {
                            value = v.to_string();
                        }
                        datadog_library_config_ffi::static_config::LibraryConfigValue::BoolVal(
                            v,
                        ) => {
                            value = v.to_string();
                        }
                    }
                    hashmap.insert(key, value);
                });
                Ok(serde_wasm_bindgen::to_value(&hashmap)?)
            }
            Err(e) => Err(JsValue::from_str(&format!(
                "Failed to get configuration: {:?}",
                e
            ))),
        }
    }
}
