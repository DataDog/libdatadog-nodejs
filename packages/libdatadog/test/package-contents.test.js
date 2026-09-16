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
  assert(wasmNames.includes('dist/remote-config/remote_config.js'),
    'WASM package must contain the dedicated remote config artifact')
  assert(wasmNames.includes('dist/zstd/libdatadog_wasm_zstd.js'),
    'WASM package must contain the dedicated Zstandard artifact')
  assert.strictEqual(wasmNames.includes('remote-config.js'), false)
  assert(wasmNames.includes('remote-config.d.ts'))
  assert(names.includes('remote-config.js'))
  assert.strictEqual(names.includes('remote-config.mjs'), false)
  assert(names.includes('remote-config.d.ts'))
  assert(names.includes('zstd.js'))
  assert(names.includes('zstd.mjs'))
  assert(names.includes('zstd.d.ts'))
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
    const wasmPath = requireInstalled.resolve('@datadog/libdatadog-wasm')
    const zstdWasmPath = requireInstalled.resolve('@datadog/libdatadog-wasm/zstd')
    const libdatadog = requireInstalled('@datadog/libdatadog')
    const explicitWasm = requireInstalled('@datadog/libdatadog/wasm')
    const directRemoteConfig = requireInstalled('@datadog/libdatadog-wasm/remote-config')

    assert.strictEqual(libdatadog.RemoteConfigFetcher, undefined)
    assert.strictEqual(explicitWasm.RemoteConfigFetcher, undefined)
    const remoteConfig = requireInstalled('@datadog/libdatadog/remote-config')
    assert.strictEqual(typeof remoteConfig.RemoteConfigFetcher, 'function')
    assert.strictEqual(remoteConfig.RemoteConfigFetcher, directRemoteConfig.RemoteConfigFetcher)
    assert.strictEqual(libdatadog.backend(), 'wasm')
    assert.strictEqual(explicitWasm.backend(), 'wasm')
    assert(require.cache[wasmPath])
    assert.strictEqual(require.cache[zstdWasmPath], undefined)
    assert(libdatadog.zstd_compress(Buffer.alloc(16), 3) instanceof Uint8Array)
    assert(require.cache[zstdWasmPath])

    delete require.cache[wasmPath]
    delete require.cache[zstdWasmPath]

    const directZstd = requireInstalled('@datadog/libdatadog-wasm/zstd')
    const zstd = requireInstalled('@datadog/libdatadog/zstd')

    assert(require.cache[zstdWasmPath])
    assert.strictEqual(require.cache[wasmPath], undefined)
    assert(zstd.zstd_compress(Buffer.alloc(16), 3) instanceof Uint8Array)
    assert.strictEqual(zstd.zstd_compress, directZstd.zstd_compress)
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
    import remoteConfig, {
      RemoteConfigFetcher,
      setStorage,
    } from '@datadog/libdatadog/remote-config'
    import directRemoteConfig, {
      RemoteConfigFetcher as DirectRemoteConfigFetcher,
      setStorage as setDirectStorage,
    } from '@datadog/libdatadog-wasm/remote-config'
    import zstd, { zstd_compress as zstdCompress } from '@datadog/libdatadog/zstd'
    import directZstd, { zstd_compress as directZstdCompress } from '@datadog/libdatadog-wasm/zstd'

    assert.strictEqual(libdatadog.RemoteConfigFetcher, undefined)
    assert.strictEqual(wasm.RemoteConfigFetcher, undefined)
    assert.strictEqual(remoteConfig.RemoteConfigFetcher, RemoteConfigFetcher)
    assert.strictEqual(remoteConfig.setStorage, setStorage)
    assert.strictEqual(directRemoteConfig.RemoteConfigFetcher, DirectRemoteConfigFetcher)
    assert.strictEqual(directRemoteConfig.setStorage, setDirectStorage)
    assert.strictEqual(RemoteConfigFetcher, DirectRemoteConfigFetcher)
    assert.strictEqual(zstd.zstd_compress, zstdCompress)
    assert.strictEqual(directZstd.zstd_compress, directZstdCompress)
    assert.strictEqual(zstdCompress, directZstdCompress)
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
