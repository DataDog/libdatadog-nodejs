'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { constants, brotliCompressSync } = require('node:zlib')

/**
 * Inline one generated WASM artifact into its JavaScript loader.
 *
 * @param {string} moduleName
 * @param {string} relativeOutputDirectory
 * @returns {void}
 */
function inlineWasm (moduleName, relativeOutputDirectory) {
  const outputDirectory = path.resolve(__dirname, '..', relativeOutputDirectory)
  const gluePath = path.join(outputDirectory, `${moduleName}.js`)
  const wasmPath = path.join(outputDirectory, `${moduleName}_bg.wasm`)
  const glue = fs.readFileSync(gluePath, 'utf8')
  const wasm = fs.readFileSync(wasmPath)
  const encodedWasm = brotliCompressSync(wasm, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
    },
  }).toString('base64')
  const loader = [
    `const wasmPath = \`\${__dirname}/${moduleName}_bg.wasm\`;`,
    'const wasmBytes = require(\'fs\').readFileSync(wasmPath);',
  ].join('\n')

  if (!glue.includes(loader)) {
    throw new Error('wasm-bindgen loader changed; refusing to publish an external WASM asset')
  }

  fs.writeFileSync(
    gluePath,
    glue.replace(
      loader,
      () => `const wasmBytes = require('node:zlib').brotliDecompressSync(Buffer.from('${encodedWasm}', 'base64'));`,
    ),
  )
  fs.rmSync(wasmPath)
  fs.rmSync(path.join(outputDirectory, '.gitignore'), { force: true })
  fs.rmSync(path.join(outputDirectory, 'package.json'), { force: true })
}

module.exports = { inlineWasm }

if (require.main === module) {
  const [moduleName, relativeOutputDirectory] = process.argv.slice(2)

  if (!moduleName || !relativeOutputDirectory) {
    throw new Error('usage: node scripts/inline-wasm.js <module-name> <output-directory>')
  }

  inlineWasm(moduleName, relativeOutputDirectory)
}
