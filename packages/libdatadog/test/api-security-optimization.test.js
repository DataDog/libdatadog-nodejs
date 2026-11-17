'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')

const fixtures = require('./fixtures/api-security.json')
const { canonicalSchema } = require('./helpers/schema')

const { extractSchema, extractSchemaJson, extractSchemaSerialized } = require('@datadog/libdatadog/api-security')

/** @param {unknown[]} schema */
function legacyNormalize (schema) {
  const value = schema[0]
  if (value === 4) schema[0] = 16
  else if (Array.isArray(value)) {
    const variants = new Map()
    for (const child of value) {
      legacyNormalize(child)
      variants.set(JSON.stringify(child), child)
    }
    // eslint-disable-next-line unicorn/no-array-sort, unicorn/prefer-iterator-to-array, unicorn/require-array-sort-compare -- Retain the former Node 18 adapter as the reference.
    schema[0] = [...variants.keys()].sort().map(key => variants.get(key))
    schema[1].len = Math.min(schema[1].len, 256)
  } else if (typeof value === 'object') {
    for (const child of Object.values(value)) legacyNormalize(child)
  }
  return schema
}

/** @param {unknown} input */
function reference (input) {
  const json = extractSchemaJson(JSON.stringify(input))
  return legacyNormalize(JSON.parse(json))
}

test('matches the former adapter on every shared JSON fixture', () => {
  for (const fixture of fixtures) {
    const value = JSON.parse(fixture.input)
    assert.deepStrictEqual(extractSchema(value), reference(value), fixture.name)
  }
})

test('preserves normalization before deduplication across capped nested lengths', () => {
  const input = [
    Array.from({ length: 256 }, () => ({ id: 1 })),
    Array.from({ length: 500 }, () => ({ id: 1.5 })),
  ]
  assert.deepStrictEqual(extractSchema(input), reference(input))
  assert.strictEqual(extractSchema(input)[0].length, 1)
})

test('does not transfer scalar string contents into WASM', () => {
  const source = fs.readFileSync(path.join(__dirname, '../api-security.js'), 'utf8')
  let transferred
  const sandbox = {
    module: { exports: {} },
    require () {
      return {
        extractSchema (json) {
          transferred = json
          return '[1]'
        },
      }
    },
  }
  vm.runInNewContext(source, sandbox)
  const input = {
    'é漢字😀': 'secret'.repeat(200_000),
    'nested': ['escaped\nvalue', { id: 42, enabled: true }],
  }
  sandbox.module.exports.extractSchema(input)
  assert.strictEqual(transferred, input)
  assert.deepStrictEqual(extractSchema(input), [{
    'é漢字😀': [8],
    'nested': [[[8], [{ enabled: [2], id: [16] }]], { len: 2 }],
  }])
})

test('preserves JSON conversions for boxed primitives, dates, holes and omitted fields', () => {
  const cases = [
    new String('value'), // eslint-disable-line unicorn/new-for-builtins -- Exercise boxed primitive inputs.
    new Number(42), // eslint-disable-line unicorn/new-for-builtins -- Exercise boxed primitive inputs.
    new Boolean(false), // eslint-disable-line unicorn/new-for-builtins -- Exercise boxed primitive inputs.
    new Date('2026-01-01T00:00:00Z'),
    // eslint-disable-next-line no-sparse-arrays -- Verify JSON's hole-to-null conversion.
    [undefined, , () => {}, Symbol('item'), NaN, Infinity, -Infinity],
    { missing: undefined, fn () {}, symbol: Symbol('item'), n: NaN, yes: true },
    Buffer.from('bytes'),
    { toJSON () {
      return { name: 'value', id: 4 }
    } },
  ]
  for (const input of cases) assert.deepStrictEqual(extractSchema(input), reference(input))
})

test('retains getter and toJSON invocation order and keys', () => {
  /** @param {string[]} calls */
  function input (calls) {
    return {
      get name () {
        calls.push('name')
        return 'a'.repeat(100_000)
      },
      rows: [{
        toJSON (key) {
          calls.push('toJSON:' + key)
          return { id: 42 }
        },
      }],
      get last () {
        calls.push('last')
        return false
      },
    }
  }
  const oldCalls = []
  const newCalls = []
  assert.deepStrictEqual(extractSchema(input(newCalls)), reference(input(oldCalls)))
  assert.deepStrictEqual(newCalls, oldCalls)
  assert.deepStrictEqual(newCalls, ['name', 'toJSON:0', 'last'])
})

test('does not observe failures beyond the schema selection limits', () => {
  const array = Array.from({ length: 10 }, () => true)
  Object.defineProperty(array, 10, { get () {
    throw new Error('tail getter')
  } })
  assert.deepStrictEqual(extractSchema(array), [[[2]], { len: 11, truncated: true }])

  const record = Object.fromEntries(Array.from({ length: 255 }, (_, index) => ['field-' + index, true]))
  Object.defineProperty(record, 'last', { enumerable: true, get () {
    throw new Error('last getter')
  } })
  const result = extractSchema(record)
  assert.strictEqual(Object.keys(result[0]).length, 255)
  assert.deepStrictEqual(result[1], { truncated: true })

  const cycle = {}
  cycle.self = cycle
  for (const ignored of [cycle, 1n]) {
    assert.deepStrictEqual(extractSchema([...Array.from({ length: 10 }, () => true), ignored]),
      [[[2]], { len: 11, truncated: true }])
  }
  assert.deepStrictEqual(extractSchema({ ok: true }), [{ ok: [2] }])
})

