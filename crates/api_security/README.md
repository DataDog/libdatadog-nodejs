# API Security WASM binding

This crate delegates structural schema extraction to libdd-api-security.
It adds the wasm-bindgen boundary and a lazy JavaScript value adapter.
Schema selection, deduplication and metadata remain in the shared Rust engine.

The v0 engine is structural only. Scanner matching, classification tags and
scanner/processor configuration are outside its scope. AAP continues using
libddwaf for schema generation and classification. The public Node APIs and
bounded-read/error behavior are preserved.

The core is pinned to libdatadog commit
f1478bbb9436d5a67cb0bf59980a0bcd93d118f5. The file:// Git URL in Cargo.toml is
local PoC wiring: Cargo checks out that commit rather than reading uncommitted
changes from the sibling repository. Builds on other machines require a
reachable copy of this Git repository, or changing the URL to GitHub after
the exact commit has been pushed. This branch is not ready for shared CI or
publication with the local source URL.

On macOS, install the source and LLVM components for the pinned WASM toolchain
from the repository root:

```sh
rustup component add rust-src llvm-tools --toolchain "$(cat wasm-rust-toolchain)"
rustup target add wasm32-unknown-unknown --toolchain "$(cat wasm-rust-toolchain)"
# Match the wasm-bindgen version in Cargo.lock; install without WASM-only RUSTFLAGS.
cargo +stable install wasm-bindgen-cli --version 0.2.130 --locked
```

From packages/libdatadog:

```sh
npm ci
npm run build:api-security
node --test test/api-security.test.js
npm run test:types
```

The existing build helper uses the pinned WASM Rust toolchain and inlines the
compiled bytes into the JavaScript artifact. No native extension or standalone
.wasm asset is needed by consumers.

The extractSchemaJson entry point accepts JSON text and returns compact schema JSON.
It rejects non-string inputs without invoking application serialization hooks.
Malformed JSON produces an Error. Property names are retained; scalar values
and scanner classification metadata are not emitted. This is not a general
redactor for data stored in property names.

The extractSchema entry point reads JavaScript values directly. It requests only
the first ten array elements, first 255 record entries and 18 value levels.
Scalar string contents are never copied into WASM. Visited getters and toJSON
hooks run once; their exceptions propagate. Ignored tails, empty-key values and
depth-excluded children are not read or validated. Cycles in visited structures
throw; shared non-cyclic objects are allowed. Undefined/functions/symbols become
null in arrays and are omitted in records. Omitted entries still consume quota
and count toward record truncation, unlike full JSON.stringify traversal.

Numbers use type 16 and array length metadata is capped at 256 before nested
deduplication for native-appsec compatibility. Object.keys still enumerates all
keys to obtain field order and the original count. There is no total node,
allocation or execution-time budget. Unpaired UTF-16 surrogates in visited keys
are rejected because Rust strings cannot preserve them. Raw JSON input retains
full syntax validation, including discarded tails.

Sampling, collecting application values and reporting schemas remain tracer responsibilities. The core's PoC resource-budget
limitations also apply across this boundary.

The structural-only v0 rebuild (2026-11-18) passes 129 package tests plus type
checks on both Node 18.20.8 and 24.5.0. Cargo check, Clippy, formatting, package
lint and the dependency guard pass. The generated runtime JS and imported helper
total 40,096 bytes. These checks do not constitute a new HTTP benchmark.

The historical checkpoints below describe earlier revisions; current optimization
results are recorded separately in the tracer benchmark report.

## Validation and benchmark checkpoint (2026-11-09)

The complete package suite passes 113 tests on Node 18.20.8 and 24.5.0.
The API Security and installed-package subset passes 45 tests on Node 20.20.2
and 22.22.0. TypeScript checking also passes. Coverage includes all 33 shared
engine fixtures, repeated failures/recovery, actual offline tarball installation,
CommonJS/ESM imports, lazy loading, and esbuild/webpack bundles without WASM assets.

### Compatibility findings

