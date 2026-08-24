'use strict'

const path = require('node:path')
const { execFileSync } = require('node:child_process')

const packageRoot = path.join(__dirname, '..')
const wasmPackageRoot = path.join(packageRoot, 'dist', 'wasm')

function pack (directory) {
  const output = execFileSync('npm', ['pack', '--json', '--dry-run'], {
    cwd: directory,
    encoding: 'utf8',
  })
  return JSON.parse(output)[0]
}

const libdatadog = pack(packageRoot)
const libdatadogWasm = pack(wasmPackageRoot)
const names = libdatadog.files.map(file => file.path)
const wasmNames = libdatadogWasm.files.map(file => file.path)
const standaloneWasm = [...names, ...wasmNames].filter(file => file.endsWith('.wasm'))

if (standaloneWasm.length > 0) {
  throw new Error(`packages must not contain standalone WASM files: ${standaloneWasm.join(', ')}`)
}

if (!names.includes('dist/wasm/libdatadog_wasm.js')) {
  throw new Error('package must contain the inline-WASM JavaScript fallback')
}

if (libdatadogWasm.name !== '@datadog/libdatadog-wasm') {
  throw new Error('WASM package must use the libdatadog package name')
}

if (names.some(file => file.includes('.node'))) {
  throw new Error('root package must not contain platform-native artifacts')
}
