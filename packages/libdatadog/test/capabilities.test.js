'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const packageRoot = path.join(__dirname, '..')
const nativeDirectory = path.join(packageRoot, 'dist', 'native')
const nativeArtifact = fs.existsSync(nativeDirectory)
  ? fs.readdirSync(nativeDirectory).find(file => file.startsWith('libdatadog.') && file.endsWith('.node'))
  : undefined
const wasm = require('../wasm')
const native = nativeArtifact ? loadNative() : undefined

test('universal backends provide the agentless exporter', () => {
  for (const [, backend] of backends()) {
    assert.strictEqual(typeof backend.createAgentlessExporter, 'function')
  }
})

test('universal backends exclude optional extras', () => {
  for (const [, backend] of backends()) {
    assert.strictEqual(backend.JsConfigurator, undefined)
    assert.strictEqual(backend.ConfigEntry, undefined)
  }
})

for (const [name, backend] of backends()) {
  test(`${name} backend compresses a Uint8Array with Zstandard`, () => {
    const input = new Uint8Array(4096).fill(42)
    const compressed = backend.zstd_compress(input, 3)

    assert(compressed instanceof Uint8Array)
    assert.deepStrictEqual([...compressed.subarray(0, 4)], [0x28, 0xB5, 0x2F, 0xFD])
  })

  test(`${name} backend provides DDSketch`, () => {
    const sketch = new backend.DDSketch()

    sketch.add(1)
    sketch.addWithCount(2, 3)
    assert.strictEqual(sketch.count(), 4)
    assert(sketch.encode() instanceof Uint8Array)
    assert.throws(() => sketch.add(-1), /point is invalid/)
  })
}

function backends () {
  return [
    ['WASM', wasm],
    ...(native ? [['native', native]] : []),
  ]
}

function loadNative () {
  process.env.DD_LIBDATADOG_NATIVE_PATH = path.join(nativeDirectory, nativeArtifact)
  try {
    return require('../lib/native')
  } finally {
    delete process.env.DD_LIBDATADOG_NATIVE_PATH
  }
}
