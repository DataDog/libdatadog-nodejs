# Libconfig example

## How to run
From repository root 
```bash
wasm-pack build ./crates/library-config
mv ./crates/library-config/pkg ./test/library-config

node --experimental-modules --experimental-wasm-modules test/library-config/index.js
```
