'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const esbuild = require('esbuild')
const webpack = require('webpack')

const packageRoot = path.join(__dirname, '..')
const entry = path.join(packageRoot, 'index.js')

test('esbuild bundles the package entry point without emitting an asset', async () => {
  await assertBundle(async (output) => {
    await esbuild.build({
      bundle: true,
      entryPoints: [entry],
      outfile: output,
      platform: 'node',
    })
  })
})

test('webpack bundles the package entry point without emitting an asset', async () => {
  await assertBundle(output => new Promise((resolve, reject) => {
    webpack({
      entry,
      mode: 'production',
      output: {
        filename: path.basename(output),
        path: path.dirname(output),
      },
      target: 'node',
    }, (error, stats) => {
      if (error) return reject(error)
      if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })))
      resolve()
    })
  }))
})

async function assertBundle (bundle) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'libdatadog-bundle-'))
  const output = path.join(directory, 'bundle.cjs')

  try {
    await bundle(output)
    const files = fs.readdirSync(directory)
    const contents = fs.readFileSync(output, 'utf8')

    assert.deepStrictEqual(files, ['bundle.cjs'])
    assert.doesNotMatch(contents, /\.wasm(?:['"`)]|$)/m)
  } finally {
    fs.rmSync(directory, { force: true, recursive: true })
  }
}
