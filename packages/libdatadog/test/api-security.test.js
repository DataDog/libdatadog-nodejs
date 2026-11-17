'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { test } = require('node:test')

const { extractSchemaJson, extractSchema } = require('@datadog/libdatadog/api-security')

test('extracts a structural schema through the public CommonJS entry point', () => {
  const input = '{"names":["Alice","Bob"],"active":true,"id":42,"optional":null}'
  assert.strictEqual(
    extractSchemaJson(input),
    '[{"active":[2],"id":[4],"names":[[[8]],{"len":2}],"optional":[1]}]',
  )
})

test('preserves Unicode property names without retaining scalar values', () => {
  const input = String.raw`{"é漢字😀":"private-value","escaped\nkey":1.5}`
  assert.deepStrictEqual(JSON.parse(extractSchemaJson(input)), [{
    'é漢字😀': [8],
    'escaped\nkey': [16],
  }])
})

test('keeps the first duplicate JSON key', () => {
  assert.strictEqual(extractSchemaJson('{"id":42,"id":"later"}'), '[{"id":[4]}]')
})

test('throws a JavaScript Error for invalid JSON and remains usable', () => {
  for (const input of ['', '{', '[1,]', '{}{}', '1e400']) {
    assert.throws(() => extractSchemaJson(input), {
      name: 'Error',
      message: /^invalid JSON input:/,
    })
    assert.strictEqual(extractSchemaJson('null'), '[1]')
  }
})

test('rejects non-string input without coercing application objects', () => {
  const object = {
    toString () {
      throw new Error('must not coerce')
    },
    toJSON () {
      throw new Error('must not serialize')
    },
  }
  for (const input of [undefined, null, 42, true, 1n, [], object, Buffer.from('null')]) {
    assert.throws(() => extractSchemaJson(input), {
      name: 'TypeError',
      message: 'API Security input must be a JSON string',
    })
  }
})

test('exports the same synchronous function for ESM consumers', async () => {
  const imported = await import('@datadog/libdatadog/api-security')
  assert.strictEqual(imported.extractSchemaJson, extractSchemaJson)
  assert.strictEqual(imported.default.extractSchemaJson, extractSchemaJson)
  assert.strictEqual(imported.extractSchemaJson('true'), '[2]')
})

test('loads the API Security artifact independently of other WASM modules', () => {
  const script = [
    'const assert = require(\'node:assert/strict\')',
    'const { extractSchemaJson, extractSchema } = require(\'@datadog/libdatadog/api-security\')',
    'assert.strictEqual(extractSchemaJson(\'null\'), \'[1]\')',
    'const path = require(\'node:path\')',
    'const loaded = Object.keys(require.cache).map(file => path.basename(file))',
    'assert(loaded.includes(\'api_security.js\'))',
    'assert(!loaded.includes(\'libdatadog_wasm.js\'))',
    'assert(!loaded.includes(\'remote_config.js\'))',
  ].join('\n')
  execFileSync(process.execPath, ['--eval', script], {
    cwd: path.join(__dirname, '..'),
    stdio: 'pipe',
  })
})

test('preserves JavaScript number types and deduplicates normalized variants', () => {
  for (const value of [0, -0, 1, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.deepStrictEqual(extractSchema(value), [16])
  }
  assert.deepStrictEqual(extractSchema([1, 1.5]), [[[16]], { len: 2 }])
  assert.deepStrictEqual(extractSchema([{ id: 1 }, { id: 1.5 }]), [[[{
    id: [16],
  }]], { len: 2 }])
  assert.deepStrictEqual(extractSchema([[1], [1.5]]), [[[[[16]], { len: 1 }]], { len: 2 }])
  assert.deepStrictEqual(extractSchema([[1, 'a'], [1.5, 'b']]), [
    [[[[16], [8]], { len: 2 }]], { len: 2 },
  ])
})

test('preserves native-appsec array length metadata at the marshalling boundary', () => {
  for (const length of [255, 256, 257, 500]) {
    assert.deepStrictEqual(extractSchema(Array.from({ length }, () => true)), [
      [[2]], { len: Math.min(length, 256), truncated: true },
    ])
  }
})

test('propagates serialization failures without breaking subsequent extraction', () => {
  const circular = {}
  circular.self = circular
  const throwing = {
    toJSON () {
      throw new Error('application serialization failure')
    },
  }
  for (const value of [circular, 1n, undefined, throwing]) {
    assert.throws(() => extractSchema(value))
    assert.deepStrictEqual(extractSchema({ ok: true }), [{ ok: [2] }])
  }
})
