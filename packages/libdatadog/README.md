# @datadog/libdatadog

> **Internal package:** This package is published solely for use by `dd-trace`.
> It is not a supported standalone API and must not be used directly by
> applications or other libraries. Its API, behavior, and distribution may
> change without notice.

WASM Node.js bindings for libdatadog. The bindings for Zstandard compression,
DDSketch, and the agentless data pipeline are maintained in the root
`crates/libdatadog-wasm` workspace crate. Optional libdatadog functionality is
published separately as `@datadog/libdatadog-extras`.

Remote configuration is available from `@datadog/libdatadog/remote-config`.
It uses a dedicated wasm-bindgen artifact that loads only with this entry point.

The package accepts Datadog v0.4 MessagePack payloads and exports them to an
agentless intake. `sendV04()` reports completion through a callback and sends
delivery failures to the supplied logger. It does not return a promise.

The package publishes Brotli-compressed `.wasm.br` files next to the
wasm-bindgen JavaScript loaders. Each loader reads and decompresses its file
synchronously before instantiation. A bundled distribution must copy the
referenced asset next to its output JavaScript file. No raw `.wasm` asset or
native extension is published.
