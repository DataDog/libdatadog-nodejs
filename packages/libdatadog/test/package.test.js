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

test('builds native and WASM artifacts from one binding crate', () => {
  const oldBinding = path.join(repositoryRoot, 'crates', 'libdatadog-wasm')
  const scripts = ['build-native.js', 'build-wasm.js']

  assert.strictEqual(fs.existsSync(oldBinding), false)
  for (const script of scripts) {
    const source = fs.readFileSync(path.join(packageRoot, 'scripts', script), 'utf8')
    assert.match(source, /'crates', 'libdatadog'/)
  }
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

test('carries the repository metadata npm provenance verifies against', () => {
  // npm publishes these packages with provenance under OIDC trusted publishing,
  // and sigstore rejects the upload unless `repository.url` matches the source
  // repository recorded in the attestation. A package.json without the field
  // fails at publish time with `E422 ... "repository.url" is ""`, which is only
  // reachable from a real release, so assert it here instead.
  const expectedUrl = 'git+https://github.com/DataDog/libdatadog-nodejs.git'

  for (const manifestPath of [
    path.join(repositoryRoot, 'package.json'),
    path.join(packageRoot, 'package.json'),
    path.join(packageRoot, 'wasm', 'package.json'),
  ]) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath))

    assert.strictEqual(manifest.repository?.url, expectedUrl, `${manifest.name} repository.url`)
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
  const encodedWasm = glue.match(/wasmBrotliBase64:"([A-Za-z0-9+/=]+)"/)?.[1]

  assert.ok(encodedWasm, 'WASM must be embedded as a Brotli-compressed base64 string')
  const compressedWasm = Buffer.from(encodedWasm, 'base64')
  assert.ok(Buffer.byteLength(glue) < 300 * 1024)
  assert.ok(brotliDecompressSync(compressedWasm).length < 500 * 1024)
})

function getNativeArtifact () {
  const nativeDirectory = path.join(packageRoot, 'dist', 'native')

  if (!fs.existsSync(nativeDirectory)) return

  return fs.readdirSync(nativeDirectory)
    .find(file => /^libdatadog\..+\.node$/.test(file))
}
