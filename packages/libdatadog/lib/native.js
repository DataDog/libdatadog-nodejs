'use strict'

const path = require('node:path')
const os = require('node:os')

const { createAgentlessExporter } = require('./agentless')
const { remoteConfigFetcher } = require('./remote-config')

const target = getNativeTarget()
const binding = loadBinding(target)

function getNativeTarget () {
  const platform = os.platform()
  const architecture = process.arch

  if (platform === 'darwin' && (architecture === 'arm64' || architecture === 'x64')) {
    return `${platform}-${architecture}`
  }

  if (platform === 'linux' && (architecture === 'arm64' || architecture === 'x64')) {
    const libc = process.report?.getReport?.().header?.glibcVersionRuntime ? 'gnu' : 'musl'
    return `linux-${architecture}-${libc}`
  }

  throw new Error(`unsupported native libdatadog platform: ${platform}-${architecture}`)
}

function loadBinding (target) {
  if (process.env.DD_LIBDATADOG_NATIVE_PATH) {
    return require(path.resolve(process.env.DD_LIBDATADOG_NATIVE_PATH))
  }

  const localArtifact = path.join(
    __dirname,
    '..',
    'dist',
    'native',
    `libdatadog.${target}.node`,
  )

  try {
    return require(localArtifact)
  } catch {
    return require(`@datadog/libdatadog-${target}`)
  }
}

module.exports = {
  backend: () => 'native',
  DDSketch: binding.DDSketch,
  RemoteConfigFetcher: remoteConfigFetcher(binding),
  createAgentlessExporter: options => createAgentlessExporter(binding, options),
  zstd_compress: binding.zstd_compress,
}
