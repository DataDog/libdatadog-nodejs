# Libconfig example

## How to run
From repository root 
```bash
wasm-pack build --target nodejs ./crates/library_config
mkdir -p ./prebuilds/library_config
mv ./crates/library_config/pkg ./prebuilds/library_config

node test/wasm/library_config/index.js
```
