'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const packageRoot = path.join(__dirname, '..')
const repositoryRoot = path.join(packageRoot, '..', '..')
const output = path.join(packageRoot, 'dist', 'native')
const napi = path.join(
  packageRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'napi.cmd' : 'napi',
)

fs.rmSync(output, { force: true, recursive: true })
execFileSync(napi, [
  'build',
  '-r',
  '--platform',
  '--manifest-path',
  path.join(repositoryRoot, 'crates', 'libdatadog', 'Cargo.toml'),
  '-o',
  output,
  ...process.argv.slice(2),
], {
  cwd: packageRoot,
  stdio: 'inherit',
})
