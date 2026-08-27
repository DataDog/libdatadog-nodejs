'use strict'

const { createHostTransport } = require('./agentless-transport')

function remoteConfigFetcher (binding) {
  return class RemoteConfigFetcher {
    #binding

    constructor (options) {
      const transport = createHostTransport()
      this.#binding = new binding.RemoteConfigFetcher(
        options,
        transport.request,
        transport.cancelRequest,
        transport.sleep,
        transport.cancelSleep,
      )
    }

    fetchChanges () {
      return this.#binding.fetchChanges()
    }

    setConfigState (path, applyState, applyError) {
      return this.#binding.setConfigState(path, applyState, applyError)
    }

    setExtraServices (services) {
      return this.#binding.setExtraServices(services)
    }

    setProductCapabilities (products, capabilities) {
      return this.#binding.setProductCapabilities(products, capabilities)
    }
  }
}

module.exports = { remoteConfigFetcher }
