# libdatadog-nodejs

Node.js bindings for [libdatadog](https://github.com/DataDog/libdatadog).

## Installing

This project is currently meant to be used only by [dd-trace-js](https://github.com/DataDog/dd-trace-js)
and installing it directly is not supported at the moment.

## Pipeline

`WasmSpanState#sendEncodedTraces(data)` accepts an owned `Uint8Array` containing a v0.4 MessagePack array32 payload.
It forwards the payload directly when no configured feature needs span objects. Native stats decode it for aggregation,
and alternate output formats decode it before transforming and sending it through the configured exporter.
Only one trace send may be active per state; an overlapping call rejects with an `already in flight` error.

`WasmSpanState#setAgentlessEndpoint(url, apiKey)` selects direct trace intake before the first send.
The binding reads obfuscation settings from Node.js `process.env` through its environment capability;
libdatadog normalizes and obfuscates spans before emitting JSON to the configured intake. Structured
AppSec metadata remains attached to the emitted spans.
