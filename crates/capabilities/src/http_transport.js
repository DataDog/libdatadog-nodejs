// NOTE: `node:http`, `node:https` and `node:fs` are deliberately NOT required at
// module load. This transport is loaded during the tracer's own init (before
// user code runs), and requiring an instrumented builtin here makes dd-trace
// wrap it in place immediately — so a user app that imports `http` afterwards
// (e.g. an ESM app under `--require`) sees the wrapped builtin and gets
// instrumented when it should not (breaks the init/guardrail expectations). The
// JS agent exporter requires these lazily (at first send) for the same reason;
// mirror that by requiring them inside the functions that use them below.

let storage = f => f()

// libdatadog's automatic container-id / entity-id detection (libdd-common's
// entity_id module) is gated `#[cfg(unix)]` and therefore inert on the
// `wasm32-unknown-unknown` target we build for, and `DD_EXTERNAL_ENV` is also
// unreachable from wasm. Node, however, can read `/proc` and `process.env`, so
// we detect the same values here and add them as the standard Datadog exporter
// headers (`datadog-container-id`, `datadog-entity-id`, `datadog-external-env`)
// — the headers native libdatadog adds via `Endpoint::set_standard_headers`.
//
// The detection mirrors dd-trace-js's `exporters/common/docker.js` (the proven
// legacy-exporter path) and libdd-common's `compute_entity_id`
// (`ci-<container_id>` else `in-<cgroup_inode>`).

// The second alternative is the PCF / Garden regexp; no suffix ($) to avoid
// matching pod UIDs. See
// https://github.com/DataDog/datadog-agent/blob/7.40.x/pkg/util/cgroups/reader.go#L50
const uuidSource = String.raw`[0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12}|[0-9a-f]{8}(?:-[0-9a-f]{4}){4}$`
const containerSource = '[0-9a-f]{64}'
const taskSource = String.raw`[0-9a-f]{32}-\d+`
const lineReg = /^(\d+):([^:]*):(.+)$/m
const entityReg = new RegExp(String.raw`.*(${uuidSource}|${containerSource}|${taskSource})(?:\.scope)?$`, 'm')

// Detect the entity headers. Parameterized for unit testing; production callers
// use the cached `getEntityHeaders()` with the real cgroup paths / environment.
function detectEntityHeaders (opts = {}) {
  const fs = require('node:fs')
  const cgroupPath = opts.cgroupPath ?? '/proc/self/cgroup'
  const cgroupMount = opts.cgroupMount ?? '/sys/fs/cgroup'
  const externalEnv = 'externalEnv' in opts ? opts.externalEnv : process.env.DD_EXTERNAL_ENV

  const headers = {}

  let cgroup = ''
  let containerId
  try {
    cgroup = fs.readFileSync(cgroupPath, 'utf8').trim()
    containerId = cgroup.match(entityReg)?.[1]
  } catch { /* not in a cgroup, or not Linux */ }

  let inode = 0
  const inodePath = cgroup.match(lineReg)?.[3]
  if (inodePath) {
    const strippedPath = inodePath.replaceAll(/^\/|\/$/g, '')
    try {
      inode = fs.statSync(`${cgroupMount}/${strippedPath}`).ino
    } catch { /* mount not present */ }
  }

  // `ci-<container_id>` when a container id is found, else `in-<cgroup_inode>`
  // — matching libdd-common's `compute_entity_id`.
  const entityId = containerId ? `ci-${containerId}` : (inode ? `in-${inode}` : undefined)

  if (containerId) headers['datadog-container-id'] = containerId
  if (entityId) headers['datadog-entity-id'] = entityId
  // Only emit external-env if it is a clean header value (visible ASCII + space/
  // tab). This rejects CR/LF (header-injection / request-smuggling vector) and
  // non-latin1 that the latin1-encoded head rewrite couldn't represent — native
  // libdatadog likewise rejects invalid bytes via the http crate's HeaderValue.
  if (externalEnv && /^[\t\u0020-\u007E]*$/.test(externalEnv)) {
    headers['datadog-external-env'] = externalEnv
  }

  return headers
}

