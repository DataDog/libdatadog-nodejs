'use strict'

// TODO: Extract this file to an external library.

const { existsSync, readdirSync } = require('fs')
const os = require('os')
const path = require('path')

const PLATFORM = os.platform()
const ARCH = process.arch
const LIBC = existsSync('/etc/alpine-release') ? 'musl' : 'libc'
const ABI = process.versions.modules

const inWebpack = typeof __webpack_require__ === 'function'
const runtimeRequire = inWebpack ? __non_webpack_require__ : require

function load (name) {
  try {
    return runtimeRequire(find(name))
  } catch (e) {
    // Not found, skip.
  }
}

function find (name, binary = false) {
  const root = __dirname
  const filename = binary ? name : `${name}.node`
  const build = `${root}/build/Release/${filename}`

  if (existsSync(build)) return build

  const folder = findFolder(root)

  if (!folder) return

  return findFile(root, folder, name, binary)
}

function findFolder (root) {
  const folders = readdirSync(path.join(root, 'prebuilds'))

  return folders.find(f => f === `${PLATFORM}${LIBC}-${ARCH}`)
    || folders.find(f => f === `${PLATFORM}-${ARCH}`)
}

function findFile (root, folder, name, binary = false) {
  if (!folder) return

  const files = readdirSync(path.join(root, 'prebuilds', folder))

  if (binary) return files.find(f => f === name)

  return files.find(f => f === `${name}-${ABI}.node`)
    || files.find(f => f === `${name}-napi.node`)
    || files.find(f => f === `${name}.node`)
}

module.exports = { find, load }
