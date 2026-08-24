'use strict'

const fs = require('node:fs')
const path = require('node:path')

const packageJson = require('../package.json')
const root = path.join(__dirname, '..')
const artifacts = path.join(root, 'dist', 'native')
const output = path.join(root, 'dist', 'packages')
const artifact = fs.readdirSync(artifacts).find(file => /^libdatadog\..+\.node$/.test(file))
const targetMetadata = {
  'darwin-arm64': { cpu: ['arm64'], os: ['darwin'] },
  'darwin-x64': { cpu: ['x64'], os: ['darwin'] },
  'linux-arm64-gnu': { cpu: ['arm64'], libc: ['glibc'], os: ['linux'] },
  'linux-arm64-musl': { cpu: ['arm64'], libc: ['musl'], os: ['linux'] },
  'linux-x64-gnu': { cpu: ['x64'], libc: ['glibc'], os: ['linux'] },
  'linux-x64-musl': { cpu: ['x64'], libc: ['musl'], os: ['linux'] },
}

if (!artifact) throw new Error('native artifact was not built')

const target = artifact.slice('libdatadog.'.length, -'.node'.length)
const packageName = `@datadog/libdatadog-${target}`
const metadata = targetMetadata[target]

if (!metadata) throw new Error(`unsupported native target: ${target}`)

const packageDirectory = path.join(output, target)
fs.rmSync(packageDirectory, { force: true, recursive: true })
fs.mkdirSync(packageDirectory, { recursive: true })
fs.copyFileSync(path.join(artifacts, artifact), path.join(packageDirectory, artifact))
fs.writeFileSync(path.join(packageDirectory, 'index.js'), `'use strict'\nmodule.exports = require('./${artifact}')\n`)
fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({
  name: packageName,
  version: packageJson.version,
  description: 'Platform-native backend for @datadog/libdatadog',
  license: packageJson.license,
  main: 'index.js',
  files: ['index.js', artifact],
  ...metadata,
}, undefined, 2) + '\n')
