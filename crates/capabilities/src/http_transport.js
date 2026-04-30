const http = require('http');
const https = require('https');

let storage = (f) => f();

module.exports.setStorage = function (new_storage) {
  storage = new_storage;
}

module.exports.httpRequest = function (host, port, isHttps, head_ptr, head_len, body_ptr, body_len, wasm_memory) {
  const transport = isHttps ? https : http;

  function isDetachedBufferError(err) {
    return err instanceof TypeError && /detached/i.test(err.message);
  }

  function attempt() {
    return new Promise((resolve, reject) => {
      storage(() => {
        // wasm_memory.buffer is replaced each time WebAssembly.Memory grows, so
        // the views must be recreated on every attempt against the current buffer.
        const headView = new Uint8Array(wasm_memory.buffer, head_ptr, head_len);
        const bodyView = new Uint8Array(wasm_memory.buffer, body_ptr, body_len);

        // host/port drive socket selection; method/path/headers are placeholders
        // because we replace the rendered head below.
        const req = transport.request({ host, port, method: 'POST', path: '/' }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks)
            resolve([
              res.statusCode,
              res.rawHeaders,
              new Uint8Array(body.buffer),
            ]);
          });
        });
        req.on('error', reject);

        // Bypass Node's headers: the Rust side has already produced the full
        // request head in HTTP/1.1 wire format. Setting _header before write()
        // makes write/end skip _implicitHeader and _send prepends our bytes.
        
        try {
          req._header = Buffer.from(headView);
          req.write(bodyView);
          req.end();
        } catch (err) {
          reject(err);
        }
      })
    });
  }

  function attemptWithRetry() {
    return attempt().catch((err) => {
      process.stderr.write("httpRequest error: " + err + "\n")
      if (isDetachedBufferError(err)) {
        return attemptWithRetry();
      }
      throw err;
    });
  }

  return attemptWithRetry();
};
