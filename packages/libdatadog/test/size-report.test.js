'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const test = require('node:test')
const { brotliCompressSync } = require('node:zlib')

const {
  createReport: createWasmReport,
  findForbiddenWasmCode,
  inferCrate,
  readSections,
} = require('../scripts/report-wasm-size')

const reportScript = path.join(__dirname, '..', 'scripts', 'report-wasm-size.js')

test('reports inline packaging and WASM section sizes', () => {
  const gluePath = path.join(__dirname, '..', 'wasm', 'dist', 'libdatadog_wasm.js')
  const report = createWasmReport(gluePath)

  assert.match(report, /Raw WASM \(before Brotli\)/)
  assert.match(report, /Base64 encoding overhead/)
  assert.match(report, /Raw WebAssembly sections/)
  assert.match(report, /\| code \|/)
  assert.match(report, /\| data \|/)
})

test('requires symbolized input for every reported artifact', () => {
  const result = spawnSync(process.execPath, [reportScript, 'libdatadog.wasm'], { encoding: 'utf8' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /expected 2 symbolized WASM paths, received 1/)
})

test('rejects data that is not a WebAssembly binary', () => {
  assert.throws(() => readSections(Buffer.from('not wasm')), /not a WebAssembly 1 binary/)
})

test('attributes symbolized functions to their Rust crate', () => {
  assert.equal(
    inferCrate('libdd_data_pipeline::trace_exporter::send'),
    'libdd-data-pipeline',
  )
  assert.equal(inferCrate('<serde_yaml::Value as serde::Serialize>::serialize'), 'serde-yaml')
  assert.equal(inferCrate('ZSTD_compress'), 'zstd-sys (C)')
  assert.equal(inferCrate('core::slice::sort'), 'Rust standard library')
  assert.equal(
    inferCrate(String.raw`libdd_data_pipeline_core\5b8c3d06ba9ff2a61f\5d::agentless::send`),
    'libdd-data-pipeline-core',
  )
  assert.equal(
    inferCrate(String.raw`\3cserde_json\5b8c3d06ba9ff2a61f\5d::Value\20as\20serde::Serialize\3e::serialize`),
    'serde-json',
  )
})

test('enforces each inline artifact size budget through the CLI', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-size-report-'))
  const fixtureScript = path.join(fixtureRoot, 'scripts', 'report-wasm-size.js')
  const mainGlue = path.join(fixtureRoot, 'wasm', 'dist', 'libdatadog_wasm.js')
  const remoteGlue = path.join(fixtureRoot, 'wasm', 'dist', 'remote-config', 'remote_config.js')

  t.after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }))
  fs.mkdirSync(path.dirname(fixtureScript), { recursive: true })
  fs.mkdirSync(path.dirname(mainGlue), { recursive: true })
  fs.mkdirSync(path.dirname(remoteGlue), { recursive: true })
  fs.copyFileSync(reportScript, fixtureScript)
  writeInlineWasm(mainGlue, 210 * 1024)
  writeInlineWasm(remoteGlue, 330 * 1024)

  const accepted = spawnSync(process.execPath, [fixtureScript], { encoding: 'utf8' })
  assert.equal(accepted.status, 0, accepted.stderr)

  writeInlineWasm(mainGlue, 210 * 1024 + 1)
  const mainRejected = spawnSync(process.execPath, [fixtureScript], { encoding: 'utf8' })
  assert.equal(mainRejected.status, 1)
  assert.match(mainRejected.stderr, /libdatadog: 215,041 bytes exceeds 215,040 bytes/)

  writeInlineWasm(mainGlue, 210 * 1024)
  writeInlineWasm(remoteGlue, 330 * 1024 + 1)
  const remoteRejected = spawnSync(process.execPath, [fixtureScript], { encoding: 'utf8' })
  assert.equal(remoteRejected.status, 1)
  assert.match(remoteRejected.stderr, /remote config: 337,921 bytes exceeds 337,920 bytes/)
})

test('rejects forbidden code linked into WASM', () => {
  assert.deepEqual(findForbiddenWasmCode([
    { bytes: 10, name: 'regex-lite' },
    { bytes: 20, name: 'regex-automata' },
    { bytes: 30, name: 'zstd-sys (C)' },
    { bytes: 40, name: 'zrip-encode' },
  ]), [
    { bytes: 20, dependency: 'regex', name: 'regex-automata' },
    { bytes: 30, dependency: 'zstd-sys', name: 'zstd-sys (C)' },
  ])
})

function writeInlineWasm (gluePath, size) {
  const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00])
  const encodedWasm = brotliCompressSync(wasm).toString('base64')
  const loader = `const wasmBytes = Buffer.from('${encodedWasm}', 'base64')`

  assert(loader.length <= size)
  fs.writeFileSync(gluePath, loader.padEnd(size))
}
