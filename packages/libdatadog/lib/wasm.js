'use strict'

const binding = require('../dist/wasm/libdatadog_wasm')

module.exports = {
  backend: () => 'wasm',
  DDSketch: binding.DDSketch,
  zstd_compress: binding.zstd_compress,
}
