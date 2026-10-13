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
  ['package', {
    asset: path.join(packageRoot, 'wasm', 'dist', 'libdatadog_wasm_bg.wasm.br'),
    entry: path.join(packageRoot, 'index.js'),
  }],
  ['WASM', {
    asset: path.join(packageRoot, 'wasm', 'dist', 'libdatadog_wasm_bg.wasm.br'),
    entry: path.join(packageRoot, 'wasm.js'),
  }],
  ['remote config', {
    asset: path.join(packageRoot, 'wasm', 'dist', 'remote-config', 'remote_config_bg.wasm.br'),
    entry: path.join(packageRoot, 'remote-config.js'),
  }],
])

for (const [name, { asset, entry }] of entries) {
  test(`esbuild bundles the ${name} entry point with its compressed WASM asset`, async () => {
    await assertBundle(entry, asset, bundleWithEsbuild, name !== 'remote config')
  })

  test(`webpack bundles the ${name} entry point with its compressed WASM asset`, async () => {
    await assertBundle(entry, asset, bundleWithWebpack, true)
  })
}

/**
 * @param {string} entry
 * @param {string} asset
 * @param {(entry: string, output: string) => Promise<void>} bundle
 * @param {boolean} loadBundle
 */
async function assertBundle (entry, asset, bundle, loadBundle) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'libdatadog-bundle-'))
  const output = path.join(directory, 'bundle.cjs')
  const copiedAsset = path.join(directory, path.basename(asset))

  try {
    await bundle(entry, output)
    fs.copyFileSync(asset, copiedAsset)
    const files = fs.readdirSync(directory)
    const contents = fs.readFileSync(output, 'utf8')

    assert.equal(files.length, 2)
    assert(files.includes('bundle.cjs'))
    assert(files.includes(path.basename(asset)))
    assert.match(contents, /\.wasm\.br/)
    if (loadBundle) require(output)
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
