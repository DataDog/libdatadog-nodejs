'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { constants, brotliCompressSync } = require('node:zlib')

const esbuild = require('esbuild')

const packageRoot = path.join(__dirname, '..')
const staging = path.join(packageRoot, 'wasm', 'napi-dist')
const outputDirectory = path.join(packageRoot, 'wasm', 'dist')
const wasmPath = path.join(staging, 'libdatadog.wasm')
const wasmBindgenPath = path.join(staging, 'libdatadog.js')

const wasmBindgenSource = prepareWasmBindgen(
  fs.readFileSync(wasmBindgenPath, 'utf8'),
)
const runtimeSource = bundle(`${wasmBindgenSource}
  import createLoader from './scripts/wasm-runtime.mjs'
  export const load = createLoader({
    createImports: createWasmBindgenImports,
    setInstance: setWasmBindgenInstance,
  })
`, 'runtime-entry.mjs')
const output = createInlineModule(runtimeSource, fs.readFileSync(wasmPath))

fs.rmSync(outputDirectory, { force: true, recursive: true })
fs.mkdirSync(outputDirectory, { recursive: true })
fs.writeFileSync(path.join(outputDirectory, 'libdatadog_wasm.js'), output)
fs.copyFileSync(
  path.join(packageRoot, 'index.d.ts'),
  path.join(outputDirectory, 'libdatadog_wasm.d.ts'),
)
fs.rmSync(staging, { force: true, recursive: true })

function prepareWasmBindgen (source) {
  const initialization = source.indexOf('const wasmPath =')
  if (initialization === -1) {
    throw new Error('wasm-bindgen Node.js initialization changed')
  }
  return source
    .slice(0, initialization)
    .replaceAll(/^const import\d+ = require\("(?:env|napi)"\);\n/gm, '')
    .replaceAll(/^\s*"(?:env|napi)": import\d+,\n/gm, '') + `
      let wasm
      function createWasmBindgenImports() {
        return __wbg_get_imports()['./libdatadog_bg.js']
      }
      function setWasmBindgenInstance(instance) {
        wasm = instance.exports
      }
    `
}

function bundle (source, sourcefile) {
  const result = esbuild.buildSync({
    bundle: true,
    format: 'cjs',
    legalComments: 'none',
    mainFields: ['module', 'main'],
    minify: true,
    platform: 'node',
    stdin: {
      contents: source,
      loader: 'js',
      resolveDir: packageRoot,
      sourcefile,
    },
    target: 'node18',
    write: false,
  })
  return result.outputFiles[0].text
}

function createInlineModule (runtime, wasm) {
  const payloads = {
    runtimeBrotliBase64: compress(runtime),
    wasmBrotliBase64: compress(wasm),
  }

  return minify(`
    'use strict'
    const path = require('node:path')
    const vm = require('node:vm')
    const { Module } = require('node:module')
    const { brotliDecompressSync } = require('node:zlib')
    const payloads = ${JSON.stringify(payloads)}

    function unpack(name) {
      return brotliDecompressSync(Buffer.from(payloads[name], 'base64'))
    }

    const runtimeFilename = path.join(__dirname, 'runtime.cjs')
    const runtime = new Module(runtimeFilename, module)
    runtime.filename = runtimeFilename
    runtime.paths = module.paths
    const run = vm.compileFunction(
      unpack('runtimeBrotliBase64').toString(),
      ['exports', 'require', 'module', '__filename', '__dirname'],
      { filename: runtimeFilename },
    )
    run(
      runtime.exports,
      runtime.require.bind(runtime),
      runtime,
      runtimeFilename,
      __dirname,
    )
    runtime.loaded = true
    module.exports = runtime.exports.load(unpack('wasmBrotliBase64'))
  `)
}

function compress (source) {
  return brotliCompressSync(source, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
    },
  }).toString('base64')
}

function minify (source) {
  return esbuild.transformSync(source, {
    format: 'cjs',
    legalComments: 'none',
    minify: true,
    target: 'node18',
  }).code
}
