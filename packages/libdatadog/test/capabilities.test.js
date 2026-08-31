'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')

const backends = [
  ['default', require('..')],
  ['WASM', require('../wasm')],
]

test('package entry points exclude optional extras', () => {
  for (const [, backend] of backends) {
    assert.strictEqual(backend.JsConfigurator, undefined)
    assert.strictEqual(backend.ConfigEntry, undefined)
  }
})

for (const [name, backend] of backends) {
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
