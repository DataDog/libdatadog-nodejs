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
const {
  createReport: createNapiReport,
  parseDarwinSections,
  parseElfSections,
} = require('../scripts/report-napi-size')

test('reports inline packaging and WASM section sizes', () => {
  const gluePath = path.join(__dirname, '..', 'dist', 'wasm', 'libdatadog_wasm.js')
  const report = createWasmReport(gluePath)

  assert.match(report, /Raw WASM \(before Brotli\)/)
  assert.match(report, /Base64 encoding overhead/)
  assert.match(report, /Raw WebAssembly sections/)
  assert.match(report, /\| code \|/)
  assert.match(report, /\| data \|/)
})

test('reports N-API artifact, section, and crate sizes', () => {
  const nativeDirectory = path.join(__dirname, '..', 'dist', 'native')
  const artifact = require('node:fs').readdirSync(nativeDirectory)
    .find(file => /^libdatadog\..+\.node$/.test(file))
  const report = createNapiReport(path.join(nativeDirectory, artifact), {
    'text-section-size': 7000,
    'crates': [
      { name: 'libdatadog', size: 2500 },
      { name: 'small_crate', size: 500 },
    ],
  })

  assert.match(report, /Shipped \.node file/)
  assert.match(report, /Native binary sections/)
  assert.match(report, /Code by Rust crate/)
  assert.match(report, /libdatadog/)
  assert.match(report, /unattributed \.text overhead/)
  assert.match(report, /other crates \(<2 KiB each\)/)
})

test('parses Darwin and ELF section reports', () => {
  assert.deepEqual(parseDarwinSections('Segment __TEXT: 123\nSegment __DATA: 45\n'), [
    { name: '__TEXT', bytes: 123 },
    { name: '__DATA', bytes: 45 },
  ])
  assert.deepEqual(parseElfSections('.text 123 0x10\n.data 45 0x20\nTotal 168\n'), [
    { name: '.text', bytes: 123 },
    { name: '.data', bytes: 45 },
  ])
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
