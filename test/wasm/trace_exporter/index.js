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
let receivedBytes = -1
const server = http.createServer((req, res) => {
  let body = []
  req.on('data', chunk => body.push(chunk))
  req.on('end', () => {
    receivedBytes = Buffer.concat(body).length
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

    // send() resolves to the agent response body (or the sentinel 'unchanged');
    // either way a successful round-trip yields a truthy string, and the mock
    // agent must have actually received the payload bytes.
    assert.ok(result, 'send() returned a truthy agent response')
    assert.strictEqual(typeof result, 'string', 'send() result is a string')
    assert.ok(receivedBytes >= 0, 'mock agent received the trace request')
    console.log('Trace export result:', result)
    console.log('PASS: wasm trace exporter integration test')
  } catch (err) {
    console.error('Test error:', err)
    process.exitCode = 1
  } finally {
    server.close()
  }

  // The wasm trace exporter keeps the event loop alive after a send (its
  // runtime machinery has no shutdown on wasm), so exit explicitly once the
  // assertions are done — mirrors --test-force-exit for the node:test files.
  process.exit(process.exitCode || 0)
})
