'use strict'

const { createHostTransport } = require('./agentless-transport')

function remoteConfigFetcher (binding) {
  return class RemoteConfigFetcher {
    #binding
    #transport

    constructor (options) {
      this.#transport = createHostTransport()
      this.#binding = new binding.RemoteConfigFetcher(
        options,
        this.#transport.request,
        this.#transport.cancelRequest,
        this.#transport.sleep,
        this.#transport.cancelSleep,
      )
    }

    fetchChanges () {
      return this.#transport.runWithAsyncResource(
        'libdatadog:RemoteConfigFetcher.fetchChanges',
        contextId => this.#binding.fetchChanges(contextId),
      )
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
