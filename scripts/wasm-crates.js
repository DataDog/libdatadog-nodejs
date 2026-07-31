'use strict'

// Where each wasm crate is published from. Only the pipeline crate is carved
// out into its own package; the rest ship in @datadog/libdatadog alongside the
// native bindings.
//
// This is the single source of truth for the mapping: `build-wasm.js` writes
// there, `check-packages.js` asserts on it, and the build-test-wasm action
// queries it for the artifact it uploads.

const path = require('node:path')

// Every crate built with wasm-pack, in build order.
const WASM_CRATES = ['library_config', 'datadog-js-zstd', 'pipeline']

const PIPELINE_PACKAGE = path.join('packages', 'wasm-pipeline')

// Crates carved out of @datadog/libdatadog, mapped to their package directory.
const OWN_PACKAGE = new Map([
  ['pipeline', PIPELINE_PACKAGE],
])

// Package directory (relative to the repository root) publishing a crate.
function packageDir (crate) {
  return OWN_PACKAGE.get(crate) ?? '.'
}

// The `prebuilds` directory a crate's output lands under. Uploading its `*` glob
// keeps the crate directory itself inside the CI artifact, which is what the
// consumers of these artifacts expect.
function prebuildsRoot (crate) {
  return path.join(packageDir(crate), 'prebuilds')
}

// Directory the crate's wasm-pack output belongs in.
function prebuildsDir (crate) {
  return path.join(prebuildsRoot(crate), crate)
}

// CI artifact name. Anything matching `prebuilds-*` is merged into the native
// package's `prebuilds` artifact by action-prebuildify, which is how the crates
// that stay in @datadog/libdatadog get published. The carved-out crates must
// therefore use a name outside that pattern.
function artifactName (crate) {
  return OWN_PACKAGE.has(crate) ? `wasm-${crate}` : `prebuilds-wasm-${crate}`
}

if (require.main === module) {
  const [flag, crate] = process.argv.slice(2)
  const queries = {
    '--package-dir': packageDir,
    '--prebuilds-root': prebuildsRoot,
    '--prebuilds-dir': prebuildsDir,
    '--artifact-name': artifactName,
  }

  if (!queries[flag] || !crate) {
    console.error(`usage: ${path.basename(__filename)} <${Object.keys(queries).join('|')}> <crate>`)
    process.exitCode = 1
  } else {
    console.log(queries[flag](crate))
  }
}

module.exports = { artifactName, packageDir, prebuildsDir, prebuildsRoot, OWN_PACKAGE, WASM_CRATES }
