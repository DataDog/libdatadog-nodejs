# @datadog/libdatadog

> **Internal package:** This package is published solely for use by `dd-trace`.
> It is not a supported standalone API and must not be used directly by
> applications or other libraries. Its API, behavior, and distribution may
> change without notice.

Universal Node.js bindings for libdatadog. Native and WASM bindings for
Zstandard compression and DDSketch are maintained in the root
`crates/libdatadog` and `crates/libdatadog-wasm` workspace crates. Optional
libdatadog functionality is published separately as
`@datadog/libdatadog-extras`.

The agentless data pipeline always uses the WASM backend. Zstandard compression
and DDSketch use the native backend when it is available, with WASM as the
fallback.

The package accepts Datadog v0.4 MessagePack payloads and exports them to an
agentless intake.

The package tries a platform-native napi-rs backend first and falls back to a
wasm-bindgen backend with the WebAssembly bytes embedded in JavaScript. The
canonical inlined output is published as the regular
`@datadog/libdatadog-wasm` dependency from the `wasm` workspace. This directory
is itself the published metapackage. Platform-native packages follow the
napi-rs layout, are generated in `dist/packages`, and are installed as optional
dependencies. They are not npm workspaces because their mutually exclusive
`os`, `cpu`, and `libc` constraints would make local workspace installs
platform-dependent. No raw `.wasm` asset is published.
