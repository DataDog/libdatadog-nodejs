'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const {
  findDuplicateVersions,
  findForbiddenDependencies,
  parseCargoTree,
} = require('../scripts/check-dependencies')

test('dependency validation rejects all Tokio packages in WASM', () => {
  const dependencies = parseCargoTree([
    '0libdatadog-wasm v0.1.0',
    '1tokio v1.52.1',
    '1tokio-util v0.7.18',
  ].join('\n'))
  const failures = findForbiddenDependencies(dependencies)

  assert.deepStrictEqual(failures.map(({ name }) => name), ['tokio', 'tokio-util'])
})

test('dependency validation reports forbidden packages from Cargo', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'libdatadog-cargo-tree-'))
  const preload = path.join(directory, 'cargo-tree.cjs')
  const output = [
    '0libdatadog-wasm v0.1.0',
    '1tokio v1.52.1',
  ].join('\n')
  const source = [
    '\'use strict\'',
    '',
    'const childProcess = require(\'node:child_process\')',
    '',
    'childProcess.execFileSync = function execFileSync () {',
    `  return ${JSON.stringify(output)}`,
    '}',
    '',
  ].join('\n')

  fs.writeFileSync(preload, source)
  try {
    const nodeOptions = [
      process.env.NODE_OPTIONS,
      `--require=${preload}`,
    ].filter(Boolean).join(' ')
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'check-dependencies.js'),
    ], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /tokio through libdatadog-wasm -> tokio/)
  } finally {
    fs.rmSync(directory, { force: true, recursive: true })
  }
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