test('preserves heterogeneous variant ordering and integer-like property names', () => {
  const values = [null, false, 1, 1.5, 's', [], {}, { 2: 'x', 10: true }, ['s', 1]]
  assert.deepStrictEqual(extractSchema(values), reference(values))
  // eslint-disable-next-line unicorn/no-array-reverse -- Node.js 18 has no toReversed.
  const reversed = [...values].reverse()
  const actual = canonicalSchema(extractSchema([values, reversed]))
  const expected = canonicalSchema(reference([values, reversed]))
  assert.deepStrictEqual(actual, expected)
})

test('matches the original adapter on 512 deterministic generated JSON values', () => {
  let seed = 0x51_A7
  function next () {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
    return seed
  }
  /** @param {number} depth */
  function value (depth) {
    const choice = next() % (depth ? 8 : 6)
    if (choice === 0) return null
    if (choice === 1) return next() % 2 === 0
    if (choice === 2) return next() % 1000
    if (choice === 3) return (next() % 1000) + 0.25
    if (choice === 4) return 'é漢字😀'.repeat(next() % 8)
    if (choice === 5) return 'a'.repeat(next() % 100)
    if (choice === 6) return Array.from({ length: next() % 15 }, () => value(depth - 1))
    return Object.fromEntries(Array.from({ length: next() % 12 }, (_, index) => ['field-' + index, value(depth - 1)]))
  }
  for (let index = 0; index < 512; index++) {
    const input = value(4)
    assert.deepStrictEqual(extractSchema(input), reference(input))
  }
})

test('propagates visited errors, permits shared subtrees and remains reentrant', () => {
  const child = { id: 1 }
  assert.deepStrictEqual(extractSchema([child, child]), reference([child, child]))
  const failure = new Error('application getter')
  assert.throws(() => extractSchema({ get value () {
    throw failure
  } }), error => error === failure)
  assert.throws(() => extractSchema(new Proxy({}, { ownKeys () {
    throw failure
  } })), error => error === failure)
  const nested = { get value () {
    assert.deepStrictEqual(extractSchema(true), [2])
    return 'hello'
  } }
  assert.deepStrictEqual(extractSchema(nested), [{ value: [8] }])
})

test('bounds depth and counts omitted and empty fields without reading their values', () => {
  let deep = { get poison () {
    throw new Error('ignored depth')
  } }
  for (let index = 0; index < 17; index++) deep = [deep]
  assert.doesNotThrow(() => extractSchema(deep))
  const record = { get '' () {
    throw new Error('ignored empty key')
  } }
  for (let index = 0; index < 254; index++) record['key-' + index] = undefined
  Object.defineProperty(record, 'last', { enumerable: true, get () {
    throw new Error('ignored tail')
  } })
  assert.deepStrictEqual(extractSchema(record), [{}, { truncated: true }])
})

test('rejects malformed property names while accepting arbitrary scalar string contents', () => {
  assert.throws(() => extractSchema({ ['bad' + String.fromCodePoint(0xD8_00)]: true }), /Invalid Unicode/)
  assert.deepStrictEqual(extractSchema(String.fromCodePoint(0xD8_00)), [8])
  assert.deepStrictEqual(extractSchema({ 'é漢字😀': true }), [{ 'é漢字😀': [2] }])
})

test('supports boxed primitives across realms without invoking toStringTag hooks', () => {
  const boxes = vm.runInNewContext('[new String("s"), new Number(1), new Boolean(false), Object(Symbol("s"))]')
  for (const value of boxes) assert.deepStrictEqual(extractSchema(value), reference(value))
  assert.throws(() => extractSchema(vm.runInNewContext('Object(1n)')), TypeError)
  const value = { id: 1, get [Symbol.toStringTag] () {
    throw new Error('must not inspect tag')
  } }
  assert.deepStrictEqual(extractSchema(value), [{ id: [16] }])
  const callable = () => {}
  callable.toJSON = () => ({ id: 1 })
  assert.deepStrictEqual(extractSchema(callable), reference(callable))
})

test('preserves arbitrary thrown values across the managed error boundary', () => {
  const failures = [undefined, null, 42, 'failure', Symbol('failure'), { custom: true }]
  for (const failure of failures) {
    for (const input of [
      { get value () {
        throw failure
      } },
      { toJSON () {
        throw failure
      } },
      [Object.defineProperty({}, 'toJSON', { get () {
        throw failure
      } })],
    ]) {
      assert.throws(() => extractSchema(input), error => error === failure)
      assert.deepStrictEqual(extractSchema({ ok: true }), [{ ok: [2] }])
    }
  }
})

test('serialized value extraction preserves every shared fixture semantically', () => {
  for (const fixture of fixtures) {
    const input = JSON.parse(fixture.input)
    const schema = JSON.parse(extractSchemaSerialized(input))
    assert.deepStrictEqual(canonicalSchema(schema), canonicalSchema(reference(input)), fixture.name)
  }
})

test('serialized extraction keeps bounded reads and selected application errors', () => {
  const input = Array.from({ length: 10 }, () => true)
  Object.defineProperty(input, 10, { get () {
    throw new Error('ignored tail')
  } })
  assert.deepStrictEqual(JSON.parse(extractSchemaSerialized(input)), [[[2]], { len: 11, truncated: true }])
  const original = new Error('visited getter')
  const value = { get field () {
    throw original
  } }
  assert.throws(() => extractSchemaSerialized(value), error => error === original)
})

test('serialized extraction retains Unicode keys and excludes scalar contents', () => {
  const serialized = extractSchemaSerialized({ 'é漢字😀': 'private-value', 'items': [{ id: 1 }, { id: 1.5 }] })
  assert.strictEqual(serialized.includes('private-value'), false)
  assert.deepStrictEqual(canonicalSchema(JSON.parse(serialized)),
    canonicalSchema([{ 'é漢字😀': [8], 'items': [[[{ id: [16] }]], { len: 2 }] }]))
})
