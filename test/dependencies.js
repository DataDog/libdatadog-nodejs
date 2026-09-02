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

test('dependency validation allows Tokio only through remote config', () => {
  const dependencies = parseCargoTree([
    '0remote-config v0.1.0',
    '1libdd-remote-config v3.0.0',
    '2tokio v1.53.1',
    '3tokio-macros v2.7.2',
    '2tokio-util v0.7.19',
    '1tokio v1.53.1',
  ].join('\n'))
  const tree = { package: 'remote-config' }
  const names = []

  for (const { name } of findForbiddenDependencies(dependencies, tree)) {
    names.push(name)
  }

  assert.deepStrictEqual(names, ['tokio'])
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

test('dependency validation scopes duplicate exceptions to remote config', () => {
  const dependencies = parseCargoTree([
    '0remote-config v0.1.0',
    '1syn v2.0.119',
    '1libdd-remote-config v3.0.0',
    '2syn v3.0.4',
  ].join('\n'))
  const unexpectedVersion = parseCargoTree([
    '0remote-config v0.1.0',
    '1syn v2.0.119',
    '1libdd-remote-config v3.0.0',
    '2syn v3.0.4',
    '2other-dependency v1.0.0',
    '3syn v1.0.109',
  ].join('\n'))
  const replacementVersion = parseCargoTree([
    '0remote-config v0.1.0',
    '1syn v2.0.119',
    '1libdd-remote-config v3.0.0',
    '2syn v1.0.109',
  ].join('\n'))

  assert.deepStrictEqual(
    findDuplicateVersions(dependencies, { package: 'remote-config' }),
    [],
  )
  assert.deepStrictEqual(findDuplicateVersions(dependencies), [{
    name: 'syn',
    versions: ['2.0.119', '3.0.4'],
  }])
  assert.deepStrictEqual(
    findDuplicateVersions(unexpectedVersion, { package: 'remote-config' }),
    [{
      name: 'syn',
      versions: ['2.0.119', '3.0.4', '1.0.109'],
    }],
  )
  assert.deepStrictEqual(
    findDuplicateVersions(replacementVersion, { package: 'remote-config' }),
    [{
      name: 'syn',
      versions: ['2.0.119', '1.0.109'],
    }],
  )
})

test('dependency validation reports unexpected remote config duplicate versions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'libdatadog-cargo-'))
  const cargoPath = path.join(directory, 'cargo')

  try {
    fs.writeFileSync(cargoPath, [
      '#!/usr/bin/env node',
      `const output = process.argv.includes('remote-config')`,
      String.raw`  ? '0remote-config v0.1.0\n1syn v2.0.119\n1syn v3.0.4\n1syn v1.0.109\n'`,
      String.raw`  : '0fixture v1.0.0\n'`,
      'process.stdout.write(output)',
    ].join('\n'), { mode: 0o755 })

    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'check-dependencies.js'),
    ], {
      env: {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      },
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr.toString(), /Dependencies with multiple versions found:/)
    assert.match(result.stderr.toString(), /syn 2\.0\.119, 3\.0\.4, 1\.0\.109/)
  } finally {
    fs.rmSync(directory, { force: true, recursive: true })
  }
})
