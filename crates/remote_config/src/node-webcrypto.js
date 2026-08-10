'use strict'

/* eslint-disable n/no-unsupported-features/node-builtins --
 * Installing `globalThis.crypto` is the entire point of this file, and `crypto.webcrypto` is only
 * reached on the versions that lack the global. The rule flags both as newer than the declared
 * `>=18` range, which is exactly the gap being bridged.
 */

// Node exposes the WebCrypto global inside a module only from v20; on v18 `globalThis.crypto` is
// undefined there (it is present under `node -e`, which makes this easy to miss). libdatadog
// generates the fetcher's default client id with `Uuid::new_v4()`, whose wasm shim reads
// `globalThis.crypto` and has no Node fallback, so on v18 constructing a fetcher panicked and
// trapped the whole module.
//
// Install the standard global from Node's own implementation when it is missing -- the same object
// Node itself exposes one major later. An existing one is never overwritten.
module.exports.ensureWebCrypto = function ensureWebCrypto () {
  if (globalThis.crypto === undefined) {
    globalThis.crypto = require('node:crypto').webcrypto
  }
}
