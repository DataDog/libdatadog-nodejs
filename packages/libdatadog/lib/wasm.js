'use strict'

const binding = require('@datadog/libdatadog-wasm')

/** @typedef {typeof import('@datadog/libdatadog-wasm/zstd')} ZstdBinding */

/** @type {ZstdBinding | undefined} */
let zstdBinding

module.exports = {
  backend: () => 'wasm',
  DDSketch: binding.DDSketch,
  createAgentlessExporter,
  supportsAgentlessStats: true,
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
  zstdBinding ??= require('@datadog/libdatadog-wasm/zstd')
  return zstdBinding.zstd_compress(data, level)
}
