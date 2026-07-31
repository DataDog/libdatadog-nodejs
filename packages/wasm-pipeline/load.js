'use strict'

// TODO: Extract this file to an external library, shared with the loader at the
// repository root.

const { existsSync } = require('node:fs')
const path = require('node:path')

// The indirection through `runtimeRequire` is what keeps a bundler from pulling
// the wasm glue into its output, so this package resolves its module at runtime
// rather than exporting `require('./prebuilds/pipeline/pipeline.js')` directly.
const inWebpack = typeof __webpack_require__ === 'function'
const runtimeRequire = inWebpack ? __non_webpack_require__ : require

function maybeLoad (name) {
  try {
    return load(name)
  } catch {
    // Not found, skip.
  }
}

function load (name) {
  const filename = find(name)

  if (filename) {
    return runtimeRequire(filename)
  }

  throw new Error(`Could not find a ${name} WASM module.`)
}

// TODO: `find` exists for API parity with the loader at the repository root,
// which needs it to locate the crashtracker receiver binary. Nothing consumes it
// here, so drop it once callers stop treating the two loaders as interchangeable.
function find (name) {
  // see https://github.com/rust-lang/cargo/issues/12780
  const filename = `${name.replaceAll('-', '_')}.js`
  const file = path.join(__dirname, 'prebuilds', name, filename)

  if (existsSync(file)) return file
}

module.exports = { find, load, maybeLoad }
