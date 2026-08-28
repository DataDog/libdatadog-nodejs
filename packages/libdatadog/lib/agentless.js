'use strict'

const { randomUUID } = require('node:crypto')

const { createHostTransport } = require('./agentless-transport')

class AgentlessExporter {
  #binding
  #closed = false

  constructor (binding, options) {
    validateOptions(options)
    const bindingOptions = options.runtimeId === undefined
      ? { ...options, runtimeId: randomUUID() }
      : options
    const transport = createHostTransport()
    this.#binding = new binding.AgentlessExporter(
      bindingOptions,
      transport.request,
      transport.cancelRequest,
      transport.sleep,
      transport.cancelSleep,
    )
  }

  /**
   * @param {Uint8Array} payload
   * @param {() => void} done
   * @param {{ error: (message: string, ...args: unknown[]) => void }} log
   */
  sendV04 (payload, done, log) {
    if (this.#closed) {
      log.error('Cannot send data-pipeline export after the exporter is closed')
      done()
      return
    }

    let operation
    try {
      operation = this.#binding.sendV04(payload)
    } catch (error) {
      log.error('Failed to send data-pipeline export: %s', error.message)
      done()
      return
    }

    operation.then(
      done,
      (error) => {
        if (!this.#closed) {
          log.error('Failed to send data-pipeline export: %s', error.message)
        }
        done()
      },
    )
  }

  close () {
    this.#closed = true
    this.#binding.cancelAll()
  }
}

function validateOptions (options) {
  const { timeoutMs } = options
  if (timeoutMs !== undefined && (
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
