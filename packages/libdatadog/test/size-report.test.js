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
  readCrateSizes,
  readSections,
} = require('../scripts/report-wasm-size')
const reportScript = path.join(__dirname, '..', 'scripts', 'report-wasm-size.js')

test('reports compressed packaging and WASM section sizes', () => {
  const gluePath = path.join(__dirname, '..', 'wasm', 'dist', 'libdatadog_wasm.js')
  const report = createWasmReport(gluePath)

  assert.match(report, /Raw WASM \(before Brotli\)/)
  assert.match(report, /Final packaged artifacts/)
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
  assert.equal(inferCrate('serde_yaml[0123abcd]::Value::serialize'), 'serde-yaml')
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

test('rejects symbolized WASM without attributable Rust crate names', () => {
  // The fixture defines one empty `core::noop` function and its function-name custom section.
  const wasm = Buffer.from(
    '0061736d01000000'
    + '010401600000'
    + '03020100'
    + '0014046e616d65010d01000a636f72653a3a6e6f6f70'
    + '0a040102000b',
    'hex',
  )

  assert.throws(
    () => readCrateSizes(wasm),
    /symbolized WASM does not contain attributable Rust crate names/,
  )
})

test('enforces each packaged artifact size budget through the CLI', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-size-report-'))
  const fixtureScript = path.join(fixtureRoot, 'scripts', 'report-wasm-size.js')
  const mainGlue = path.join(fixtureRoot, 'wasm', 'dist', 'libdatadog_wasm.js')
  const reportPath = path.join(fixtureRoot, 'wasm-size-report.md')
  const remoteGlue = path.join(fixtureRoot, 'wasm', 'dist', 'remote-config', 'remote_config.js')

  t.after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }))
  fs.mkdirSync(path.dirname(fixtureScript), { recursive: true })
  fs.mkdirSync(path.dirname(mainGlue), { recursive: true })
  fs.mkdirSync(path.dirname(remoteGlue), { recursive: true })
  fs.copyFileSync(reportScript, fixtureScript)
  writePackagedWasm(mainGlue, 240 * 1024)
  writePackagedWasm(remoteGlue, 330 * 1024)

  const accepted = spawnSync(process.execPath, [fixtureScript], {
    encoding: 'utf8',
    env: { ...process.env, WASM_SIZE_REPORT: reportPath },
  })
  assert.equal(accepted.status, 0, accepted.stderr)
  const report = fs.readFileSync(reportPath, 'utf8')
  assert.match(report, /## libdatadog WASM size/)
  assert.match(report, /## remote config WASM size/)

  writePackagedWasm(mainGlue, 240 * 1024 + 1)
  const mainRejected = spawnSync(process.execPath, [fixtureScript], { encoding: 'utf8' })
  assert.equal(mainRejected.status, 1)
  assert.match(mainRejected.stderr, /libdatadog: 245,761 bytes exceeds 245,760 bytes/)

  writePackagedWasm(mainGlue, 240 * 1024)
  writePackagedWasm(remoteGlue, 330 * 1024 + 1)
  const remoteRejected = spawnSync(process.execPath, [fixtureScript], { encoding: 'utf8' })
  assert.equal(remoteRejected.status, 1)
  assert.match(remoteRejected.stderr, /remote config: 337,921 bytes exceeds 337,920 bytes/)
})

