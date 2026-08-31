'use strict'

const binding = require('@datadog/libdatadog-wasm')

module.exports = {
  backend: () => 'wasm',
  DDSketch: binding.DDSketch,
  createAgentlessExporter,
  zstd_compress: binding.zstd_compress,
}

/** @param {import('../index').AgentlessExporterOptions} options */
function createAgentlessExporter (options) {
  return require('./agentless').createAgentlessExporter(binding, options)
}
