'use strict'

// TODO: Extract this file to an external library.

const { existsSync, readdirSync } = require('fs')
const os = require('os')
const path = require('path')

const PLATFORM = os.platform()
const ARCH = process.arch
const LIBC = PLATFORM === 'linux' ? existsSync('/etc/alpine-release') ? 'musl' : 'glibc' : ''
const ABI = process.versions.modules

const inWebpack = typeof __webpack_require__ === 'function'
const runtimeRequire = inWebpack ? __non_webpack_require__ : require

function maybeLoad (name) {
  try {
    return load(name)
  } catch (e) {
    // Not found, skip.
  }
}

function load (name) {
  const filename = find(name)

  if (!filename) {
    throw new Error(`Could not find a ${name} binary for ${PLATFORM}${LIBC}-${ARCH}.`)
  }

  return runtimeRequire(filename)
}

function find (name, binary = false) {
  const root = __dirname
  const filename = binary ? name : `${name}.node`
  const build = `${root}/build/Release/${filename}`

  if (existsSync(build)) return build

  const folder = findFolder(root)

  if (!folder) return

  const prebuildFolder = path.join(root, 'prebuilds', folder)
  const file = findFile(prebuildFolder, name, binary)

  if (!file) return

  return path.join(prebuildFolder, file)
}

function findFolder (root) {
  try {
    const prebuilds = path.join(root, 'prebuilds')
    const folders = readdirSync(prebuilds)

    return folders.find(f => f === `${PLATFORM}${LIBC}-${ARCH}`)
      || folders.find(f => f === `${PLATFORM}-${ARCH}`)
  } catch (e) {
    return null
  }
}

function findFile (root, name, binary = false) {
  const files = readdirSync(root)

  if (binary) return files.find(f => f === name)

  return files.find(f => f === `${name}-${ABI}.node`)
    || files.find(f => f === `${name}-napi.node`)
    || files.find(f => f === `${name}.node`)
}

module.exports = { find, load, maybeLoad }