The WASM module matches all 33 shared Rust fixtures. Comparing those JSON inputs
with native-appsec 12.0.0 / libddwaf 2.1.0 gives 16 exact semantic matches and 17
differences involving JavaScript numbers. Native marshalling represents JS Number
values as floating point (schema type 16), while the JSON API distinguishes integer
tokens (type 4). For example, {"id":42} yields [{"id":[4]} through JSON/WASM and
[{"id":[16]} through native-appsec. Mixed integer/float variants can consequently
deduplicate differently. JSON.stringify also loses lexical distinctions such as 1.0.

Native marshalling caps a 500-element input array at 256 before extraction;
the corresponding schema length is 256. The JSON API sees all 500 and reports 500.
Both extract only the first 10 element schemas. The extractSchema adapter now
preserves these two native-appsec behaviors; extractSchemaJson retains the
language-neutral JSON contract. The adapter matches all 33 fixtures against
native-appsec 12.0.0 / libddwaf 2.1.0. Against dd-trace-js's locked
native-appsec 11.0.3 / libddwaf 1.30.1, it matches 32: the older WAF retains
empty property names, while the libddwaf 2 schema contract omits them.
Scanner-enabled output parity is still outside this structural PoC.

### End-to-end timings

Apple M3 Max, macOS arm64; workspace release profile (opt-level=z),
nightly-2026-07-26, with the existing macOS helper skipping wasm-opt.
Each value below is a median of 30 batch-average timings, in microseconds.
The fixture data is synthetic and built outside the timed loops.

| Workload | Node 24 WASM from JS | Node 24 native | Node 18 WASM from JS | Node 18 native |
| --- | ---: | ---: | ---: | ---: |
| Record, 10 fields | 1.61 | 8.76 | 2.52 | 11.12 |
| Record, 200 fields | 29.90 | 126.91 | 46.58 | 163.51 |
| Realistic body, 20 items | 7.45 | 30.51 | 12.14 | 36.66 |
| Realistic body, 200 items | 45.46 | 189.22 | 75.72 | 225.90 |

These four workloads have equal schema outputs and no native input truncation.
They use string IDs and non-integral numeric prices to avoid hiding the numeric
representation difference. WASM is 4.1–5.5x faster on Node 24 in this local run;
a second run reproduces 4.1–5.4x. Node 18 shows 3.0–4.4x.

WASM-from-JS includes JSON.stringify, JS/WASM copies, extraction and schema JSON
serialization. Native includes fresh context creation, JS marshalling, a scanner-free
schema processor with no attack rules, output JSON serialization and context disposal.
The initialized native engine is reused. The raw reports separately measure
JSON.stringify alone and the WASM API receiving already-encoded JSON.

This is a standalone extraction comparison. It does not measure incremental schema
cost inside an existing AppSec request context, full tracer overhead, transport,
compression, or request-tail latency. The reported batch p95 is not request p95.

### Large-input behavior

| Workload | Node 24 WASM from JS | Node 24 native | Interpretation |
| --- | ---: | ---: | --- |
| Array, 500 records | 111.92 µs | 239.47 µs | Different length metadata: 500 versus 256; no parity speedup claim |
| String value, 100 KB | 173.97 µs | 19.41 µs | Equal schema, but native truncates the value before extraction |

On Node 18 the 100 KB string costs 478.65 µs through JSON/WASM and 8.23 µs through
native. Full-input encoding/copying/reading is a material cost even when the output
schema is tiny. Input adapters and resource budgets remain production follow-ups;
the ordinary-workload speedup must not be generalized to large bodies.

### Artifact and initialization

The dedicated artifact is 26,488 bytes of inlined JavaScript, containing 16,196
bytes of Brotli-compressed WASM (39,277 bytes uncompressed). No separate WASM
asset is required.

Across 15 fresh Node 24 processes, median require time is 3.68 ms for the WASM
module and 2.26 ms for native-appsec. The first extraction adds 0.53 ms and 0.10 ms
respectively; the native first call includes engine/context initialization.
Observed RSS growth after load and one call is about 6.66 MiB versus 4.50 MiB.
These use warm filesystem caches and exclude process startup. RSS is not an
allocation count or peak-memory bound, and this is not an incremental measurement
inside an already-loaded tracer.

### Reproduce

Build the complete package from the repository root:

```sh
npm run build --prefix packages/libdatadog
npm test --prefix packages/libdatadog
node packages/libdatadog/benchmark/api-security.js /path/to/node_modules/@datadog/native-appsec
```

The native dependency is supplied only to this development benchmark; it is not
a dependency of the WASM module. Run benchmarks without competing build/test jobs.

Raw reports: [Node 24](../../packages/libdatadog/benchmark/results/api-security-node24.json),
[Node 24 repeat](../../packages/libdatadog/benchmark/results/api-security-node24-repeat.json),
and [Node 18](../../packages/libdatadog/benchmark/results/api-security-node18.json).
Each report records versions, methodology, differing fixtures, truncation metrics,
startup measurements, artifact sizes and latency samples summarized by workload.

## Node adapter and tracer integration checkpoint

The measurements above describe the original JSON API. The actual tracer adapter
also parses the schema JSON and applies Node compatibility normalization. Its
Node 24 medians against native-appsec 11.0.3 are:

| Workload | Adapter, µs | Native, µs |
| --- | ---: | ---: |
| Record, 10 fields | 2.77 | 11.01 |
| Record, 200 fields | 82.65 | 156.52 |
| Realistic body, 20 items | 9.75 | 41.05 |
| Realistic body, 200 items | 49.28 | 275.29 |
| Array, 500 records | 113.30 | 342.80 |
| String value, 100 KB | 184.44 | 65.07 |

All six workload schemas match. These are standalone microbenchmarks, including
schema output JSON serialization on both sides, not full request latency.
Large strings remain slower and need bounded input conversion before production.

Raw reports:
[tracer's native-appsec 11](../../packages/libdatadog/benchmark/results/api-security-node-adapter-node24.json)
and [native-appsec 12](../../packages/libdatadog/benchmark/results/api-security-node-adapter-native12-node24.json).

The tracer worktree is ../dd-trace-js-api-security on ishabi/api-security-libdatadog.
HTTP and Lambda retain their existing sampling, configuration, WAF inspection and
gzip/base64 reporting. Schema extraction runs through libdatadog. Request state is
released on extraction or skip; one failing input does not discard other schemas.
Values are retained by reference until extraction, so application mutations made
after collection are visible. This PoC supports JSON-serializable data, not complete
native marshalling parity for unsupported JS values.

The current tracer lifecycle still activates collection through AppSec. Enabling
collection when AppSec is disabled is a separate integration step; the shared
engine itself has no AppSec dependency.

For local packed tracer tests, generate both unpublished packages together:

```sh
node scripts/pack-api-security-poc.js ../dd-trace-js-api-security/.api-security-poc
```

Set the tracer's existing optional @datadog/libdatadog dependency to the printed
libdatadog file locator, then run yarn install in the worktree. The helper packs
the WASM artifact too, pins its absolute local tarball path inside the wrapper
tarball, and uses content hashes to avoid stale package-manager caches.
These local paths must be replaced with published package versions before CI
or distribution. The core remains pinned to the committed libdatadog revision.

[RFC-1089](https://docs.google.com/document/d/1KtKga2wAK2GnpyvDxbw1mFTY7UQdyyffBy_8dSeZwVk/edit)
(Improving WAF Timeouts and Truncations Management) is a production
follow-up. Input byte/work budgets, end-to-end time accounting and explicit
partial-result diagnostics should be added before lifting the current input
compatibility caps. Schema shape limits are a distinct contract. The PoC does
not claim RFC compliance.


Final tracer validation on Node 24.5.0:
- npm run test:trace:core: 6,207 passed, 8 existing pending.
- npm run test:appsec: 2,307 passed, 2 existing pending.
- HTTP extraction/normalized-route matrix: 522 passed, 398 existing pending.
- npm run test:lambda: 291 passed.
- License checker and extraction error-boundary regressions: 24 passed.
- npm run lint: passed; existing CODEOWNERS warnings remain.
- lint:editorconfig could not run because the Docker daemon is unavailable.

The broader Express/Fastify RASP matrix exposed SSRF failures reproduced with
unchanged source at the worktree base. They are outside this change, as agreed.
No tests were skipped or assertions weakened to pass the schema integration.
The original dd-trace-js checkout remains clean; no PR was created.
