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

The optional `stats` configuration supplies the direct stats intake endpoint
and aggregation interval. When configured, libdatadog decodes each v0.4 payload
and generates the stats payload. The wrapper flushes on its interval and on
`beforeExit`. The configuration owner calls `flush()` before replacing the
exporter.

Use `supportsAgentlessStats` to select native aggregation without inspecting
the package version.

`createAgentlessExporter(options, { agent })` accepts an optional borrowed
Node.js HTTP agent. The caller owns the agent and its lifetime.

The package uses a wasm-bindgen backend with the WebAssembly bytes embedded in
JavaScript. The canonical inlined output is published as the regular
`@datadog/libdatadog-wasm` dependency from the `wasm` workspace. The WASM
package also contains the separate remote configuration artifact. No raw
`.wasm` asset or native extension is published.

## API Security (PoC)

Structural schema extraction is available through its own WASM artifact:

```js
const { extractSchemaJson } = require('@datadog/libdatadog/api-security')

extractSchemaJson('{"names":["Alice","Bob"]}')
// '[{"names":[[[8]],{"len":2}]}]'
```

The synchronous function accepts JSON text and returns compact schema JSON.
It throws TypeError for non-string inputs and Error for malformed JSON.
The dedicated entry point loads only the API Security artifact. It includes
structural schemas and metadata. Classification is outside v0; AAP continues
using libddwaf for schema generation and classification.

Build it with `npm run build:api-security` from this directory. The
[crate README](../../crates/api_security/README.md) documents the pinned engine
commit, local-only Git dependency, and PoC limitations.

The value API, extractSchema(value), reads only selected children through the
shared engine: ten array elements, 255 record entries and 18 value levels.
Ignored tails are not validated; visited application errors propagate. Omitted
and empty-key entries consume the quota. Object key enumeration is still
unbounded, as are application getters and total branching work. The JSON-text
API continues validating its complete input.

For transport consumers, extractSchemaSerialized(value) returns compact schema
JSON directly. It uses the same bounded selection, error handling and JavaScript
number/array-length semantics as extractSchema(value), without constructing a
JavaScript schema tree. Object-field and array-variant order may differ; schemas
are semantically equivalent. extractSchemaJson(text) remains the raw JSON input
API and validates the entire input.
