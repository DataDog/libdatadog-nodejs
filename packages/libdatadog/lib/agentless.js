'use strict'

const { randomUUID } = require('node:crypto')

const { createHostTransport } = require('./agentless-transport')

/** @typedef {import('../index').AgentlessExporterOptions} AgentlessExporterOptions */
/** @typedef {import('../index').AgentlessTransportOptions} AgentlessTransportOptions */
/** @typedef {import('../index').AgentlessLogger} AgentlessLogger */
/** @typedef {typeof import('@datadog/libdatadog-wasm')} AgentlessBinding */

const canceledError = 'data-pipeline export was cancelled'

class AgentlessExporter {
  #binding
  #closed = false

  /**
   * @param {AgentlessBinding} binding
   * @param {AgentlessExporterOptions} options
   * @param {AgentlessTransportOptions} [transportOptions]
   */
  constructor (binding, options, transportOptions) {
    const { runtimeId } = options
    const bindingOptions = runtimeId === undefined || runtimeId === null
      ? { ...options, runtimeId: randomUUID() }
      : options
    const transport = createHostTransport(transportOptions)
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

    /** @param {unknown} error */
    const complete = (error) => {
      if (error !== undefined) {
        const message = errorMessage(error)
        if (!this.#closed || message !== canceledError) {
          log.error('Failed to send data-pipeline export: %s', message)
        }
      }
      done()
    }

    try {
      this.#binding.sendV04(payload, complete)
    } catch (error) {
      log.error('Failed to send data-pipeline export: %s', errorMessage(error))
      done()
    }
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
 * @param {AgentlessTransportOptions} [transportOptions]
 */
function createAgentlessExporter (binding, options, transportOptions) {
  return new AgentlessExporter(binding, options, transportOptions)
}

module.exports = { createAgentlessExporter }
