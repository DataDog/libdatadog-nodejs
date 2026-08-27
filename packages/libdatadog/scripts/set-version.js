'use strict'

const fs = require('node:fs')
const path = require('node:path')

const version = process.argv[2]

if (!version) throw new Error('usage: node scripts/set-version.js <version>')

const packagePath = path.join(__dirname, '..', 'package.json')
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
const wasmPackagePath = path.join(__dirname, '..', 'wasm', 'package.json')
const wasmPackageJson = JSON.parse(fs.readFileSync(wasmPackagePath, 'utf8'))

packageJson.version = version
packageJson.dependencies['@datadog/libdatadog-wasm'] = version
for (const name of Object.keys(packageJson.optionalDependencies)) {
  packageJson.optionalDependencies[name] = version
}
wasmPackageJson.version = version

fs.writeFileSync(packagePath, JSON.stringify(packageJson, undefined, 2) + '\n')
fs.writeFileSync(
  wasmPackagePath,
  JSON.stringify(wasmPackageJson, undefined, 2) + '\n',
)
