# Libconfig example

## How to run
From repository root 
```bash
wasm-pack build --target nodejs ./crates/library-config
mkdir -p ./prebuilds/library_config
mv ./crates/library-config/pkg ./prebuilds/library_config

node --experimental-modules --experimental-wasm-modules test/library-config/index.js
```
