// Lazy `require('node:fs')` — see http_transport.js. The cached accessor
// avoids paying the module-resolution cost on every call.

'use strict'

let _fs
function fs () {
  return _fs ??= require('node:fs')
}

module.exports.readFile = function (path) {
  return fs().promises.readFile(path)
}

module.exports.writeFile = function (path, data) {
  // Copy off the wasm-memory view before the async write; a memory grow would
  // otherwise detach the underlying ArrayBuffer mid-write.
  return fs().promises.writeFile(path, Buffer.from(data))
}

module.exports.metadata = function (path) {
  return fs().promises.stat(path, { bigint: true }).then(s => ({
    size: s.size,
    inode: s.ino,
    is_file: s.isFile(),
    is_dir: s.isDirectory(),
  }))
}

module.exports.exists = function (path) {
  return fs().promises.stat(path).then(
    () => true,
    (error) => {
      if (error && error.code === 'ENOENT') return false
      throw error
    },
  )
}
