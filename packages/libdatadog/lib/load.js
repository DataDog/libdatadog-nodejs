'use strict'

let native

try {
  native = require('./native')
} catch {
  native = undefined
}

module.exports = {
  ...(native ?? require('./wasm')),
  createAgentlessExporter,
}

/** @param {import('../index').AgentlessExporterOptions} options */
function createAgentlessExporter (options) {
  return require('./wasm').createAgentlessExporter(options)
}
