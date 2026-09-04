'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const {
  createReport: createWasmReport,
  findForbiddenWasmCode,
  inferCrate,
  readSections,
} = require('../scripts/report-wasm-size')
test('reports inline packaging and WASM section sizes', () => {
  const gluePath = path.join(__dirname, '..', 'wasm', 'dist', 'libdatadog_wasm.js')
  const report = createWasmReport(gluePath)

  assert.match(report, /Raw WASM \(before Brotli\)/)
  assert.match(report, /Base64 encoding overhead/)
  assert.match(report, /Raw WebAssembly sections/)
  assert.match(report, /\| code \|/)
  assert.match(report, /\| data \|/)
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
  assert.equal(inferCrate('serde_yaml[0123abcd]::Value::serialize'), 'serde-yaml')
  assert.equal(inferCrate('ZSTD_compress'), 'zstd-sys (C)')
  assert.equal(inferCrate('core::slice::sort'), 'Rust standard library')
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
