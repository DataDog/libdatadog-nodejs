'use strict'

const assert = require('node:assert/strict')
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
  const gluePath = path.join(
    packageRoot,
    'wasm',
    'dist',
    'libdatadog_wasm.js',
  )
  const glue = fs.readFileSync(gluePath, 'utf8')
  const encodedWasm = glue.match(/brotliDecompressSync\(Buffer\.from\('([^']+)', 'base64'\)\)/)?.[1]

  assert.ok(encodedWasm, 'WASM must be embedded as a Brotli-compressed base64 string')
  const compressedWasm = Buffer.from(encodedWasm, 'base64')
  assert.ok(Buffer.byteLength(glue) < 200 * 1024)
  assert.ok(brotliDecompressSync(compressedWasm).length < 500 * 1024)
})
