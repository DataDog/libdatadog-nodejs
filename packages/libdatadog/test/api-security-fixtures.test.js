'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')

const fixtures = require('./fixtures/api-security.json')
const { canonicalSchema } = require('./helpers/schema')

const { extractSchemaJson } = require('@datadog/libdatadog/api-security')

for (const fixture of fixtures) {
  test(`shared schema fixture: ${fixture.name}`, () => {
    const actual = JSON.parse(extractSchemaJson(fixture.input))
    assert.deepStrictEqual(canonicalSchema(actual), canonicalSchema(fixture.schema))
  })
}

test('keeps extraction usable across repeated success and error calls', () => {
  for (let index = 0; index < 1000; index++) {
    assert.strictEqual(extractSchemaJson('{"id":42}'), '[{"id":[4]}]')
    assert.throws(() => extractSchemaJson('{"id":'), /^Error: invalid JSON input:/)
  }
})

test('preserves source order at the 255-field selection boundary', () => {
  const fields = Array.from({ length: 256 }, (_, index) => `"field-${255 - index}":true`)
  const [schema, metadata] = JSON.parse(extractSchemaJson(`{${fields.join(',')}}`))
  assert.strictEqual(Object.keys(schema).length, 255)
  assert.strictEqual(Object.hasOwn(schema, 'field-0'), false)
  assert.deepStrictEqual(metadata, { truncated: true })
})

test('handles deep JSON without requiring a recursive JavaScript input walker', () => {
  const input = '['.repeat(256) + 'null' + ']'.repeat(256)
  let schema = JSON.parse(extractSchemaJson(input))
  for (let depth = 1; depth < 18; depth++) {
    assert.deepStrictEqual(schema[1], { len: 1 })
    assert.strictEqual(schema[0].length, 1)
    schema = schema[0][0]
  }
  assert.deepStrictEqual(schema, [[], { len: 1 }])
})
