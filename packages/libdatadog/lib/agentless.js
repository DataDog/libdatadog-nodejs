'use strict'

const { randomUUID } = require('node:crypto')

const { createHostTransport } = require('./agentless-transport')

class AgentlessExporter {
  #binding
  #closed = false
  #inFlight = new Set()
  #transport

  constructor (binding, options) {
    validateOptions(options)
    const runtimeId = options.runtimeId ?? randomUUID()
    const normalized = Object.fromEntries(
      Object.entries({ ...options, runtimeId })
        .filter(([, value]) => value !== null),
    )
    this.#transport = createHostTransport()
    this.#binding = new binding.AgentlessExporter(
      normalized,
      this.#transport.request,
      this.#transport.cancelRequest,
      this.#transport.sleep,
      this.#transport.cancelSleep,
    )
  }

  sendV04 (payload) {
    if (this.#closed) {
      return Promise.reject(new Error('data-pipeline exporter is closed'))
    }

    let operation
    try {
      operation = this.#transport.runWithAsyncResource(
        'libdatadog:AgentlessExporter.sendV04',
        contextId => this.#binding.sendV04(payload, contextId),
      )
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

function validateOptions (options) {
  const { timeoutMs } = options
  if (timeoutMs !== undefined && timeoutMs !== null && (
    !Number.isInteger(timeoutMs)
    || timeoutMs < 0
    || timeoutMs > 4_294_967_295
  )) {
    throw new TypeError('timeoutMs must be an unsigned integer')
  }
}

function createAgentlessExporter (binding, options) {
  return new AgentlessExporter(binding, options)
}

module.exports = { createAgentlessExporter }
