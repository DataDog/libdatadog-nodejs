// NOTE: `node:http`, `node:https` and `node:fs` are deliberately NOT required at
// module load. This transport is loaded during the tracer's own init (before
// user code runs), and requiring an instrumented builtin here makes dd-trace
// wrap it in place immediately — so a user app that imports `http` afterwards
// (e.g. an ESM app under `--require`) sees the wrapped builtin and gets
// instrumented when it should not (breaks the init/guardrail expectations). The
// JS agent exporter requires these lazily (at first send) for the same reason;
// mirror that by requiring them inside the functions that use them below.

let storage = f => f()

// libdatadog's automatic container-id / entity-id / external-env detection
// (libdd-common's `entity_id` module) is gated `#[cfg(unix)]` and inert on the
// `wasm32-unknown-unknown` target we build for, and `process.env` is also
// unreachable from wasm. Node reads `/proc/self/cgroup`, stats the cgroup
// mount subpath for an inode, and reads `DD_EXTERNAL_ENV`, then hands the raw
// values to Rust via `getEntityInputs`. libdatadog does the regex, `ci-`/`in-`
// composition, external-env validation and header rendering — see
// `libdd-common/src/entity_id/parse.rs`.

// Cgroup line format `<hierarchy_id>:<controllers>:<path>`. We just need the
// path (group 3) to derive the inode-lookup subpath under `/sys/fs/cgroup`.
// `m` flag matches the first line that fits; we do not attempt controller
// preference (memory-first) because libdd-common's unix path handles that and
// this is only used in the wasm sandbox, where callers accept a best-effort
// inode.
const lineReg = /^(\d+):([^:]*):(.+)$/m

// Path arguments are parameterized for unit testing; production callers use
// the defaults, which resolve to Linux's /proc + cgroup mount.
function collectEntityInputs (opts = {}) {
  const fs = require('node:fs')
  const cgroupPath = opts.cgroupPath ?? '/proc/self/cgroup'
  const cgroupMount = opts.cgroupMount ?? '/sys/fs/cgroup'
  const externalEnv = 'externalEnv' in opts ? opts.externalEnv : process.env.DD_EXTERNAL_ENV

  let cgroupContent, cgroupInode
  try {
    cgroupContent = fs.readFileSync(cgroupPath, 'utf8').trim()
  } catch { /* not linux / not in a cgroup */ }

  const inodePath = cgroupContent && cgroupContent.match(lineReg)?.[3]
  if (inodePath) {
    const stripped = inodePath.replaceAll(/^\/|\/$/g, '')
    try {
      cgroupInode = fs.statSync(`${cgroupMount}/${stripped}`).ino
    } catch { /* mount not present */ }
  }

  return { cgroupContent, cgroupInode, externalEnv }
}

let cachedEntityInputs
module.exports.getEntityInputs = function () {
  if (cachedEntityInputs === undefined) {
    cachedEntityInputs = collectEntityInputs()
  }
  return cachedEntityInputs
}

// Parse the Rust-rendered (+ entity-merged) HTTP/1.1 request head into Node
// request options `{ method, path, headers }`. We pass these to
// `http.request(...)` rather than injecting the raw head via the Node-internal
// `req._header`: that internal is undocumented and Bun's `node:http` ignores it,
// so under Bun the request went out as `POST /` with no headers and the agent
// dropped it. Header names/values are ASCII (latin1 round-trips losslessly).
function parseRequestHead (headBuf) {
  const head = Buffer.from(headBuf).toString('latin1')
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
module.exports.collectEntityInputs = collectEntityInputs
module.exports._resetEntityInputsCache = () => {
  cachedEntityInputs = undefined
}

module.exports.httpRequest = function (host, port, isHttps, socketPath, head_ptr, head_len, body_ptr, body_len, wasm_memory) {
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
        const bodyView = new Uint8Array(wasm_memory.buffer, body_ptr, body_len)

        // The Rust side already rendered the full HTTP/1.1 request head (real
        // method, `/v0.4/traces` path, Content-Type/Length, datadog-meta-*,
        // plus entity headers seeded via `getEntityInputs`). Parse it into
        // request options so the connection uses the correct method/path/headers
        // on both Node and Bun (host/port or socketPath drive the connection).
        const { method, path, headers } = parseRequestHead(headView)
        const requestOptions = useSocket
          ? { socketPath, method, path, headers }
          : { host, port, method, path, headers }
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
              // Copy the exact body bytes. `body` is a Buffer from Buffer.concat,
              // which for small payloads is a view into Node's shared pool, so
              // `body.buffer` is the whole pool — slicing by offset/length (via
              // the Uint8Array(typedArray) copy ctor) is required to avoid
              // handing the Rust side unrelated pooled memory.
              new Uint8Array(body),
            ])
          })
        })
        req.on('error', reject)

        // The request head (method/path/headers) was supplied via requestOptions
        // above; just write the body. (No `req._header` injection — that Node
        // internal is not honored by Bun.)
        try {
          req.write(bodyView)
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
