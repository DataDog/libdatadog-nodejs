'use strict'

const path = require('path')
const find = require('node-gyp-build').path

const runtimeRequire = typeof __webpack_require__ === 'function'
  ? __non_webpack_require__
  : require
const root = find(__dirname).split(path.sep).slice(0, -1).join(path.sep)

function load (name) {
  try {
    return runtimeRequire(path.join(root, `${name}-napi.node`))
  } catch (e) {
    // Unsupported on the current platform.
  }
}

module.exports = load
