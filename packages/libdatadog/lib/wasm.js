'use strict'

const binding = require('@datadog/libdatadog-wasm')

const { createAgentlessExporter } = require('./agentless')

module.exports = {
  backend: () => 'wasm',
  DDSketch: binding.DDSketch,
  createAgentlessExporter: options => createAgentlessExporter(binding, options),
  zstd_compress: binding.zstd_compress,
}
