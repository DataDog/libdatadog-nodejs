'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { constants, brotliCompressSync } = require('node:zlib')

const esbuild = require('esbuild')

const packageRoot = path.join(__dirname, '..')
const staging = path.join(packageRoot, 'wasm', 'napi-dist')
const outputDirectory = path.join(packageRoot, 'wasm', 'dist')
const loaderPath = path.join(staging, 'libdatadog.wasi.cjs')
const workerPath = path.join(staging, 'wasi-worker.mjs')
const wasmPath = path.join(staging, 'libdatadog.wasm32-wasi.wasm')

const runtimeSource = bundleRuntime()
const workerSource = bundleWorker(fs.readFileSync(workerPath, 'utf8'))
const loaderSource = bundleLoader(fs.readFileSync(loaderPath, 'utf8'))
const workerBootstrap = createWorkerBootstrap(workerSource)
const output = createInlineModule({
  loader: loaderSource,
  runtime: runtimeSource,
  wasm: fs.readFileSync(wasmPath),
  worker: workerBootstrap,
})

fs.rmSync(outputDirectory, { force: true, recursive: true })
fs.mkdirSync(outputDirectory, { recursive: true })
fs.writeFileSync(path.join(outputDirectory, 'libdatadog_wasm.js'), output)
fs.copyFileSync(
  path.join(packageRoot, 'index.d.ts'),
  path.join(outputDirectory, 'libdatadog_wasm.d.ts'),
)
fs.rmSync(staging, { force: true, recursive: true })

function bundleRuntime () {
  return bundle(`
    export {
      createOnMessage,
      emnapiAsyncWorkPlugin,
      emnapiTSFNPlugin,
      getDefaultContext,
      instantiateNapiModuleSync,
      MessageHandler,
    } from '@napi-rs/wasm-runtime'
    export { createContext } from '@emnapi/runtime'
  `, 'runtime.mjs')
}

function bundleWorker (source) {
  const createRequireImport = 'import { createRequire } from "node:module";\n'
  const createRequire = 'const require = createRequire(import.meta.url);\n'
  assertContains(source, createRequireImport, 'worker createRequire import')
  assertContains(source, createRequire, 'worker createRequire call')
  assertContains(source, '@napi-rs/wasm-runtime', 'worker runtime import')

  return bundle(
    source
      .replace(createRequireImport, '')
      .replace(createRequire, '')
      .replace('@napi-rs/wasm-runtime', './runtime.cjs'),
    'wasi-worker.mjs',
    ['./runtime.cjs'],
  )
}

function bundleLoader (source) {
  const wasmStart = source.indexOf('let __wasmFilePath =')
  const wasmEndMarker = 'const __wasmFile = __nodeFs.readFileSync(__wasmFilePath)'
  const wasmEnd = source.indexOf(wasmEndMarker)
  if (wasmStart === -1 || wasmEnd === -1 || wasmEnd < wasmStart) {
    throw new Error('napi-rs WASM file loader changed; refusing to inline it')
  }

  const worker = 'return new Worker(filename, {\n'
  assertContains(source, worker, 'worker constructor')
  assertContains(source, '@napi-rs/wasm-runtime', 'loader runtime import')
  assertContains(source, '@emnapi/runtime', 'loader context import')

  source = source.slice(0, wasmStart)
    + 'const __wasmFile = __inlineWasm\n'
    + source.slice(wasmEnd + wasmEndMarker.length)
  source = source
    .replace('@napi-rs/wasm-runtime', './runtime.cjs')
    .replace('@emnapi/runtime', './runtime.cjs')
    .replace(worker, [
      'return new Worker(__inlineWorker, {',
      '        eval: true,',
      '        workerData: { directory: __dirname, runtime: __inlineRuntime },',
      '',
    ].join('\n'))

  return bundle(source, 'libdatadog.wasi.cjs', ['./runtime.cjs'])
}

function bundle (source, sourcefile, external = []) {
  const result = esbuild.buildSync({
    bundle: true,
    external,
    format: 'cjs',
    legalComments: 'none',
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

function createWorkerBootstrap (worker) {
  const workerBrotliBase64 = compress(worker)
  return minify(`
    'use strict'
    const path = require('node:path')
    const vm = require('node:vm')
    const { Module } = require('node:module')
    const { workerData } = require('node:worker_threads')
    const { brotliDecompressSync } = require('node:zlib')

    function compile(source, target, filename, load) {
      const run = vm.compileFunction(
        source,
        ['exports', 'require', 'module', '__filename', '__dirname'],
        { filename },
      )
      run(target.exports, load, target, filename, path.dirname(filename))
      target.loaded = true
    }

    const directory = workerData.directory
    const runtimeFilename = path.join(directory, 'runtime.cjs')
    const runtime = new Module(runtimeFilename, module)
    runtime.filename = runtimeFilename
    runtime.paths = module.paths
    const runtimeSource = brotliDecompressSync(
      Buffer.from(workerData.runtime, 'base64'),
    ).toString()
    compile(runtimeSource, runtime, runtimeFilename, runtime.require.bind(runtime))

    const workerFilename = path.join(directory, 'wasi-worker.cjs')
    const worker = new Module(workerFilename, module)
    worker.filename = workerFilename
    worker.paths = module.paths
    const workerSource = brotliDecompressSync(
      Buffer.from('${workerBrotliBase64}', 'base64'),
    ).toString()
    compile(workerSource, worker, workerFilename, request => {
      if (request === './runtime.cjs') return runtime.exports
      return worker.require(request)
    })
  `)
}

function createInlineModule (sources) {
  const payloads = {
    loaderBrotliBase64: compress(sources.loader),
    runtimeBrotliBase64: compress(sources.runtime),
    wasmBrotliBase64: compress(sources.wasm),
    workerBrotliBase64: compress(sources.worker),
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

    function compile(source, target, filename, load, names = [], values = []) {
      const parameters = [
        'exports',
        'require',
        'module',
        '__filename',
        '__dirname',
        ...names,
      ]
      const run = vm.compileFunction(source, parameters, { filename })
      run(
        target.exports,
        load,
        target,
        filename,
        path.dirname(filename),
        ...values,
      )
      target.loaded = true
    }

    const runtimeFilename = path.join(__dirname, 'runtime.cjs')
    const runtime = new Module(runtimeFilename, module)
    runtime.filename = runtimeFilename
    runtime.paths = module.paths
    compile(
      unpack('runtimeBrotliBase64').toString(),
      runtime,
      runtimeFilename,
      runtime.require.bind(runtime),
    )

    const worker = unpack('workerBrotliBase64').toString()
    compile(
      unpack('loaderBrotliBase64').toString(),
      module,
      __filename,
      request => {
        if (request === './runtime.cjs') return runtime.exports
        return module.require(request)
      },
      ['__inlineWasm', '__inlineRuntime', '__inlineWorker'],
      [unpack('wasmBrotliBase64'), payloads.runtimeBrotliBase64, worker],
    )
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

function assertContains (source, expected, description) {
  if (!source.includes(expected)) {
    throw new Error(`napi-rs ${description} changed; refusing to inline it`)
  }
}
