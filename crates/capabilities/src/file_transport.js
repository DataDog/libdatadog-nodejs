// Lazy `require('node:fs')` — see http_transport.js.

'use strict'

module.exports.readFile = function (path) {
  const fs = require('node:fs')
  return fs.promises.readFile(path)
}

module.exports.writeFile = function (path, data) {
  const fs = require('node:fs')
  // Copy off the wasm-memory view before the async write; a memory grow would
  // otherwise detach the underlying ArrayBuffer mid-write.
  return fs.promises.writeFile(path, Buffer.from(data))
}

module.exports.metadata = function (path) {
  const fs = require('node:fs')
  try {
    const s = fs.statSync(path)
    return Promise.resolve({
      size: Number(s.size),
      inode: Number(s.ino),
      is_file: s.isFile(),
      is_dir: s.isDirectory(),
    })
  } catch (error) {
    return Promise.reject(error)
  }
}

module.exports.exists = function (path) {
  const fs = require('node:fs')
  return fs.promises.stat(path).then(
    () => true,
    (error) => {
      if (error && error.code === 'ENOENT') return false
      throw error
    },
  )
}
