'use strict'

const binding = require('@datadog/libdatadog-wasm')

module.exports = {
  backend: () => 'wasm',
  DDSketch: binding.DDSketch,
  zstd_compress: binding.zstd_compress,
}
