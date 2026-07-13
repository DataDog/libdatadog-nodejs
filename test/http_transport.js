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
    return transport.httpRequest('127.0.0.1', port, false, '', 0, head.length, 0, 0, fakeWasmMemory(head))
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
    const [status] = await transport.httpRequest('[::1]', port, false, '', 0, head.length, 0, 0, fakeWasmMemory(head))
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
      '', 0, false, socketPath, 0, head.length, 0, 0, fakeWasmMemory(head),
    )
    assert.strictEqual(status, 200)
    assert.strictEqual(Buffer.from(body).toString('utf8'), RESPONSE_BODY)
  })
})

// Node's side of entity-input collection. The values gathered here are pushed
// to libdatadog (in Rust) via `getEntityInputs`, and libdatadog does the
// container-id regex, `ci-`/`in-` composition, external-env sanitization and
// header rendering. Coverage of that Rust logic lives in
// libdd-common's entity_id::parse tests.
const { collectEntityInputs } = transport

const DOCKER_CGROUP = '12:memory:/docker/3726184226f5d3147c25fdeab5b60097e378e8a720503a5e19ecfdf29f869860'

function writeTmpCgroup (contents) {
  const p = path.join(os.tmpdir(), `ldn-cgroup-${process.pid}-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(p, contents)
  return p
}

describe('http_transport collectEntityInputs', () => {
  it('returns the raw cgroup contents when the file exists', () => {
    const cgroupPath = writeTmpCgroup(DOCKER_CGROUP)
    try {
      const inputs = collectEntityInputs({
        cgroupPath,
        cgroupMount: '/nonexistent',
        externalEnv: undefined,
      })
      assert.strictEqual(inputs.cgroupContent, DOCKER_CGROUP)
      // The stat target didn't exist, so inode should be missing.
      assert.strictEqual(inputs.cgroupInode, undefined)
      assert.strictEqual(inputs.externalEnv, undefined)
    } finally {
      fs.rmSync(cgroupPath, { force: true })
    }
  })

  it('returns an inode when the mount subpath is statable', () => {
    // Point cgroupMount at an existing directory (os.tmpdir()) whose entry
    // for a subdirectory we control is the /docker/... suffix of the fake
    // cgroup line. Building the "mount" directory is easier than mocking fs.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldn-mount-'))
    const sub = path.join(dir, 'docker', '3726184226f5d3147c25fdeab5b60097e378e8a720503a5e19ecfdf29f869860')
    fs.mkdirSync(sub, { recursive: true })
    const cgroupPath = writeTmpCgroup(DOCKER_CGROUP)
    try {
      const inputs = collectEntityInputs({
        cgroupPath,
        cgroupMount: dir,
        externalEnv: undefined,
      })
      assert.strictEqual(inputs.cgroupContent, DOCKER_CGROUP)
      assert.strictEqual(typeof inputs.cgroupInode, 'number')
      assert.strictEqual(inputs.cgroupInode, fs.statSync(sub).ino)
    } finally {
      fs.rmSync(cgroupPath, { force: true })
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined fields when nothing is readable', () => {
    const inputs = collectEntityInputs({
      cgroupPath: '/nonexistent',
      cgroupMount: '/nonexistent',
      externalEnv: undefined,
    })
    assert.strictEqual(inputs.cgroupContent, undefined)
    assert.strictEqual(inputs.cgroupInode, undefined)
    assert.strictEqual(inputs.externalEnv, undefined)
  })

  it('passes DD_EXTERNAL_ENV through verbatim — sanitization happens in Rust', () => {
    // Node forwards the raw value; libdd-common's sanitize_external_env
    // decides whether to accept or drop it.
    const inputs = collectEntityInputs({
      cgroupPath: '/nonexistent',
      cgroupMount: '/nonexistent',
      externalEnv: 'ok\r\nx-evil: 1',
    })
    assert.strictEqual(inputs.externalEnv, 'ok\r\nx-evil: 1')
  })
})
