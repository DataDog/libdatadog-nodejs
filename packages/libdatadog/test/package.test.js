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
})

test('builds native and WASM artifacts from one binding crate', () => {
  const oldBinding = path.join(repositoryRoot, 'crates', 'libdatadog-wasm')
  const scripts = ['build-native.js', 'build-wasm.js']

  assert.strictEqual(fs.existsSync(oldBinding), false)
  for (const script of scripts) {
    const source = fs.readFileSync(path.join(packageRoot, 'scripts', script), 'utf8')
    assert.match(source, /'crates', 'libdatadog'/)
    if (script === 'build-wasm.js') {
      assert.match(source, /wasm32-unknown-unknown/)
    }
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

test('root entry point uses the expected backend', () => {
  const libdatadog = require('..')
  const nativeArtifact = getNativeArtifact()
  const expected = process.env.DD_LIBDATADOG_EXPECTED_BACKEND
    ?? (nativeArtifact ? 'native' : 'wasm')

  assert.strictEqual(libdatadog.backend(), expected)
})

test('WASM loads without WASI or worker permission', {
  skip: !process.allowedNodeEnvironmentFlags.has('--permission'),
}, () => {
  const result = spawnSync(process.execPath, [
    '--permission',
    `--allow-fs-read=${packageRoot}`,
    '-e',
    `const binding = require('./wasm')
     if (binding.backend() !== 'wasm') throw new Error('WASM did not load')`,
  ], {
    cwd: packageRoot,
    encoding: 'utf8',
  })

  assert.ifError(result.error)
  assert.strictEqual(result.status, 0, result.stderr || result.stdout)
})

test('embeds a Brotli-compressed WASM fallback below the size budgets', () => {
  const gluePath = path.join(
    packageRoot,
    'wasm',
    'dist',
    'libdatadog_wasm.js',
  )
  const glue = fs.readFileSync(gluePath, 'utf8')
  const encodedRuntime = glue.match(
    /runtimeBrotliBase64:"([A-Za-z0-9+/=]+)"/,
  )?.[1]
  const encodedWasm = glue.match(/wasmBrotliBase64:"([A-Za-z0-9+/=]+)"/)?.[1]

  assert.ok(encodedRuntime, 'runtime must be embedded as a Brotli-compressed base64 string')
  assert.ok(encodedWasm, 'WASM must be embedded as a Brotli-compressed base64 string')
  const runtime = brotliDecompressSync(Buffer.from(encodedRuntime, 'base64')).toString()
  const compressedWasm = Buffer.from(encodedWasm, 'base64')
  const wasm = brotliDecompressSync(compressedWasm)
  assert.ok(Buffer.byteLength(glue) < 300 * 1024)
  assert.ok(wasm.length < 500 * 1024)
  assert.doesNotMatch(wasm.toString('latin1'), /wasi_snapshot_preview1/)
  assert.doesNotMatch(glue, /node:(?:wasi|worker_threads)/)
  assert.doesNotMatch(runtime, /node:(?:wasi|worker_threads)/)
})

function getNativeArtifact () {
  const nativeDirectory = path.join(packageRoot, 'dist', 'native')

  if (!fs.existsSync(nativeDirectory)) return

  return fs.readdirSync(nativeDirectory)
    .find(file => /^libdatadog\..+\.node$/.test(file))
}
