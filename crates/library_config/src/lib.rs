use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct JsConfigurator {
    configurator: Box<datadog_library_config::Configurator>,
    envp: Vec<String>,
    args: Vec<String>,
}

#[wasm_bindgen]
pub struct ConfigEntry {
    name: String,
    value: String,
    source: String,
    config_id: String,
}

#[wasm_bindgen]
impl ConfigEntry {
    #[wasm_bindgen(constructor)]
    pub fn new(name: String, value: String, source: String, config_id: String) -> ConfigEntry {
        ConfigEntry {
            name,
            value,
            source,
            config_id,
        }
    }
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn value(&self) -> String {
        self.value.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn source(&self) -> String {
        self.source.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn config_id(&self) -> String {
        self.config_id.clone()
    }
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
        self.envp = envp.iter().filter_map(|val| val.as_string()).collect();
        Ok(())
    }

    #[wasm_bindgen]
    pub fn set_args(&mut self, args: Box<[JsValue]>) -> Result<(), JsValue> {
        self.args = args.iter().filter_map(|val| val.as_string()).collect();
        Ok(())
    }

    #[wasm_bindgen]
    pub fn get_config_local_path(&self, target: String) -> Result<String, JsValue> {
        let target_enum = match target.as_str() {
            "linux" => datadog_library_config::Target::Linux,
            "win32" => datadog_library_config::Target::Windows,
            "darwin" => datadog_library_config::Target::Macos,
            _ => return Err(JsValue::from_str("Unsupported target")),
        };
        Ok(
            datadog_library_config::Configurator::local_stable_configuration_path(target_enum)
                .to_string(),
        )
    }

    #[wasm_bindgen]
    pub fn get_config_managed_path(&self, target: String) -> Result<String, JsValue> {
        let target_enum = match target.as_str() {
            "linux" => datadog_library_config::Target::Linux,
            "win32" => datadog_library_config::Target::Windows,
            "darwin" => datadog_library_config::Target::Macos,
            _ => return Err(JsValue::from_str("Unsupported target")),
        };
        Ok(
            datadog_library_config::Configurator::fleet_stable_configuration_path(target_enum)
                .to_string(),
        )
    }

    #[wasm_bindgen]
    pub fn get_configuration(
        &self,
        config_string_local: String,
        config_string_managed: String,
    ) -> Result<Vec<ConfigEntry>, JsValue> {
        let envp: Vec<Vec<u8>> = self.envp.iter().map(|s| s.as_bytes().to_vec()).collect();

        let args: Vec<Vec<u8>> = self.args.iter().map(|s| s.as_bytes().to_vec()).collect();

        let res_config = self.configurator.get_config_from_bytes(
            config_string_local.as_bytes(),
            config_string_managed.as_bytes(),
            datadog_library_config::ProcessInfo {
                envp: envp,
                args: args,
                language: b"nodejs".to_vec(),
            },
        );

        match res_config {
            Ok(config) => {
                let config_entries: Vec<ConfigEntry> = config
                    .into_iter()
                    .map(|c| ConfigEntry {
                        name: c.name.to_str().into(),
                        value: c.value,
                        source: c.source.to_str().into(),
                        config_id: c.config_id.unwrap_or_default(),
                    })
                    .collect();
                Ok(config_entries)
            }
            Err(e) => Err(JsValue::from_str(&format!(
                "Failed to get configuration: {:?}",
                e
            ))),
        }
    }
}
