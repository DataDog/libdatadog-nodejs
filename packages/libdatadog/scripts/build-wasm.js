'use strict'

const os = require('node:os')
const path = require('node:path')

const { buildWasm } = require('../../../scripts/build-wasm')

const { inlineWasm } = require('./inline-wasm')

/** @typedef {{ cratePath: string, outputDirectory: string, moduleName: string }} WasmArtifact */

const repositoryRoot = path.join(__dirname, '..', '..', '..')
const artifacts = [
  {
    cratePath: path.join(repositoryRoot, 'crates', 'libdatadog-wasm'),
    outputDirectory: path.join(__dirname, '..', 'wasm', 'dist'),
    moduleName: 'libdatadog_wasm',
  },
  {
    cratePath: path.join(repositoryRoot, 'crates', 'libdatadog-wasm-zstd'),
    outputDirectory: path.join(__dirname, '..', 'wasm', 'dist', 'zstd'),
    moduleName: 'libdatadog_wasm_zstd',
  },
  {
    cratePath: path.join(repositoryRoot, 'crates', 'remote_config'),
    outputDirectory: path.join(__dirname, '..', 'wasm', 'dist', 'remote-config'),
    moduleName: 'remote_config',
  },
]

/**
 * Build and inline one WASM artifact.
 *
 * @param {WasmArtifact} artifact
 * @returns {Promise<void>}
 */
async function buildArtifact ({ cratePath, outputDirectory, moduleName }) {
  await buildWasm(cratePath, outputDirectory, {
    skipOptimization: os.platform() === 'darwin',
  })
  inlineWasm(moduleName, outputDirectory)
}

async function main () {
  await Promise.all(artifacts.map(artifact => buildArtifact(artifact)))
}

// CommonJS does not support top-level await.
// eslint-disable-next-line unicorn/prefer-top-level-await
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
