'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const packageRoot = path.join(__dirname, '..')
const repositoryRoot = path.join(packageRoot, '..', '..')
const profiling = process.argv.slice(2).includes('--profiling')
const unknownArguments = process.argv.slice(2).filter(argument => argument !== '--profiling')
if (unknownArguments.length > 0) {
  throw new Error(`unknown arguments: ${unknownArguments.join(', ')}`)
}

const output = profiling
  ? path.join(repositoryRoot, 'target', 'size')
  : path.join(packageRoot, 'wasm', 'napi-dist')
const napi = path.join(
  packageRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'napi.cmd' : 'napi',
)
const wasmOpt = path.join(
  packageRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wasm-opt.cmd' : 'wasm-opt',
)

fs.rmSync(output, { force: true, recursive: true })
execFileSync(napi, [
  'build',
  ...(profiling ? ['--profile', 'profiling'] : ['--release']),
  '--platform',
  '--target',
  'wasm32-wasip1-threads',
  '--manifest-path',
  path.join(repositoryRoot, 'crates', 'libdatadog', 'Cargo.toml'),
  '--output-dir',
  output,
], {
  cwd: packageRoot,
  stdio: 'inherit',
})

const wasm = path.join(output, 'libdatadog.wasm32-wasi.wasm')
const debugWasm = path.join(output, 'libdatadog.wasm32-wasi.debug.wasm')
const optimized = path.join(output, 'libdatadog.wasm32-wasi.optimized.wasm')
execFileSync(wasmOpt, [
  profiling ? debugWasm : wasm,
  '-Oz',
  '--converge',
  ...(profiling ? ['-g', '--strip-dwarf'] : ['--strip-debug']),
  '--enable-threads',
  '--enable-bulk-memory',
  '--enable-mutable-globals',
  '--enable-sign-ext',
  '--enable-nontrapping-float-to-int',
  '-o',
  optimized,
], {
  cwd: packageRoot,
  stdio: 'inherit',
})
fs.renameSync(optimized, wasm)
fs.rmSync(debugWasm, { force: true })
