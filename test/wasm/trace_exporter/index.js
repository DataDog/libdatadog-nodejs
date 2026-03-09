'use strict'

// This test exercises the full call flow:
//   JS -> wasm (TraceExporter logic) -> JS (http_transport.js for I/O) -> wasm -> JS
//
// To run:
//   1. Build: wasm-pack build --target nodejs ./crates/trace_exporter --out-dir ../../prebuilds/trace_exporter
//   2. Run:   node test_wasm.js trace_exporter

const http = require('http')
const loader = require('../../../load.js')
const assert = require('assert')

const traceExporter = loader.load('trace_exporter')
assert(traceExporter !== undefined, 'trace_exporter wasm module loaded')

// Start a minimal HTTP server that acts as a mock Datadog agent
const server = http.createServer((req, res) => {
  let body = []
  req.on('data', chunk => body.push(chunk))
  req.on('end', () => {
    // Return a minimal agent response
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ rate_by_service: {} }))
  })
})

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const url = `http://127.0.0.1:${port}`

  try {
    // Create a TraceExporter pointing at the mock agent
    const exporter = new traceExporter.JsTraceExporter(url, 'test-service')
    assert(exporter !== undefined, 'JsTraceExporter created')

    // Send a minimal msgpack-encoded v0.4 trace payload (empty array of traces)
    // This is msgpack for [[]] — one trace containing no spans
    const payload = new Uint8Array([0x91, 0x90])
    const result = await exporter.send(payload)

    console.log('Trace export result:', result)
    console.log('PASS: wasm trace exporter integration test')
  } catch (err) {
    console.error('Test error:', err)
    process.exitCode = 1
  } finally {
    server.close()
  }
})
