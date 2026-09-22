'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { constants, brotliCompressSync } = require('node:zlib')

const [moduleName, relativeOutputDirectory] = process.argv.slice(2)

if (!moduleName || !relativeOutputDirectory) {
  throw new Error('usage: node scripts/compress-wasm.js <module-name> <output-directory>')
}

const outputDirectory = path.join(__dirname, '..', relativeOutputDirectory)
const gluePath = path.join(outputDirectory, `${moduleName}.js`)
const wasmPath = path.join(outputDirectory, `${moduleName}_bg.wasm`)
const compressedWasmPath = `${wasmPath}.br`
const glue = fs.readFileSync(gluePath, 'utf8')
const wasm = fs.readFileSync(wasmPath)
const compressedWasm = brotliCompressSync(wasm, {
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
  },
})
const loader = [
  `const wasmPath = \`\${__dirname}/${moduleName}_bg.wasm\`;`,
  'const wasmBytes = require(\'fs\').readFileSync(wasmPath);',
].join('\n')

if (!glue.includes(loader)) {
  throw new Error('wasm-bindgen loader changed; refusing to publish a compressed WASM asset')
}

fs.writeFileSync(
  gluePath,
  glue.replace(
    loader,
    () => [
      `const compressedWasmPath = \`\${__dirname}/${moduleName}_bg.wasm.br\`;`,
      'const compressedWasm = require(\'node:fs\').readFileSync(compressedWasmPath);',
      'const wasmBytes = require(\'node:zlib\').brotliDecompressSync(compressedWasm);',
    ].join('\n'),
  ),
)
fs.writeFileSync(compressedWasmPath, compressedWasm)
fs.rmSync(wasmPath)
fs.rmSync(path.join(outputDirectory, '.gitignore'), { force: true })
fs.rmSync(path.join(outputDirectory, 'package.json'), { force: true })
