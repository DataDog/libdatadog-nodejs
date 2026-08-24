'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { constants, brotliCompressSync } = require('node:zlib')

const outputDirectory = path.join(__dirname, '..', 'dist', 'wasm')
const gluePath = path.join(outputDirectory, 'libdatadog_wasm.js')
const wasmPath = path.join(outputDirectory, 'libdatadog_wasm_bg.wasm')
const glue = fs.readFileSync(gluePath, 'utf8')
const wasm = fs.readFileSync(wasmPath)
const encodedWasm = brotliCompressSync(wasm, {
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
  },
}).toString('base64')
const loader = [
  'const wasmPath = `${__dirname}/libdatadog_wasm_bg.wasm`;',
  'const wasmBytes = require(\'fs\').readFileSync(wasmPath);',
].join('\n')

if (!glue.includes(loader)) {
  throw new Error('wasm-bindgen loader changed; refusing to publish an external WASM asset')
}

fs.writeFileSync(
  gluePath,
  glue.replace(
    loader,
    `const wasmBytes = require('node:zlib').brotliDecompressSync(Buffer.from('${encodedWasm}', 'base64'));`,
  ),
)
fs.rmSync(wasmPath)
fs.rmSync(path.join(outputDirectory, '.gitignore'), { force: true })

const packagePath = path.join(outputDirectory, 'package.json')
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
const libdatadogPackage = require('../package.json')
packageJson.name = '@datadog/libdatadog-wasm'
packageJson.version = libdatadogPackage.version
packageJson.description = 'WASM fallback for @datadog/libdatadog'
packageJson.license = libdatadogPackage.license
packageJson.files = [
  'libdatadog_wasm.js',
  'libdatadog_wasm.d.ts',
  'libdatadog_wasm_bg.wasm.d.ts',
]
fs.writeFileSync(packagePath, JSON.stringify(packageJson, undefined, 2) + '\n')
