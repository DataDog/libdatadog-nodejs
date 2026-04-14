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

let requestCount = 0
let failNextN = 0

// Start a minimal HTTP server that acts as a mock Datadog agent.
// When failNextN > 0, the next N requests get a 503 (simulating transient failures).
const server = http.createServer((req, res) => {
  let body = []
  req.on('data', chunk => body.push(chunk))
  req.on('end', () => {
    requestCount++
    if (failNextN > 0) {
      failNextN--
      res.writeHead(503)
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ rate_by_service: {} }))
    }
  })
})

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const url = `http://127.0.0.1:${port}`

  // msgpack for [[]] — one trace containing no spans
  const payload = new Uint8Array([0x91, 0x90])

  try {
    // --- Construction ---
    const exporter = new traceExporter.JsTraceExporter(url, 'test-service')
    assert(exporter !== undefined, 'JsTraceExporter created')
    console.log('PASS: JsTraceExporter constructor')

    // --- Single send ---
    const result = await exporter.send(payload)
    assert(result !== undefined, 'send returned a result')
    console.log('PASS: single send')

    // --- Multiple sends (reusability) ---
    const before = requestCount
    await exporter.send(payload)
    await exporter.send(payload)
    assert(requestCount >= before + 2, `expected at least 2 more requests, got ${requestCount - before}`)
    console.log('PASS: multiple sends (exporter is reusable)')

    // --- Retry on 503 (validates SleepCapability through send_with_retry) ---
    // With the new capabilities, wasm retries use the same strategy as native:
    // max_retries: 5, delay_ms: 100ms, backoff: Exponential. Previously wasm
    // had retries disabled entirely (RetryBackoffType::Disabled, max_retries: 0).
    failNextN = 1
    const retryExporter = new traceExporter.JsTraceExporter(url, 'test-service')
    const beforeRetry = requestCount
    const retryResult = await retryExporter.send(payload)
    assert(retryResult !== undefined, 'retry send returned a result')
    assert(
      requestCount >= beforeRetry + 2,
      `expected at least 2 requests (1 fail + 1 success), got ${requestCount - beforeRetry}`
    )
    console.log('PASS: retry on 503 (SleepCapability + send_with_retry)')
    retryExporter.free()

    // --- Cleanup via free() ---
    exporter.free()
    console.log('PASS: exporter.free() (cleanup without panic)')

    console.log('\nAll trace exporter tests passed.')
  } catch (err) {
    console.error('Test error:', err)
    process.exitCode = 1
  } finally {
    server.close()
  }
})
