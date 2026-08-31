# libdatadog Node.js bindings

Node.js bindings for [libdatadog](https://github.com/DataDog/libdatadog),
published as two packages with different availability guarantees.

> **Internal packages:** These packages are published solely for use by
> [`dd-trace`](https://github.com/DataDog/dd-trace-js). They are not supported
> as standalone APIs and must not be used directly by applications or other
> libraries. Their APIs, behavior, and distribution may change without notice.

- `@datadog/libdatadog` provides functionality required in every environment
  through inlined WASM.
- `@datadog/libdatadog-extras` provides additional functionality that is not
  available or needed everywhere through native prebuilds and standalone WASM
  modules.

## `@datadog/libdatadog`

The package is maintained under [`packages/libdatadog`](packages/libdatadog).
Zstandard compression, DDSketch, and the agentless data pipeline use a
wasm-bindgen backend whose WebAssembly bytes are embedded in JavaScript. No raw
`.wasm` asset or native extension is published.

Remote configuration is available from `@datadog/libdatadog/remote-config`.
It uses a dedicated wasm-bindgen artifact that loads only with this entry point.

See the [package README](packages/libdatadog/README.md) for implementation and
packaging details.

## `@datadog/libdatadog-extras`

The root package contains optional capabilities such as crash tracking,
process discovery, the legacy pipeline, and library configuration.
Platform-native extensions are combined under platform-specific directories
in `prebuilds`. Standalone WASM modules are stored under capability-specific
directories in the same location.
