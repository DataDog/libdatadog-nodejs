'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { brotliDecompressSync } = require('node:zlib')
const { test } = require('node:test')

const packageRoot = path.join(__dirname, '..')
const repositoryRoot = path.join(packageRoot, '..', '..')

test('publishes the universal libdatadog package', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json')))

  assert.strictEqual(packageJson.name, '@datadog/libdatadog')
  assert.strictEqual(packageJson.exports['./wasm'].require, './wasm.js')
  assert.strictEqual(packageJson.exports['./remote-config'].require, './remote-config.js')
})

test('uses the libdatadog release version', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json')))
  const wasmPackageJson = JSON.parse(fs.readFileSync(
    path.join(packageRoot, 'wasm', 'package.json'),
  ))
  const repositoryPackageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json')))

  assert.strictEqual(packageJson.version, repositoryPackageJson.version)
  assert.strictEqual(wasmPackageJson.version, repositoryPackageJson.version)
  assert.strictEqual(
    packageJson.dependencies['@datadog/libdatadog-wasm'],
    repositoryPackageJson.version,
  )
})

test('root entry point uses the WASM backend', () => {
  const libdatadog = require('..')

  assert.strictEqual(libdatadog.backend(), 'wasm')
})

test('embeds a Brotli-compressed WASM fallback below the size budgets', () => {
  const { glue, wasm } = readInlineWasm(path.join(
    packageRoot,
    'wasm',
    'dist',
    'libdatadog_wasm.js',
  ))

  assert.ok(Buffer.byteLength(glue) < 200 * 1024)
  assert.ok(wasm.length < 500 * 1024)
})

test('embeds dedicated remote config WASM below the size budgets', () => {
  const { glue, wasm } = readInlineWasm(path.join(
    packageRoot,
    'wasm',
    'dist',
    'remote-config',
    'remote_config.js',
  ))

  assert.ok(Buffer.byteLength(glue) < 450 * 1024)
  assert.ok(wasm.length < 1024 * 1024)
})

test('requires an artifact name and output directory when inlining WASM', () => {
  const result = spawnSync(process.execPath, [
    path.join(packageRoot, 'scripts', 'inline-wasm.js'),
  ])

  assert.notStrictEqual(result.status, 0)
  assert.match(result.stderr.toString(), /usage: node scripts\/inline-wasm\.js/)
})

/**
 * @param {string} gluePath
 */
function readInlineWasm (gluePath) {
  const glue = fs.readFileSync(gluePath, 'utf8')
  const encodedWasm = glue.match(/brotliDecompressSync\(Buffer\.from\('([^']+)', 'base64'\)\)/)?.[1]

  assert.ok(encodedWasm, 'WASM must be embedded as a Brotli-compressed base64 string')
  return {
    glue,
    wasm: brotliDecompressSync(Buffer.from(encodedWasm, 'base64')),
  }
}
