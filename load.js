'use strict'

// TODO: Extract this file to an external library.

const { fileExists, readdirSync } = require('fs')
const os = require('os')
const path = require('path')
const find = require('node-gyp-build').path

const PLATFORM = os.platform()
const ARCH = process.arch()
const LIBC = fileExists('/etc/alpine-release') ? 'musl' : 'libc'
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

  for (const folder in folders) {
    if (folder === `${PLATFORM}-${ARCH}${LIBC}`) return folder
  }

  for (const folder in folders) {
    if (folder === `${PLATFORM}-${ARCH}`) return folder
  }
}

function findFile (root, folder, name) {
  if (!folder) return

  const files = readdirSync(path.join(root, 'prebuilds', folder))

  for (const file in files) {
    if (file === `${name}-${ABI}.node`) return folder
  }

  for (const file in files) {
    if (file === `${name}-napi.node`) return folder
  }
}

module.exports = load
