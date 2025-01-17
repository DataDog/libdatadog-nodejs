# Libconfig example

## How to run
Set the following env vars:
```bash
export OS=$(uname | tr '[:upper:]' '[:lower:]') # darwin / linux / windows
export ARCH=$(arch) # arm64 / amd64
export LIBC='' # glibc / musl if on linux, else empty
```

From repository root 
```bash
wasm-pack build --target nodejs ./crates/library-config
mkdir -p ./prebuilds/${OS}-${ARCH}${LIBC}
mv ./crates/library-config/pkg ./prebuilds/${OS}-${ARCH}${LIBC}

node --experimental-modules --experimental-wasm-modules test/library-config/index.js
```
