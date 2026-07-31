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

The repository publishes two packages from the same set of crates:
`@datadog/libdatadog` (the native bindings plus most WASM modules, from the
repository root) and `@datadog/libdatadog-wasm-pipeline` (the `pipeline` crate,
from `packages/wasm-pipeline`). `scripts/wasm-crates.js` is the single source of
truth for which package publishes which crate.

* `yarn build`: Build the default workspaces in debug mode, then the WASM modules.
* `yarn build-release`: Build the default workspaces in release mode.
* `yarn build-all`: Build all workspaces in debug mode. This is useful when working on a workspace that is not a default member yet.
* `yarn build-wasm`: Build every WASM module. To build just one, run `node scripts/build-wasm.js <crate>`.

Native artifacts land in `build/Release/`. WASM modules land in
`prebuilds/<crate>/`, except the pipeline module, which belongs to its own
package and lands in `packages/wasm-pipeline/prebuilds/pipeline/`.

## Run tests

* `yarn test`: Run the native test suite (needs `yarn build`).
* `yarn test-wasm`: Run the WASM test suites (needs `yarn build-wasm`).
* `yarn test-wasm <crate>`: Run only one crate's WASM tests, e.g. `yarn test-wasm pipeline`.

## Versioning

The published packages are versioned in lockstep, so `package.json` and
`packages/wasm-pipeline/package.json` must always declare the same version.
`node scripts/check-versions.js` enforces this in CI.
