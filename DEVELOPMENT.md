# Development

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Development setup

To build `libdatadog-nodejs` locally (for example, to run tests or try out changes), you need Node.js, Yarn, and Rust.

**Rust (required for native and WASM builds)**

The project compiles Rust for both native Node.js addons and WebAssembly. Use [rustup](https://rustup.rs/) (the recommended and supported method):

1. **Install rustup and Rust** (see https://rustup.rs/ for more options):

   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. **Ensure Rust is on `PATH`** — the rustup installer prints the command for your shell; run it or open a new terminal.

3. **Add the WebAssembly target** (required for the full build):

   ```bash
   rustup target add wasm32-unknown-unknown
   ```

4. **On macOS only** — the WASM build requires LLVM from Homebrew (Apple's Clang has compatibility issues with some crates). Install it before building:

   ```bash
   brew install llvm
   ```

5. **Install dependencies:**

   ```bash
   yarn install
   ```

## Building

* `yarn build`: Build the default workspaces in debug mode.
* `yarn build-release`: Build the default workspaces in release mode.
* `yarn build-all`: Build all workspaces in debug mode. This is useful when working on a workspace that is not a default member yet.

## Run tests

* `yarn test`: Run the JavaScript test suite
