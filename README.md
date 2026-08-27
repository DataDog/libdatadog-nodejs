# libdatadog Node.js bindings

Node.js bindings for [libdatadog](https://github.com/DataDog/libdatadog),
published as two packages with different availability guarantees.

> **Internal packages:** These packages are published solely for use by
> [`dd-trace`](https://github.com/DataDog/dd-trace-js). They are not supported
> as standalone APIs and must not be used directly by applications or other
> libraries. Their APIs, behavior, and distribution may change without notice.

- `@datadog/libdatadog` provides functionality required in every environment
  through optional native platform packages with an inlined WASM fallback.
- `@datadog/libdatadog-extras` provides additional functionality that is not
  available or needed everywhere through native prebuilds and standalone WASM
  modules.

## `@datadog/libdatadog`

The universal package is maintained under
[`packages/libdatadog`](packages/libdatadog). Its matching native and WASM
backends expose the agentless data pipeline, Zstandard compression, and
DDSketch from a single native or WASM artifact.

The package uses one napi-rs binding crate for both native and WASM artifacts.
Native artifacts are published as optional dependencies using napi-rs-compatible
package names such as `@datadog/libdatadog-linux-x64-gnu`. If the platform
package cannot be loaded, the package falls back to the WASM build of the same
bindings. Its WebAssembly bytes and emnapi runtime are embedded in JavaScript,
so the fallback also works when native extensions are unavailable, omitted by
a bundler, or moved to another platform.

See the [package README](packages/libdatadog/README.md) for implementation and
packaging details.

## `@datadog/libdatadog-extras`

The root package contains optional capabilities such as crash tracking,
process discovery, the legacy pipeline, and library configuration.
Platform-native extensions are combined under platform-specific directories
in `prebuilds`. Standalone WASM modules are stored under capability-specific
directories in the same location.
