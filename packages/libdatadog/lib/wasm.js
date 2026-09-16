'use strict'

const binding = require('@datadog/libdatadog-wasm')

module.exports = {
  backend: () => 'wasm',
  DDSketch: binding.DDSketch,
  createAgentlessExporter,
  zstd_compress: zstdCompress,
}

/**
 * @param {import('../index').AgentlessExporterOptions} options
 * @param {import('../index').AgentlessTransportOptions} [transportOptions]
 */
function createAgentlessExporter (options, transportOptions) {
  return require('./agentless').createAgentlessExporter(binding, options, transportOptions)
}

/**
 * @param {Uint8Array} data
 * @param {number} level
 * @returns {Uint8Array}
 */
function zstdCompress (data, level) {
  return require('@datadog/libdatadog-wasm/zstd').zstd_compress(data, level)
}
