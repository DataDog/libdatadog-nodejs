'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createRequire } = require('node:module')
const { test } = require('node:test')

const packageRoot = path.join(__dirname, '..')
const wasmPackageRoot = path.join(packageRoot, 'wasm')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmCache = path.join(os.tmpdir(), 'libdatadog-npm-cache')
const npmOptions = process.platform === 'win32' ? { shell: true } : {}

function pack (directory) {
  const output = execFileSync(npm, ['pack', '--json', '--dry-run'], {
    ...npmOptions,
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: npmCache },
  })
  return JSON.parse(output)[0]
}

test('published packages contain only the intended artifacts', () => {
  const libdatadog = pack(packageRoot)
  const libdatadogWasm = pack(wasmPackageRoot)
  const metapackageJson = JSON.parse(fs.readFileSync(
    path.join(packageRoot, 'package.json'),
    'utf8',
  ))
  const names = libdatadog.files.map(file => file.path)
  const wasmNames = libdatadogWasm.files.map(file => file.path)
  const standaloneWasm = [...names, ...wasmNames]
    .filter(file => file.endsWith('.wasm'))

  assert.deepStrictEqual(standaloneWasm, [],
    `packages must not contain standalone WASM files: ${standaloneWasm.join(', ')}`)
  assert(wasmNames.includes('dist/libdatadog_wasm.js'),
    'WASM package must contain the inline-WASM JavaScript fallback')
  assert.strictEqual(libdatadogWasm.name, '@datadog/libdatadog-wasm')
  assert.strictEqual(
    metapackageJson.dependencies['@datadog/libdatadog-wasm'],
    libdatadog.version,
  )
  assert(!names.some(file => file.includes('.node')),
    'package must not contain native artifacts')
  assert(!names.some(file => file.startsWith('dist/')),
    'package must not contain generated backend artifacts')
})

test('installed package uses its WASM dependency', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libdatadog-install-'))
  const installRoot = path.join(temporaryRoot, 'consumer')
  const tarballRoot = path.join(temporaryRoot, 'tarballs')
  const environment = {
    ...process.env,
    npm_config_cache: path.join(temporaryRoot, 'npm-cache'),
  }

  fs.mkdirSync(installRoot)
  fs.mkdirSync(tarballRoot)
  fs.writeFileSync(
    path.join(installRoot, 'package.json'),
    JSON.stringify({ name: 'libdatadog-test-consumer', private: true }),
  )

  try {
    const wasmTarball = createTarball(wasmPackageRoot, tarballRoot, environment)
    const metapackageTarball = createTarball(
      packageRoot,
      tarballRoot,
      environment,
    )

    execFileSync(npm, [
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      '--offline',
      wasmTarball,
      metapackageTarball,
    ], {
      ...npmOptions,
      cwd: installRoot,
      env: environment,
      stdio: 'pipe',
    })

    const requireInstalled = createRequire(path.join(installRoot, 'package.json'))
    const libdatadog = requireInstalled('@datadog/libdatadog')
    const explicitWasm = requireInstalled('@datadog/libdatadog/wasm')

    assert.strictEqual(libdatadog.backend(), 'wasm')
    assert.strictEqual(explicitWasm.backend(), 'wasm')
    assert(libdatadog.zstd_compress(Buffer.alloc(16), 3) instanceof Uint8Array)
    assert.strictEqual(new libdatadog.DDSketch().count(), 0)
    assertEsmImports(installRoot, environment)
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true })
  }
})

/**
 * @param {string} installRoot
 * @param {NodeJS.ProcessEnv} environment
 */
function assertEsmImports (installRoot, environment) {
  const script = `
    import assert from 'node:assert/strict'
    import libdatadog, {
      backend,
      createAgentlessExporter,
      DDSketch,
      zstd_compress,
    } from '@datadog/libdatadog'
    import wasm, {
      backend as wasmBackend,
      createAgentlessExporter as createWasmAgentlessExporter,
      DDSketch as WasmDDSketch,
      zstd_compress as wasmCompress,
    } from '@datadog/libdatadog/wasm'

    assert.strictEqual(backend(), 'wasm')
    assert.strictEqual(libdatadog.backend, backend)
    assert.strictEqual(libdatadog.createAgentlessExporter, createAgentlessExporter)
    assert(zstd_compress(new Uint8Array(16), 3) instanceof Uint8Array)
    assert.strictEqual(new DDSketch().count(), 0)

    assert.strictEqual(wasmBackend(), 'wasm')
    assert.strictEqual(wasm.backend, wasmBackend)
    assert.strictEqual(wasm.createAgentlessExporter, createWasmAgentlessExporter)
    assert(wasmCompress(new Uint8Array(16), 3) instanceof Uint8Array)
    assert.strictEqual(new WasmDDSketch().count(), 0)
  `

  execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: installRoot,
    env: environment,
    stdio: 'pipe',
  })
}

function createTarball (directory, destination, environment) {
  const output = execFileSync(npm, [
    'pack',
    '--json',
    '--pack-destination',
    destination,
  ], {
    ...npmOptions,
    cwd: directory,
    encoding: 'utf8',
    env: environment,
  })
  const [{ filename }] = JSON.parse(output)

  return path.join(destination, filename)
}
