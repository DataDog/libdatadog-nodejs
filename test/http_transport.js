'use strict'

// Unit tests for the response-header observer hook in the WASM HTTP transport
// shim. The shim is plain CommonJS (no wasm needed), so we drive `httpRequest`
// directly against a local HTTP server. `httpRequest` reads the request head
// from a Uint8Array view over `wasm_memory.buffer`, so we hand it a fake memory
// object containing a well-formed HTTP/1.1 request head.

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const transport = require('../crates/capabilities/src/http_transport')

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
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
  })

  after(() => new Promise(resolve => server.close(resolve)))

  beforeEach(() => {
    transport.setResponseHeaderObserver(null)
  })

  function doRequest () {
    const head = Buffer.from(
      `POST /v0.4/traces HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
      + 'Content-Length: 0\r\nConnection: close\r\n\r\n',
      'utf8',
    )
    // head occupies [0, head.length); body is empty (offset 0, length 0).
    // Empty socketPath -> TCP transport.
    return transport.httpRequest('127.0.0.1', port, false, '', true, 0, head.length, 0, 0, fakeWasmMemory(head))
  }

  it('invokes the observer with the raw response headers', async () => {
    let observed
    transport.setResponseHeaderObserver((rawHeaders) => {
      observed = rawHeaders
    })

    await doRequest()

    assert.ok(Array.isArray(observed), 'observer received the raw headers array')
    const idx = observed.findIndex(h => h.toLowerCase() === 'datadog-container-tags-hash')
    assert.notStrictEqual(idx, -1, 'container-tags hash header present')
    assert.strictEqual(observed[idx + 1], 'testhash123')
  })

  it('still delivers the response when the observer throws, logging the error', async () => {
    transport.setResponseHeaderObserver(() => {
      throw new Error('boom')
    })

    const originalWrite = process.stderr.write
    let logged = ''
    process.stderr.write = (chunk) => {
      logged += chunk
      return true
    }
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
    transport.setResponseHeaderObserver(() => {
      throw 'boom'
    })

    const originalWrite = process.stderr.write
    let logged = ''
    process.stderr.write = (chunk) => {
      logged += chunk
      return true
    }
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

// libdatadog derives the request host from the agent URI, which keeps the
// brackets for an IPv6 literal (`[::1]`). Node's http.request treats `host` as a
// name to resolve, so `[::1]` fails with ENOTFOUND; the transport must strip the
// brackets. Verified by connecting to an IPv6 loopback server with a bracketed
// host. Skipped where IPv6 loopback isn't available.
describe('http_transport IPv6 host', () => {
  let server
  let port
  let ipv6Available = true

  before(async () => {
    server = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => res.end(RESPONSE_BODY))
    })
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '::1', resolve)
      })
      port = server.address().port
    } catch {
      ipv6Available = false
    }
  })

  after(() => new Promise(resolve => (server ? server.close(resolve) : resolve())))

  it('strips brackets from an IPv6 host so http.request can connect', async function () {
    if (!ipv6Available) return this.skip?.()
    const head = Buffer.from(
      `POST /v0.4/traces HTTP/1.1\r\nHost: [::1]:${port}\r\n`
      + 'Content-Length: 0\r\nConnection: close\r\n\r\n',
      'utf8',
    )
    // Bracketed IPv6 host, exactly as libdatadog passes it from the agent URI.
    const [status] = await transport.httpRequest('[::1]', port, false, '', true, 0, head.length, 0, 0, fakeWasmMemory(head))
    assert.strictEqual(status, 200)
  })
})

// The transport must NOT require instrumentable builtins (node:http/https/fs) at
// module load: it is loaded during the tracer's own init, before user code, so
// an eager require makes dd-trace wrap the builtin in place and leaks
// instrumentation into a user app that imports it afterwards (breaks the
// dd-trace-js init/guardrail expectations). They must be required lazily, inside
// the functions that use them.
describe('http_transport lazy builtin requires', () => {
  it('does not require node:http/https/fs at module load', () => {
    const Module = require('node:module')
    const modPath = require.resolve('../crates/capabilities/src/http_transport')
    const orig = Module.prototype.require
    const seen = []
    Module.prototype.require = function (id) {
      seen.push(id)
      return Reflect.apply(orig, this, arguments)
    }
    try {
      delete require.cache[modPath]
      require(modPath)
    } finally {
      Module.prototype.require = orig
      delete require.cache[modPath]
    }
    for (const builtin of ['node:http', 'node:https', 'node:fs', 'http', 'https', 'fs']) {
      assert.ok(!seen.includes(builtin), `${builtin} must not be required at module load`)
    }
  })
})

// Unix-domain-socket transport: a non-empty socketPath must route the request
// over the socket instead of TCP. Skipped on Windows (no AF_UNIX path here).
describe('http_transport unix socket', { skip: process.platform === 'win32' }, () => {
  let server
  let socketPath

  before(async () => {
    socketPath = path.join(os.tmpdir(), `libdd-uds-test-${process.pid}-${Date.now()}.sock`)
    try {
      fs.unlinkSync(socketPath)
    } catch { /* unlink is best-effort */ }
    server = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.end(RESPONSE_BODY)
      })
    })
    await new Promise(resolve => server.listen(socketPath, resolve))
  })

  after(() => new Promise(resolve => server.close(() => {
    try {
      fs.unlinkSync(socketPath)
    } catch { /* unlink is best-effort */ }
    resolve()
  })))

  it('delivers the request over a unix socket and returns the response', async () => {
    const head = Buffer.from(
      'POST /v0.4/traces HTTP/1.1\r\nHost: localhost\r\n'
      + 'Content-Length: 0\r\nConnection: close\r\n\r\n',
      'utf8',
    )
    // host/port empty/0; socketPath drives the connection.
    const [status, , body] = await transport.httpRequest(
      '', 0, false, socketPath, true, 0, head.length, 0, 0, fakeWasmMemory(head),
    )
    assert.strictEqual(status, 200)
    assert.strictEqual(Buffer.from(body).toString('utf8'), RESPONSE_BODY)
  })
})

describe('http_transport connection pooling', () => {
  let server
  let port
  let sockets

  before(async () => {
    sockets = new Set()
    server = http.createServer((req, res) => {
      sockets.add(req.socket)
      req.on('data', () => {})
      req.on('end', () => res.end(RESPONSE_BODY))
    })
    server.keepAliveTimeout = 60_000
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
  })

  after(() => new Promise(resolve => server.close(resolve)))

  // No `Connection: close`, so the connection is reusable and pooling is observable.
  function keepAliveHead () {
    return Buffer.from(
      `POST /v0.4/traces HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\n\r\n`,
      'utf8',
    )
  }

  async function poll (connectionPooling) {
    sockets.clear()
    for (let i = 0; i < 3; i++) {
      const head = keepAliveHead()
      const [status] = await transport.httpRequest(
        '127.0.0.1', port, false, '', connectionPooling, 0, head.length, 0, 0, fakeWasmMemory(head),
      )
      assert.strictEqual(status, 200)
    }
    return sockets.size
  }

  it('reuses one connection when pooling is on', async () => {
    // Node's globalAgent has keep-alive on by default since v19.
    assert.strictEqual(await poll(true), 1)
  })

  it('opens a fresh connection per request when pooling is off', async () => {
    // What a caller polling on a fixed interval asks for: the agent's short idle keep-alive can
    // close a pooled connection between polls, which turns reuse into intermittent failures.
    assert.strictEqual(await poll(false), 3)
  })
})

// Entity-header injection: container-id / entity-id / external-env detection
// (Node reads /proc + env; libdatadog's own detection is inert on wasm) and the
// rewrite of the Rust-rendered request head that carries them.
const { detectEntityHeaders, applyEntityHeaders } = transport

const DOCKER_CGROUP = '12:memory:/docker/3726184226f5d3147c25fdeab5b60097e378e8a720503a5e19ecfdf29f869860'
const DOCKER_ID = '3726184226f5d3147c25fdeab5b60097e378e8a720503a5e19ecfdf29f869860'

function writeTmpCgroup (contents) {
  const p = path.join(os.tmpdir(), `ldn-cgroup-${process.pid}-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(p, contents)
  return p
}

function headBytes (lines) {
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1')
}

describe('http_transport entity headers', () => {
  describe('detectEntityHeaders', () => {
    it('extracts a docker container-id and derives ci-<id> entity-id', () => {
      const cgroupPath = writeTmpCgroup(DOCKER_CGROUP)
      try {
        const h = detectEntityHeaders({ cgroupPath, cgroupMount: '/nonexistent', externalEnv: undefined })
        assert.strictEqual(h['datadog-container-id'], DOCKER_ID)
        assert.strictEqual(h['datadog-entity-id'], `ci-${DOCKER_ID}`)
        assert.strictEqual('datadog-external-env' in h, false)
      } finally {
        fs.rmSync(cgroupPath, { force: true })
      }
    })

    it('falls back to in-<inode> entity-id when no container-id is present', () => {
      const cgroupPath = writeTmpCgroup('0::/')
      try {
        const h = detectEntityHeaders({ cgroupPath, cgroupMount: os.tmpdir(), externalEnv: undefined })
        assert.strictEqual('datadog-container-id' in h, false)
        assert.match(h['datadog-entity-id'], /^in-\d+$/)
      } finally {
        fs.rmSync(cgroupPath, { force: true })
      }
    })

    it('emits datadog-external-env from the provided value', () => {
      const h = detectEntityHeaders({ cgroupPath: '/nonexistent', cgroupMount: '/nonexistent', externalEnv: 'it-false,cn-svc,pu-x' })
      assert.strictEqual(h['datadog-external-env'], 'it-false,cn-svc,pu-x')
    })

    it('emits nothing without cgroup, mount, or external-env', () => {
      const h = detectEntityHeaders({ cgroupPath: '/nonexistent', cgroupMount: '/nonexistent', externalEnv: undefined })
      assert.deepStrictEqual(h, {})
    })

    it('rejects an external-env containing CR/LF (header-injection guard)', () => {
      const h = detectEntityHeaders({
        cgroupPath: '/nonexistent',
        cgroupMount: '/nonexistent',
        externalEnv: 'ok\r\nx-evil: 1',
      })
      assert.strictEqual('datadog-external-env' in h, false)
    })
  })

  describe('applyEntityHeaders (head rewrite)', () => {
    const entity = {
      'datadog-container-id': DOCKER_ID,
      'datadog-entity-id': `ci-${DOCKER_ID}`,
      'datadog-external-env': 'it-false,cn-svc,pu-x',
    }

    it('appends entity headers and preserves the request line + framing headers', () => {
      const head = headBytes([
        'POST /v0.4/traces HTTP/1.1',
        'Host: localhost:8126',
        'Content-Length: 42',
        'datadog-meta-lang: nodejs',
      ])
      const out = applyEntityHeaders(head, entity).toString('latin1')
      const lines = out.split('\r\n')
      assert.strictEqual(lines[0], 'POST /v0.4/traces HTTP/1.1')
      assert.ok(lines.includes('Host: localhost:8126'))
      assert.ok(lines.includes('Content-Length: 42'))
      assert.ok(lines.includes('datadog-meta-lang: nodejs'))
      assert.ok(lines.includes(`datadog-container-id: ${DOCKER_ID}`))
      assert.ok(lines.includes(`datadog-entity-id: ci-${DOCKER_ID}`))
      assert.ok(lines.includes('datadog-external-env: it-false,cn-svc,pu-x'))
      assert.ok(out.endsWith('\r\n\r\n'))
    })

    it('replaces libdatadog\'s empty datadog-container-id instead of duplicating it', () => {
      const head = headBytes([
        'POST /v0.4/traces HTTP/1.1',
        'Host: localhost',
        'Content-Length: 0',
        'datadog-container-id: ',
      ])
      const out = applyEntityHeaders(head, entity).toString('latin1')
      const count = out.split('\r\n').filter(l => l.toLowerCase().startsWith('datadog-container-id:')).length
      assert.strictEqual(count, 1)
      assert.ok(out.includes(`datadog-container-id: ${DOCKER_ID}`))
    })

    it('returns the head unchanged when no entity headers are detected', () => {
      const head = headBytes(['POST / HTTP/1.1', 'Host: x', 'Content-Length: 0'])
      const out = applyEntityHeaders(head, {})
      assert.deepStrictEqual(out, Buffer.from(head))
    })

    it('leaves a malformed head (no terminator) untouched', () => {
      const bad = Buffer.from('POST / HTTP/1.1\r\nHost: x', 'latin1')
      const out = applyEntityHeaders(bad, entity)
      assert.deepStrictEqual(out, Buffer.from(bad))
    })
  })

  describe('httpRequest end-to-end (real transport)', () => {
    let server
    let port
    let received
    const prevExternalEnv = process.env.DD_EXTERNAL_ENV

    before(async () => {
      // Set the env then clear the memoized detection so this request re-reads
      // it (earlier tests may have already populated the cache).
      process.env.DD_EXTERNAL_ENV = 'it-false,cn-e2e,pu-1'
      transport._resetEntityHeadersCache()
      server = http.createServer((req, res) => {
        received = req.headers
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      port = server.address().port
    })

    after(() => new Promise(resolve => server.close(() => {
      if (prevExternalEnv === undefined) delete process.env.DD_EXTERNAL_ENV
      else process.env.DD_EXTERNAL_ENV = prevExternalEnv
      transport._resetEntityHeadersCache()
      resolve()
    })))

    it('sends the detected entity headers on the wire (via the Rust-rendered head)', async () => {
      const body = Buffer.from('[]', 'latin1')
      const head = Buffer.from(
        `POST /v0.4/traces HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: ${body.length}\r\n`
        + 'datadog-meta-lang: nodejs\r\ndatadog-container-id: \r\n\r\n',
        'latin1',
      )
      const mem = new ArrayBuffer(head.length + body.length)
      const view = new Uint8Array(mem)
      view.set(head, 0)
      view.set(body, head.length)

      const [status] = await transport.httpRequest(
        '127.0.0.1', port, false, '', true, 0, head.length, head.length, body.length, { buffer: mem },
      )
      assert.strictEqual(status, 200)
      assert.strictEqual(received['datadog-meta-lang'], 'nodejs')
      assert.strictEqual(received['datadog-external-env'], 'it-false,cn-e2e,pu-1')
      const detected = detectEntityHeaders()
      if (detected['datadog-container-id']) {
        assert.strictEqual(received['datadog-container-id'], detected['datadog-container-id'])
      }
    })
  })
})