test('compares before and after artifact sizes through the CLI', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-size-comparison-'))
  const fixtureScript = path.join(fixtureRoot, 'packages', 'libdatadog', 'scripts', 'report-wasm-size.js')
  const beforeRoot = path.join(fixtureRoot, 'before')
  const afterRoot = path.join(fixtureRoot, 'after')
  const reportPath = path.join(fixtureRoot, 'wasm-size-report.md')

  t.after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }))
  fs.mkdirSync(path.dirname(fixtureScript), { recursive: true })
  fs.copyFileSync(reportScript, fixtureScript)
  writeComparisonBuild(beforeRoot, [200, 240], [
    { bytes: 2500, name: 'shared_crate::run' },
    { bytes: 2200, name: 'old_crate::run' },
    { bytes: 100, name: 'tiny_crate::run' },
  ], writeInlineWasm)
  writeComparisonBuild(afterRoot, [220, 220], [
    { bytes: 2600, name: 'shared_crate::run' },
    { bytes: 2300, name: 'new_crate::run' },
    { bytes: 150, name: 'tiny_crate::run' },
  ], writePackagedWasm)

  const result = spawnSync(process.execPath, [fixtureScript, '--compare', beforeRoot, afterRoot], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WASM_SIZE_AFTER_REF: '2222222222222222222222222222222222222222',
      WASM_SIZE_BEFORE_REF: '1111111111111111111111111111111111111111',
      WASM_SIZE_REPORT: reportPath,
    },
  })

  assert.equal(result.status, 0, result.stderr)
  const report = fs.readFileSync(reportPath, 'utf8')
  assert.equal(report.match(/^## WASM size comparison$/gm)?.length, 1)
  assert.match(report, /Compared `1111111` \(base\) with `2222222` \(PR merge\)\./)
  assert.match(report, /\| libdatadog \| 200 \(0\.2 KiB\) \| 220 \(0\.2 KiB\) \| \+20 \(\+10\.00%\) \|/)
  assert.match(report, /\| remote config \| 240 \(0\.2 KiB\) \| 220 \(0\.2 KiB\) \| -20 \(-8\.33%\) \|/)
  assert.equal(report.match(/<details>/g)?.length, 2)
  assert.match(report, /<summary>libdatadog: \d+ changed, \d+ unchanged<\/summary>/)
  assert.match(report, /<summary>remote config: \d+ changed, \d+ unchanged<\/summary>/)
  assert.match(report, /\| \*\*Final packaged artifacts\*\* .* \*\*\+20 \(\+10\.00%\)\*\* \|/)
  assert.match(report, /\| \*\*Final packaged artifacts\*\* .* \*\*-20 \(-8\.33%\)\*\* \|/)
  assert.match(report, /\| Base64 encoding overhead .* \(removed\) \|/)
  assert.match(report, /\| new-crate .* \+2,302 \(new\) \|/)
  assert.match(report, /\| old-crate .* -2,202 \(removed\) \|/)
  assert.match(report, /\| other crates \(<2 KiB in both builds\) /)
  assert.doesNotMatch(report, /tiny-crate/)
  assert.doesNotMatch(report, /\| Result \|/)

  const libdatadogBreakdown = report.slice(
    report.indexOf('<summary>libdatadog:'),
    report.indexOf('<summary>remote config:'),
  )
  assert(libdatadogBreakdown.indexOf('Final packaged artifacts') < libdatadogBreakdown.indexOf('Raw WASM'))
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

/**
 * @param {string} gluePath
 * @param {number} size
 * @param {Buffer} [wasm]
 */
function writePackagedWasm (gluePath, size, wasm = Buffer.from([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00])) {
  const compressed = brotliCompressSync(wasm)
  const loader = 'const wasmBytes = require(\'node:zlib\').brotliDecompressSync(compressedWasm)'

  assert(loader.length + compressed.length <= size)
  fs.writeFileSync(gluePath, loader.padEnd(size - compressed.length))
  fs.writeFileSync(gluePath.replace(/\.js$/, '_bg.wasm.br'), compressed)
}

/**
 * @param {string} gluePath
 * @param {number} size
 * @param {Buffer} [wasm]
 */
function writeInlineWasm (gluePath, size, wasm = Buffer.from([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00])) {
  const encodedWasm = brotliCompressSync(wasm).toString('base64')
  const loader = `const wasmBytes = Buffer.from('${encodedWasm}', 'base64')`

  assert(loader.length <= size)
  fs.writeFileSync(gluePath, loader.padEnd(size))
}

/**
 * @param {string} root
 * @param {[number, number]} artifactSizes
 * @param {Array<{ bytes: number, name: string }>} functions
 * @param {(gluePath: string, size: number) => void} writeWasm
 */
function writeComparisonBuild (root, artifactSizes, functions, writeWasm) {
  const files = [
    {
      gluePath: 'packages/libdatadog/wasm/dist/libdatadog_wasm.js',
      profilePath: 'target/size/libdatadog-wasm/libdatadog_wasm_bg.wasm',
    },
    {
      gluePath: 'packages/libdatadog/wasm/dist/remote-config/remote_config.js',
      profilePath: 'target/size/remote-config/remote_config_bg.wasm',
    },
  ]

  for (const [index, file] of files.entries()) {
    const gluePath = path.join(root, file.gluePath)
    const profilePath = path.join(root, file.profilePath)
    fs.mkdirSync(path.dirname(gluePath), { recursive: true })
    fs.mkdirSync(path.dirname(profilePath), { recursive: true })
    writeWasm(gluePath, artifactSizes[index])
    writeProfileWasm(profilePath, functions)
  }
}

/**
 * @param {number} value
 * @returns {Buffer}
 */
function encodeUnsignedLeb128 (value) {
  const bytes = []

  do {
    const remaining = Math.floor(value / 128)
    bytes.push((value % 128) | (remaining > 0 ? 0x80 : 0))
    value = remaining
  } while (value > 0)

  return Buffer.from(bytes)
}

/**
 * @param {string} value
 * @returns {Buffer}
 */
function encodeWasmString (value) {
  const bytes = Buffer.from(value)
  return Buffer.concat([encodeUnsignedLeb128(bytes.length), bytes])
}

/**
 * @param {number} id
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function createWasmSection (id, payload) {
  return Buffer.concat([Buffer.from([id]), encodeUnsignedLeb128(payload.length), payload])
}

/**
 * @param {string} profilePath
 * @param {Array<{ bytes: number, name: string }>} functions
 */
function writeProfileWasm (profilePath, functions) {
  const functionNames = []
  const functionBodies = []

  for (const [index, entry] of functions.entries()) {
    functionNames.push(encodeUnsignedLeb128(index), encodeWasmString(entry.name))
    const body = Buffer.alloc(entry.bytes, 0x01)
    body[0] = 0
    body[body.length - 1] = 0x0B
    functionBodies.push(encodeUnsignedLeb128(body.length), body)
  }

  const nameMap = Buffer.concat([encodeUnsignedLeb128(functions.length), ...functionNames])
  const nameSection = Buffer.concat([
    encodeWasmString('name'),
    Buffer.from([1]),
    encodeUnsignedLeb128(nameMap.length),
    nameMap,
  ])
  const types = Buffer.from([1, 0x60, 0, 0])
  const typeIndexes = Buffer.concat([
    encodeUnsignedLeb128(functions.length),
    Buffer.alloc(functions.length),
  ])
  const code = Buffer.concat([encodeUnsignedLeb128(functions.length), ...functionBodies])
  const wasm = Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00]),
    createWasmSection(1, types),
    createWasmSection(3, typeIndexes),
    createWasmSection(0, nameSection),
    createWasmSection(10, code),
  ])

  fs.writeFileSync(profilePath, wasm)
}
