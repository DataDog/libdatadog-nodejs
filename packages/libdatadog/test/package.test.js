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

test('uses napi-rs platform package names', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json')))
  const targets = [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64-gnu',
    'linux-arm64-musl',
    'linux-x64-gnu',
    'linux-x64-musl',
  ]

  assert.deepStrictEqual(
    Object.keys(packageJson.optionalDependencies),
    targets.map(target => `${packageJson.name}-${target}`),
  )
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
  for (const version of Object.values(packageJson.optionalDependencies)) {
    assert.strictEqual(version, repositoryPackageJson.version)
  }
})

test('root entry point uses the expected backend', () => {
  const libdatadog = require('..')
  const nativeArtifact = getNativeArtifact()
  const expected = process.env.DD_LIBDATADOG_EXPECTED_BACKEND
    ?? (nativeArtifact ? 'native' : 'wasm')

  assert.strictEqual(libdatadog.backend(), expected)
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
  assert.ok(compressedWasm.length < 400 * 1024)
  assert.ok(brotliDecompressSync(compressedWasm).length < 1024 * 1024)
})

function getNativeArtifact () {
  const nativeDirectory = path.join(packageRoot, 'dist', 'native')

  if (!fs.existsSync(nativeDirectory)) return

  return fs.readdirSync(nativeDirectory)
    .find(file => /^libdatadog\..+\.node$/.test(file))
}
