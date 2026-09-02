'use strict'

const { randomUUID } = require('node:crypto')

const { createHostTransport } = require('./agentless-transport')

/** @typedef {import('../index').AgentlessExporterOptions} AgentlessExporterOptions */
/** @typedef {import('../index').AgentlessLogger} AgentlessLogger */
/** @typedef {typeof import('@datadog/libdatadog-wasm')} AgentlessBinding */

const canceledError = 'data-pipeline export was cancelled'

class AgentlessExporter {
  #binding
  #closed = false

  /**
   * @param {AgentlessBinding} binding
   * @param {AgentlessExporterOptions} options
   */
  constructor (binding, options) {
    const { runtimeId, timeoutMs } = options
    if (timeoutMs !== undefined && timeoutMs !== null && (
      !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 0xFFFFFFFF
    )) {
      throw new TypeError('timeoutMs must be an unsigned integer')
    }
    const bindingOptions = {
      ...options,
      runtimeId: runtimeId ?? randomUUID(),
    }
    for (const name of ['hostname', 'env', 'service', 'version', 'containerId', 'timeoutMs']) {
      if (bindingOptions[name] === null) delete bindingOptions[name]
    }
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
   * @param {AgentlessLogger} log
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
      log.error('Failed to send data-pipeline export: %s', errorMessage(error))
      done()
      return
    }

    operation.then(
      done,
      (error) => {
        const message = errorMessage(error)
        if (!this.#closed || message !== canceledError) {
          log.error('Failed to send data-pipeline export: %s', message)
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

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage (error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {AgentlessBinding} binding
 * @param {AgentlessExporterOptions} options
 */
function createAgentlessExporter (binding, options) {
  return new AgentlessExporter(binding, options)
}

module.exports = { createAgentlessExporter }
