'use strict'

// Guards the boundary between the published packages: every wasm crate must be
// packed by exactly the package that owns it, only @datadog/libdatadog ships
// native binaries, and no carved-out crate may leak back into it.
//
// Both failure modes here are silent, which is why this runs in CI:
//
// * action-prebuildify merges every artifact matching `prebuilds-*` into the
//   native package's `prebuilds` artifact. That is deliberate for the crates
//   that stay, and fatal for a carved-out one — see `wasm-crates.js`.
// * the `.gitignore` wasm-pack writes into its output directory makes npm drop
//   the whole module from the tarball.

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const { packageDir, WASM_CRATES } = require('./wasm-crates')

const NATIVE_PACKAGE = '.'

function packedFiles (dir) {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: path.join(__dirname, '..', dir),
    encoding: 'utf8',
  })

  return JSON.parse(stdout)[0].files.map(entry => entry.path)
}

// Package directory -> the wasm crates it is expected to publish.
const owned = new Map([[NATIVE_PACKAGE, []]])

for (const crate of WASM_CRATES) {
  const dir = packageDir(crate)

  if (!owned.has(dir)) owned.set(dir, [])
  owned.get(dir).push(crate)
}

let failed = false

function fail (message, files = []) {
  failed = true
  console.error(`✖ ${message}`)
  for (const file of files) {
    console.error(`    ${file}`)
  }
}

// Files a package packs for a crate, e.g. `prebuilds/pipeline/pipeline_bg.wasm`.
function packedFor (files, crate) {
  return files.filter(f => f.startsWith(`prebuilds/${crate}/`))
}

function wasmFor (files, crate) {
  return packedFor(files, crate).filter(f => f.endsWith('.wasm'))
}

for (const [dir, crates] of owned) {
  const isNative = dir === NATIVE_PACKAGE
  const name = require(path.join('..', dir, 'package.json')).name
  const files = packedFiles(dir)

  for (const crate of crates) {
    if (wasmFor(files, crate).length === 0) fail(`${name} is missing the ${crate} wasm module`)
  }

  for (const crate of WASM_CRATES.filter(c => !crates.includes(c))) {
    const leaked = packedFor(files, crate)
    if (leaked.length > 0) fail(`${name} must not contain the ${crate} crate:`, leaked)
  }

  const native = files.filter(f => f.endsWith('.node'))

  if (isNative && native.length === 0) {
    fail(`${name} contains no native .node binaries`)
  } else if (!isNative && native.length > 0) {
    fail(`${name} must not contain native binaries:`, native)
  }

  console.log(`  ${name}: ${files.length} packed files, ${native.length} native, `
    + `wasm crates [${crates.filter(c => wasmFor(files, c).length > 0).join(', ')}]`)
}

if (failed) {
  process.exitCode = 1
} else {
  console.log('✔ package boundaries hold')
}
