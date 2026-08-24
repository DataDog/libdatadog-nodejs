'use strict'

const path = require('node:path')
const os = require('node:os')

const nativePackage = getNativePackageName()
const binding = process.env.DD_LIBDATADOG_NATIVE_PATH
  ? require(path.resolve(process.env.DD_LIBDATADOG_NATIVE_PATH))
  : require(nativePackage)

function getNativePackageName () {
  const platform = os.platform()
  const architecture = process.arch

  if (platform === 'darwin' && (architecture === 'arm64' || architecture === 'x64')) {
    return `@datadog/libdatadog-${platform}-${architecture}`
  }

  if (platform === 'linux' && (architecture === 'arm64' || architecture === 'x64')) {
    const libc = process.report?.getReport?.().header?.glibcVersionRuntime ? 'gnu' : 'musl'
    return `@datadog/libdatadog-linux-${architecture}-${libc}`
  }

  throw new Error(`unsupported native libdatadog platform: ${platform}-${architecture}`)
}

module.exports = {
  backend: () => 'native',
  DDSketch: binding.DDSketch,
  zstd_compress: binding.zstd_compress,
}
