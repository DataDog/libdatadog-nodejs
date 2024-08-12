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
  const root = __dirname
  const build = `${root}/build/Release/${name}.node`

  return maybeRequire(build) || maybeRequire(find(root, name))
}

function maybeRequire (name) {
  try {
    return runtimeRequire(path.join(root, `${name}.node`))
  } catch (e) {
    // Not found, skip.
  }
}

function find (root, name) {
  const folder = findFolder(root)

  if (!folder) return

  return findFile (root, folder, name)
}

function findFolder (root) {
  const folders = readdirSync(path.join(root, 'prebuilds'))

  return folders.find(f => f === `${PLATFORM}${LIBC}-${ARCH}`)
    || folders.find(f => f === `${PLATFORM}-${ARCH}`)
}

function findFile (root, folder, name) {
  if (!folder) return

  const files = readdirSync(path.join(root, 'prebuilds', folder))

  return files.find(f => f === `${name}-${ABI}.node`)
    || files.find(f => f === `${name}-napi.node`)
    || files.find(f => f === `${name}.node`)
}

module.exports = load
