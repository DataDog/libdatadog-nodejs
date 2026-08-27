'use strict'

const binding = require('@datadog/libdatadog-wasm')

const { createAgentlessExporter } = require('./agentless')
const { remoteConfigFetcher } = require('./remote-config')

module.exports = {
  backend: () => 'wasm',
  DDSketch: binding.DDSketch,
  RemoteConfigFetcher: remoteConfigFetcher(binding),
  createAgentlessExporter: options => createAgentlessExporter(binding, options),
  zstd_compress: binding.zstd_compress,
}
