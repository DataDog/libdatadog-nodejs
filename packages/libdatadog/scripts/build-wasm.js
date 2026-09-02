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

const profile = profiling ? 'profiling' : 'release'
const staging = profiling
  ? path.join(repositoryRoot, 'target', 'size')
  : path.join(packageRoot, 'wasm', 'napi-dist')
const cargo = process.env.CARGO ?? 'cargo'
const wasmOpt = path.join(
  packageRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wasm-opt.cmd' : 'wasm-opt',
)

fs.rmSync(staging, { force: true, recursive: true })
fs.mkdirSync(staging, { recursive: true })

execFileSync(cargo, [
  'build',
  ...(profiling ? ['--profile', 'profiling'] : ['--release']),
  '--target',
  'wasm32-unknown-unknown',
  '--manifest-path',
  path.join(repositoryRoot, 'crates', 'libdatadog', 'Cargo.toml'),
], {
  cwd: repositoryRoot,
  stdio: 'inherit',
})

const rawWasm = path.join(
  repositoryRoot,
  'target',
  'wasm32-unknown-unknown',
  profile,
  'libdatadog.wasm',
)
execFileSync(cargo, [
  'run',
  '--quiet',
  '--package',
  'libdatadog-wasm-bindgen',
  '--',
  rawWasm,
  staging,
], {
  cwd: repositoryRoot,
  stdio: 'inherit',
})

const transformed = path.join(staging, 'libdatadog_bg.wasm')
const optimized = path.join(staging, 'libdatadog.optimized.wasm')
const wasm = path.join(staging, 'libdatadog.wasm')
execFileSync(wasmOpt, [
  transformed,
  '-Oz',
  '--converge',
  ...(profiling ? ['-g', '--strip-dwarf'] : ['--strip-debug']),
  '--enable-bulk-memory',
  '--enable-mutable-globals',
  '--enable-sign-ext',
  '--enable-nontrapping-float-to-int',
  '--enable-reference-types',
  '-o',
  optimized,
], {
  cwd: packageRoot,
  stdio: 'inherit',
})
fs.renameSync(optimized, wasm)
fs.rmSync(transformed, { force: true })
fs.rmSync(path.join(staging, 'libdatadog.d.ts'), { force: true })
fs.rmSync(path.join(staging, 'libdatadog_bg.wasm.d.ts'), { force: true })
