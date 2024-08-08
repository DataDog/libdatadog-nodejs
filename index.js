const binding = require('node-gyp-build')(__dirname)

module.exports = { ...binding }

if (binding.crashtracker) {
  module.exports.crashtracker = {
    start (config, receiverConfig, metadata) {
      config = JSON.stringify(config)
      receiverConfig = JSON.stringify(receiverConfig)
      metadata = JSON.stringify(metadata)

      return binding.start(config, receiverConfig, metadata)
    }
  }
}