let cachedEntityHeaders
function getEntityHeaders () {
  if (cachedEntityHeaders === undefined) {
    cachedEntityHeaders = detectEntityHeaders()
  }
  return cachedEntityHeaders
}

// Rewrite the Rust-rendered HTTP/1.1 request head (a `\r\n`-delimited byte
// buffer terminated by a blank line) to carry the detected entity headers.
// Any pre-existing line for a name we set is dropped first, so libdatadog's
// empty `datadog-container-id` is replaced rather than duplicated. Header
// names/values are ASCII, so latin1 is a lossless round-trip.
function applyEntityHeaders (headView, entity = getEntityHeaders()) {
  const names = Object.keys(entity)
  if (names.length === 0) return Buffer.from(headView)

  const head = Buffer.from(headView).toString('latin1')
  const term = head.indexOf('\r\n\r\n')
  if (term === -1) return Buffer.from(headView) // malformed; leave untouched

  const drop = new Set(names)
  const lines = head.slice(0, term).split('\r\n')
  const kept = lines.filter((line, i) => {
    if (i === 0) return true // request line
    const colon = line.indexOf(':')
    const name = (colon === -1 ? line : line.slice(0, colon)).trim().toLowerCase()
    return !drop.has(name)
  })
  for (const name of names) kept.push(`${name}: ${entity[name]}`)

  return Buffer.from(`${kept.join('\r\n')}\r\n\r\n`, 'latin1')
}

// Parse the Rust-rendered (+ entity-merged) HTTP/1.1 request head into Node
// request options `{ method, path, headers }`. We pass these to
// `http.request(...)` rather than injecting the raw head via the Node-internal
// `req._header`: that internal is undocumented and Bun's `node:http` ignores it,
// so under Bun the request went out as `POST /` with no headers and the agent
// dropped it. Header names/values are ASCII (latin1 round-trips losslessly).
/**
 * @param {Buffer} headBuffer
 */
function parseRequestHead (headBuffer) {
  const head = headBuffer.toString('latin1')
  const term = head.indexOf('\r\n\r\n')
  const lines = (term === -1 ? head : head.slice(0, term)).split('\r\n')
  // Request line: `METHOD request-target HTTP/1.1` (no spaces in the target).
  const [method, path] = lines[0].split(' ')
  const headers = {}
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':')
    if (colon === -1) continue
    const name = lines[i].slice(0, colon).trim()
    if (name) headers[name] = lines[i].slice(colon + 1).trim()
  }
  return { method, path, headers }
}

// A retried write can race a wasm-memory detach; treat that as a transient error.
function isDetachedBufferError (err) {
  return err instanceof TypeError && /detached/i.test(err.message)
}

module.exports.sleep = function (ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // The exporter races this sleep against each request as a timeout guard (and
    // reuses it for retry backoff). An in-flight request refs the event loop on
    // its own, so an abandoned timeout timer (e.g. the 5-minute request-timeout
    // guard after a fast success) must not keep the host process alive.
    timer.unref?.()
  })
}

module.exports.setStorage = function (new_storage) {
  storage = new_storage
}

// Optional observer invoked with each agent response's raw headers
// (Node's flat [name, value, name, value, ...] array). Lets the host tracer
// read response-only headers (e.g. Datadog-Container-Tags-Hash) that are not
// otherwise surfaced through the wasm response body. Never throws into the
// transport: a misbehaving observer must not break trace delivery.
//
// The observer runs synchronously on the response 'end' event, so it must be
// non-blocking and return quickly — long-running synchronous work here would
// stall the event loop.
let responseHeaderObserver

module.exports.setResponseHeaderObserver = function (new_observer) {
  responseHeaderObserver = new_observer
}

// Exposed for unit tests.
module.exports.detectEntityHeaders = detectEntityHeaders
module.exports.applyEntityHeaders = applyEntityHeaders
module.exports._resetEntityHeadersCache = () => {
  cachedEntityHeaders = undefined
}

