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

test('dependency validation allows the NAPI Tokio bridge in WASM', () => {
  const dependencies = parseCargoTree([
    '0libdatadog v0.1.0',
    '1napi v3.12.1',
    '2tokio v1.52.1',
  ].join('\n'))

  assert.deepStrictEqual(
    findForbiddenDependencies(
      dependencies,
      { package: 'libdatadog', target: 'wasm32-unknown-unknown' },
    ),
    [],
  )
})

test('dependency validation allows the remote config Tokio runtime', () => {
  const dependencies = parseCargoTree([
    '0libdatadog v0.1.0',
    '1libdatadog-remote-config v0.1.0',
    '2libdd-remote-config v4.0.0',
    '3tokio v1.53.1',
    '4tokio-macros v2.7.2',
    '3tokio-util v0.7.19',
  ].join('\n'))

  assert.deepStrictEqual(
    findForbiddenDependencies(
      dependencies,
      { package: 'libdatadog', target: 'wasm32-unknown-unknown' },
    ),
    [],
  )
})

test('dependency validation allows the native HTTPS feature union', () => {
  const dependencies = parseCargoTree([
    '0libdatadog v0.1.0',
    '1libdd-remote-config v4.0.0',
    '1libdd-common v5.2.0',
    '2tokio-rustls v0.26.4',
  ].join('\n'))

  assert.deepStrictEqual(
    findForbiddenDependencies(dependencies, {
      package: 'libdatadog',
      target: 'x86_64-unknown-linux-gnu',
    }),
    [],
  )
  assert.strictEqual(
    findForbiddenDependencies(dependencies, {
      package: 'libdatadog',
      target: 'wasm32-unknown-unknown',
    }).length,
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

test('dependency validation allows known remote config duplicate crates', () => {
  const dependencies = parseCargoTree([
    '0libdatadog v0.1.0',
    '1syn v2.0.119',
    '1libdd-remote-config v4.0.0',
    '2syn v3.0.4',
  ].join('\n'))

  assert.deepStrictEqual(findDuplicateVersions(dependencies), [])

  dependencies.push({
    depth: 2,
    name: 'syn',
    path: ['libdatadog', 'libdd-remote-config', 'syn'],
    version: '3.0.5',
  })
  assert.deepStrictEqual(findDuplicateVersions(dependencies), [])
})
