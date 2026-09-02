'use strict'

const binding = require('@datadog/libdatadog-wasm')

const { remoteConfigFetcher } = require('./remote-config')

module.exports = {
  backend: () => 'wasm',
  DDSketch: binding.DDSketch,
  RemoteConfigFetcher: remoteConfigFetcher(binding),
  createAgentlessExporter,
  zstd_compress: binding.zstd_compress,
}

/** @param {import('../index').AgentlessExporterOptions} options */
function createAgentlessExporter (options) {
  return require('./agentless').createAgentlessExporter(binding, options)
}
