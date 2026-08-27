'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')

const {
  findDuplicateVersions,
  findForbiddenDependencies,
  parseCargoTree,
} = require('../scripts/check-dependencies')

test('dependency validation allows Tokio only below the NAPI async bridge', () => {
  const dependencies = parseCargoTree([
    '0libdatadog v0.1.0',
    '1napi v3.12.1',
    '2tokio v1.52.1',
  ].join('\n'))

  assert.deepStrictEqual(
    findForbiddenDependencies(dependencies, { package: 'libdatadog' }),
    [],
  )
})

test('dependency validation rejects Tokio outside the NAPI async bridge', () => {
  const dependencies = parseCargoTree([
    '0libdatadog v0.1.0',
    '1tokio v1.52.1',
    '1napi v3.12.1',
    '2tokio-util v0.7.18',
  ].join('\n'))
  const failures = findForbiddenDependencies(dependencies, { package: 'libdatadog' })

  assert.deepStrictEqual(failures.map(({ name }) => name), ['tokio', 'tokio-util'])
})

test('dependency validation rejects all Tokio packages in WASM', () => {
  const dependencies = parseCargoTree([
    '0libdatadog-wasm v0.1.0',
    '1napi v3.12.1',
    '2tokio v1.52.1',
  ].join('\n'))

  assert.strictEqual(
    findForbiddenDependencies(dependencies, { package: 'libdatadog-wasm' }).length,
    1,
  )
})

test('dependency validation still finds multiple versions in one artifact tree', () => {
  const dependencies = parseCargoTree([
    '0libdatadog v0.1.0',
    '1bytes v1.10.0',
    '1dependency v1.0.0',
    '2bytes v1.11.0',
  ].join('\n'))

  assert.deepStrictEqual(findDuplicateVersions(dependencies), [{
    name: 'bytes',
    versions: ['1.10.0', '1.11.0'],
  }])
})
