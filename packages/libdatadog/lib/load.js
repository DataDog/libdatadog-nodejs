'use strict'

let native

try {
  native = require('./native')
} catch {
  native = undefined
}

module.exports = native ?? require('./wasm')
