'use strict'

// The published packages are versioned in lockstep: consumers install
// @datadog/libdatadog and the carved-out wasm packages together, so a mismatch
// would ship an inconsistent set.

const path = require('node:path')

const root = require('../package.json')

const { OWN_PACKAGE } = require('./wasm-crates')

let failed = false

for (const dir of new Set(OWN_PACKAGE.values())) {
  const pkg = require(path.join('..', dir, 'package.json'))

  if (pkg.version === root.version) {
    console.log(`✔ ${pkg.name} matches ${root.name} at ${root.version}`)
  } else {
    failed = true
    console.error(`✖ ${pkg.name}@${pkg.version} does not match ${root.name}@${root.version};`
      + ' the packages must be versioned in lockstep')
  }
}

if (failed) {
  process.exitCode = 1
}
