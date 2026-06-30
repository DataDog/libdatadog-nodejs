const http = require('node:http')
const https = require('node:https')

let storage = f => f()

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

module.exports.httpRequest = function (host, port, isHttps, socketPath, head_ptr, head_len, body_ptr, body_len, wasm_memory) {
  // A non-empty socketPath routes over a Unix domain socket (or Windows named
  // pipe) instead of TCP. Sockets are always plaintext HTTP/1.1, so https is
  // ignored in that mode.
  const useSocket = typeof socketPath === 'string' && socketPath.length > 0
  const transport = useSocket ? http : (isHttps ? https : http)

  function attempt () {
    return new Promise((resolve, reject) => {
      storage(() => {
        // wasm_memory.buffer is replaced each time WebAssembly.Memory grows, so
        // the views must be recreated on every attempt against the current buffer.
        const headView = new Uint8Array(wasm_memory.buffer, head_ptr, head_len)
        const bodyView = new Uint8Array(wasm_memory.buffer, body_ptr, body_len)

        // host/port (or socketPath) drive connection selection; method/path/
        // headers are placeholders because we replace the rendered head below.
        const requestOptions = useSocket
          ? { socketPath, method: 'POST', path: '/' }
          : { host, port, method: 'POST', path: '/' }
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

        // Bypass Node's headers: the Rust side has already produced the full
        // request head in HTTP/1.1 wire format. Setting _header before write()
        // makes write/end skip _implicitHeader and _send prepends our bytes.

        try {
          req._header = Buffer.from(headView)
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
