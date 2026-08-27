# @datadog/libdatadog

> **Internal package:** This package is published solely for use by `dd-trace`.
> It is not a supported standalone API and must not be used directly by
> applications or other libraries. Its API, behavior, and distribution may
> change without notice.

Universal Node.js bindings for libdatadog. Native and WASM artifacts are built
from the single root `crates/libdatadog` napi-rs workspace crate. Optional
libdatadog functionality is published separately as
`@datadog/libdatadog-extras`.

Both backends expose remote configuration, the agentless data pipeline,
Zstandard compression, and DDSketch from a single native or WASM artifact.

Remote configuration connects directly to the Datadog backend and verifies
responses with TUF. Both bindings use the smaller regex implementation and
Node's host-managed HTTP transport. Reusing Node's HTTPS implementation avoids
shipping another TLS stack in native packages and keeps networking behavior
consistent across the NAPI and WASM backends.

The package accepts Datadog v0.4 MessagePack payloads and exports them to an
agentless intake.

The package tries a platform-native napi-rs backend first and falls back to the
napi-rs WASM build of the same bindings. The WebAssembly module, generated
loader, emnapi runtime, and worker bootstrap are Brotli-compressed and embedded
in one JavaScript file. That output is published as the regular
`@datadog/libdatadog-wasm` dependency from the `wasm` workspace. This directory
is itself the published metapackage. Platform-native packages follow the
napi-rs layout, are generated in `dist/packages`, and are installed as optional
dependencies. They are not npm workspaces because their mutually exclusive
`os`, `cpu`, and `libc` constraints would make local workspace installs
platform-dependent. No raw `.wasm` or separate runtime asset is published.
