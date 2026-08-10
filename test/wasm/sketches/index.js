'use strict'

const assert = require('node:assert')

const loader = require('../../../load')
const { DDSketch } = loader.load('sketches')

const sketch = new DDSketch()
assert.strictEqual(sketch.count(), 0)

sketch.add(1)
sketch.addWithCount(2, 3)
assert.strictEqual(sketch.count(), 4)

assert.throws(() => sketch.add(-1), /point is invalid/)
assert.throws(() => sketch.addWithCount(1, Number.NaN), /count is invalid/)

const encoded = sketch.encode()
assert(encoded instanceof Uint8Array)
assert(encoded.length > 0)
