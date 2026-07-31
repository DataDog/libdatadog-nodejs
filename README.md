# libdatadog-nodejs

Node.js bindings for [libdatadog](https://github.com/DataDog/libdatadog).

## Packages

This repository publishes two packages, versioned in lockstep:

* [`@datadog/libdatadog`](https://www.npmjs.com/package/@datadog/libdatadog) — the
  native (Node-API) bindings, plus the `library_config` and `datadog-js-zstd`
  WebAssembly modules.
* [`@datadog/libdatadog-wasm-pipeline`](https://www.npmjs.com/package/@datadog/libdatadog-wasm-pipeline) — the
  WebAssembly trace pipeline, carved out so that consumers of it do not also
  install the per-platform native binaries.

Neither package depends on the other, and both expose the same loader API.

## Installing

This project is currently meant to be used only by [dd-trace-js](https://github.com/DataDog/dd-trace-js)
and installing it directly is not supported at the moment.
