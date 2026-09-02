# @datadog/libdatadog

> **Internal package:** This package is published solely for use by `dd-trace`.
> It is not a supported standalone API and must not be used directly by
> applications or other libraries. Its API, behavior, and distribution may
> change without notice.

WASM Node.js bindings for libdatadog. The bindings for Zstandard compression,
DDSketch, and the agentless data pipeline are maintained in the root
`crates/libdatadog-wasm` workspace crate. Optional libdatadog functionality is
published separately as `@datadog/libdatadog-extras`.

The package accepts Datadog v0.4 MessagePack payloads and exports them to an
agentless intake. `sendV04()` reports completion through a callback and sends
delivery failures to the supplied logger. It does not return a promise.

The package uses a wasm-bindgen backend with the WebAssembly bytes embedded in
JavaScript. The canonical inlined output is published as the regular
`@datadog/libdatadog-wasm` dependency from the `wasm` workspace. No raw `.wasm`
asset or native extension is published.
