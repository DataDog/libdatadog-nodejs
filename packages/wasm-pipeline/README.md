# @datadog/libdatadog-wasm-pipeline

The WebAssembly trace pipeline binding for [libdatadog](https://github.com/DataDog/libdatadog):
span management, the change buffer protocol, and trace export.

It is carved out of [`@datadog/libdatadog`](https://www.npmjs.com/package/@datadog/libdatadog)
so that consumers of the trace pipeline do not also pull in the per-platform
native binaries. The two packages are versioned in lockstep, neither depends on
the other, and both expose the same loader API:

```js
const pipeline = require('@datadog/libdatadog-wasm-pipeline').load('pipeline')
```

Everything else libdatadog-nodejs builds — the native Node-API bindings and the
remaining WebAssembly modules — stays in `@datadog/libdatadog`.

## Installing

This project is currently meant to be used only by [dd-trace-js](https://github.com/DataDog/dd-trace-js)
and installing it directly is not supported at the moment.

## Development

Sources live in the [libdatadog-nodejs](https://github.com/DataDog/libdatadog-nodejs)
repository; see its `DEVELOPMENT.md`.
