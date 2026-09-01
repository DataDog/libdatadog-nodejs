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
  assert.strictEqual(packageJson.exports['./remote-config'].import, './remote-config.js')
  assert.strictEqual(packageJson.exports['./remote-config'].require, './remote-config.js')

  const wasmPackageJson = JSON.parse(fs.readFileSync(
    path.join(packageRoot, 'wasm', 'package.json'),
  ))
  assert.strictEqual(
    wasmPackageJson.exports['./remote-config'].require,
    './dist/remote-config/remote_config.js',
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

  assert.ok(Buffer.byteLength(glue) < 260 * 1024)
  assert.ok(wasm.length < 600 * 1024)
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
  const script = path.join(packageRoot, 'scripts', 'inline-wasm.js')

  for (const scriptArguments of [[], ['fixture']]) {
    const result = spawnSync(process.execPath, [script, ...scriptArguments])

    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr.toString(), /usage: node scripts\/inline-wasm\.js/)
  }
})

test('inlines a named WASM artifact into its generated module', () => {
  const outputDirectory = fs.mkdtempSync(path.join(packageRoot, '.inline-wasm-'))
  const moduleName = 'fixture'
  const wasm = Buffer.from('fixture WASM')
  const loader = [
    `const wasmPath = \`\${__dirname}/${moduleName}_bg.wasm\`;`,
    'const wasmBytes = require(\'fs\').readFileSync(wasmPath);',
  ].join('\n')

  try {
    fs.writeFileSync(path.join(outputDirectory, `${moduleName}.js`), loader)
    fs.writeFileSync(path.join(outputDirectory, `${moduleName}_bg.wasm`), wasm)
    fs.writeFileSync(path.join(outputDirectory, '.gitignore'), '')
    fs.writeFileSync(path.join(outputDirectory, 'package.json'), '{}')

    const result = spawnSync(process.execPath, [
      path.join(packageRoot, 'scripts', 'inline-wasm.js'),
      moduleName,
      path.relative(packageRoot, outputDirectory),
    ])

    assert.strictEqual(result.status, 0, result.stderr.toString())
    assert.deepStrictEqual(readInlineWasm(path.join(outputDirectory, `${moduleName}.js`)).wasm, wasm)
    assert.strictEqual(fs.existsSync(path.join(outputDirectory, `${moduleName}_bg.wasm`)), false)
    assert.strictEqual(fs.existsSync(path.join(outputDirectory, '.gitignore')), false)
    assert.strictEqual(fs.existsSync(path.join(outputDirectory, 'package.json')), false)
  } finally {
    fs.rmSync(outputDirectory, { force: true, recursive: true })
  }
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
