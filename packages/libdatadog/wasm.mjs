import libdatadog from './wasm.js'

export const {
  backend,
  createAgentlessExporter,
  DDSketch,
  supportsAgentlessStats,
  zstd_compress,
} = libdatadog

export { default } from './wasm.js'
