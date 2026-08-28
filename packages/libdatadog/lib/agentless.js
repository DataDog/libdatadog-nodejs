'use strict'

const { randomUUID } = require('node:crypto')

const { createHostTransport } = require('./agentless-transport')

/** @typedef {import('../index').AgentlessExporterOptions} AgentlessExporterOptions */

class AgentlessExporter {
  #binding
  #closed = false
  #inFlight = new Set()

  /** @param {AgentlessExporterOptions} options */
  constructor (options) {
    const binding = require('@datadog/libdatadog-wasm')
    const runtimeId = options.runtimeId ?? randomUUID()
    const transport = createHostTransport()
    this.#binding = new binding.AgentlessExporter(
      { ...options, runtimeId },
      transport.request,
      transport.cancelRequest,
      transport.sleep,
      transport.cancelSleep,
    )
  }

  sendV04 (payload) {
    if (this.#closed) {
      return Promise.reject(new Error('data-pipeline exporter is closed'))
    }

    let operation
    try {
      operation = this.#binding.sendV04(payload)
    } catch (error) {
      operation = Promise.reject(error)
    }
    this.#inFlight.add(operation)
    operation.then(
      () => this.#inFlight.delete(operation),
      () => this.#inFlight.delete(operation),
    )
    return operation
  }

  async close () {
    this.#closed = true
    this.#binding.cancelAll()
    await Promise.allSettled(this.#inFlight)
  }
}

/** @param {AgentlessExporterOptions} options */
function createAgentlessExporter (options) {
  return new AgentlessExporter(options)
}

module.exports = { createAgentlessExporter }
