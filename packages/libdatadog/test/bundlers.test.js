'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { promisify } = require('node:util')

const esbuild = require('esbuild')
const webpack = require('webpack')

const packageRoot = path.join(__dirname, '..')
const webpackAsync = promisify(webpack)
const entries = new Map([
  ['package', path.join(packageRoot, 'index.js')],
  ['WASM', path.join(packageRoot, 'wasm.js')],
  ['remote config', path.join(packageRoot, 'remote-config.js')],
])

for (const [name, entry] of entries) {
  test(`esbuild bundles the ${name} entry point without emitting an asset`, async () => {
    await assertBundle(entry, bundleWithEsbuild)
  })

  test(`webpack bundles the ${name} entry point without emitting an asset`, async () => {
    await assertBundle(entry, bundleWithWebpack)
  })
}

/**
 * @param {string} entry
 * @param {(entry: string, output: string) => Promise<void>} bundle
 */
async function assertBundle (entry, bundle) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'libdatadog-bundle-'))
  const output = path.join(directory, 'bundle.cjs')

  try {
    await bundle(entry, output)
    const files = fs.readdirSync(directory)
    const contents = fs.readFileSync(output, 'utf8')

    assert.deepStrictEqual(files, ['bundle.cjs'])
    assert.doesNotMatch(contents, /\.wasm(?:['"`)]|$)/m)
  } finally {
    fs.rmSync(directory, { force: true, recursive: true })
  }
}

/**
 * @param {string} entry
 * @param {string} output
 */
async function bundleWithEsbuild (entry, output) {
  await esbuild.build({
    bundle: true,
    entryPoints: [entry],
    outfile: output,
    platform: 'node',
  })
}

/**
 * @param {string} entry
 * @param {string} output
 */
async function bundleWithWebpack (entry, output) {
  const stats = await webpackAsync({
    entry,
    mode: 'production',
    output: {
      filename: path.basename(output),
      path: path.dirname(output),
    },
    target: 'node',
  })

  if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }))
}
