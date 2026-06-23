'use strict'

// Unit tests for the response-header observer hook in the WASM HTTP transport
// shim. The shim is plain CommonJS (no wasm needed), so we drive `httpRequest`
// directly against a local HTTP server. `httpRequest` reads the request head
// from a Uint8Array view over `wasm_memory.buffer`, so we hand it a fake memory
// object containing a well-formed HTTP/1.1 request head.

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')

const transport = require('../crates/capabilities/src/http_transport.js')

// Distinctive, multi-byte body so the pooled-buffer slicing in httpRequest
// (the reason for `new Uint8Array(body)` over `body.buffer`) is exercised:
// a small Buffer.concat result lands at a non-zero offset in Node's shared pool.
const RESPONSE_BODY = '{"rate_by_service":{"service:test,env:":0.5}}'

function fakeWasmMemory (headBytes) {
  const buf = new ArrayBuffer(headBytes.length)
  new Uint8Array(buf).set(headBytes)
  return { buffer: buf }
}

describe('http_transport response header observer', () => {
  let server
  let port

  before(async () => {
    server = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.setHeader('Datadog-Container-Tags-Hash', 'testhash123')
        res.end(RESPONSE_BODY)
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
  })

  after(() => new Promise((resolve) => server.close(resolve)))

  beforeEach(() => {
    transport.setResponseHeaderObserver(null)
  })

  function doRequest () {
    const head = Buffer.from(
      `POST /v0.4/traces HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
      'Content-Length: 0\r\nConnection: close\r\n\r\n',
      'utf8'
    )
    // head occupies [0, head.length); body is empty (offset 0, length 0).
    return transport.httpRequest('127.0.0.1', port, false, 0, head.length, 0, 0, fakeWasmMemory(head))
  }

  it('invokes the observer with the raw response headers', async () => {
    let observed
    transport.setResponseHeaderObserver((rawHeaders) => { observed = rawHeaders })

    await doRequest()

    assert.ok(Array.isArray(observed), 'observer received the raw headers array')
    const idx = observed.findIndex((h) => h.toLowerCase() === 'datadog-container-tags-hash')
    assert.notStrictEqual(idx, -1, 'container-tags hash header present')
    assert.strictEqual(observed[idx + 1], 'testhash123')
  })

  it('still delivers the response when the observer throws, logging the error', async () => {
    transport.setResponseHeaderObserver(() => { throw new Error('boom') })

    const originalWrite = process.stderr.write
    let logged = ''
    process.stderr.write = (chunk) => { logged += chunk; return true }
    try {
      const [status] = await doRequest()
      assert.strictEqual(status, 200)
    } finally {
      process.stderr.write = originalWrite
    }
    assert.match(logged, /responseHeaderObserver error: boom/)
  })

  it('tolerates an observer throwing a non-Error value', async () => {
    // Hardened logging reads only err.message, so a thrown string must not
    // crash the transport (it logs `undefined` for the missing message).
    transport.setResponseHeaderObserver(() => { throw 'boom' }) // eslint-disable-line no-throw-literal

    const originalWrite = process.stderr.write
    let logged = ''
    process.stderr.write = (chunk) => { logged += chunk; return true }
    try {
      const [status] = await doRequest()
      assert.strictEqual(status, 200)
    } finally {
      process.stderr.write = originalWrite
    }
    assert.match(logged, /responseHeaderObserver error: undefined/)
  })

  it('works when no observer is registered', async () => {
    const [status] = await doRequest()
    assert.strictEqual(status, 200)
  })

  it('returns the exact response body bytes', async () => {
    const [status, , body] = await doRequest()
    assert.strictEqual(status, 200)
    assert.ok(body instanceof Uint8Array, 'body is a Uint8Array')
    // Must be exactly the agent's body — not whole-pool bytes or wrong length.
    assert.strictEqual(body.length, Buffer.byteLength(RESPONSE_BODY))
    assert.strictEqual(Buffer.from(body).toString('utf8'), RESPONSE_BODY)
  })
})