module.exports.httpRequest = function (host, port, isHttps, socketPath, connectionPooling, head_ptr, head_len, body_ptr, body_len, wasm_memory) {
  // A non-empty socketPath routes over a Unix domain socket (or Windows named
  // pipe) instead of TCP. Sockets are always plaintext HTTP/1.1, so https is
  // ignored in that mode.
  const http = require('node:http')
  const https = require('node:https')
  // libdatadog derives `host` from the agent URI, which keeps the brackets for
  // an IPv6 literal (e.g. `[::1]`). Node's `http.request` treats the `host`
  // option as a hostname to resolve, so `[::1]` fails with ENOTFOUND. Strip the
  // brackets so the IPv6 address is used directly (Node accepts `::1`).
  if (typeof host === 'string' && host.length > 1 && host[0] === '[' && host.at(-1) === ']') {
    host = host.slice(1, -1)
  }
  const useSocket = typeof socketPath === 'string' && socketPath.length > 0
  const transport = useSocket ? http : (isHttps ? https : http)

  function attempt () {
    return new Promise((resolve, reject) => {
      storage(() => {
        // wasm_memory.buffer is replaced each time WebAssembly.Memory grows, so
        // the views must be recreated on every attempt against the current buffer.
        const headView = new Uint8Array(wasm_memory.buffer, head_ptr, head_len)
        // Copy the body into Node-owned memory before giving it to http.request.
        // `body_ptr/body_len` points into wasm memory; if that memory grows while
        // Node still has the write queued, the original ArrayBuffer detaches and
        // ClientRequest can throw asynchronously from `_flushOutput`, outside the
        // `req.write()` try/catch/retry path.
        const body = Buffer.from(new Uint8Array(wasm_memory.buffer, body_ptr, body_len))

        // The Rust side already rendered the full HTTP/1.1 request head (real
        // method, `/v0.4/traces` path, Content-Type/Length, datadog-meta-*);
        // applyEntityHeaders merges in the detected entity headers. Parse it into
        // request options so the connection uses the correct method/path/headers
        // on both Node and Bun (host/port or socketPath drive the connection).
        const { method, path, headers } = parseRequestHead(applyEntityHeaders(headView))
        // `agent: false` gives this request its own short-lived agent rather than the global
        // keep-alive one, which is what a caller asking for no connection pooling wants.
        const requestOptions = useSocket
          ? { socketPath, method, path, headers }
          : { host, port, method, path, headers }
        if (!connectionPooling) requestOptions.agent = false
        const req = transport.request(requestOptions, (res) => {
          const chunks = []
          res.on('data', chunk => chunks.push(chunk))
          res.on('end', () => {
            const body = Buffer.concat(chunks)
            if (responseHeaderObserver) {
              try {
                responseHeaderObserver(res.rawHeaders)
              } catch (error) {
                // Only read `err.message` (a string) rather than stringifying an
                // arbitrary thrown value, so a hostile/throwing toString on the
                // error can't turn the log line into its own failure path.
                process.stderr.write('responseHeaderObserver error: ' + (error && error.message) + '\n')
              }
            }
            resolve([
              res.statusCode,
              res.rawHeaders,
              // Buffer is a Uint8Array with exact byteOffset and byteLength.
              // Rust copies it into Bytes before this response is released.
              body,
            ])
          })
        })
        req.on('error', reject)

        // The request head (method/path/headers) was supplied via requestOptions
        // above; just write the stable Node-owned body. (No `req._header`
        // injection — that Node internal is not honored by Bun.)
        try {
          req.write(body)
          req.end()
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  function attemptWithRetry () {
    return attempt().catch((error) => {
      process.stderr.write('httpRequest error: ' + error + '\n')
      if (isDetachedBufferError(error)) {
        return attemptWithRetry()
      }
      throw error
    })
  }

  return attemptWithRetry()
}
