'use strict'

const { randomUUID } = require('node:crypto')

const { createHostTransport } = require('./agentless-transport')

/** @typedef {import('../index').AgentlessExporterOptions} AgentlessExporterOptions */
/** @typedef {import('../index').AgentlessTransportOptions} AgentlessTransportOptions */
/** @typedef {import('../index').AgentlessLogger} AgentlessLogger */
/** @typedef {typeof import('@datadog/libdatadog-wasm')} AgentlessBinding */

const canceledError = 'data-pipeline export was cancelled'
const maxTimerInterval = 0x7F_FF_FF_FF

class AgentlessExporter {
  #binding
  #beforeExitHandler
  #beforeExitHandlers
  #closed = false
  #log
  #pendingForceFlushes
  #statsFlushInFlight = false
  #statsInterval
  #statsTimer

  /**
   * @param {AgentlessBinding} binding
   * @param {AgentlessExporterOptions} options
   * @param {AgentlessTransportOptions} [transportOptions]
   */
  constructor (binding, options, transportOptions) {
    const { entityId, stats } = options
    if (entityId !== undefined && entityId !== null && typeof entityId !== 'string') {
      throw new TypeError('entityId must be a string')
    }
    if (stats !== undefined) validateStatsOptions(stats)
    const { runtimeId } = options
    const bindingOptions = runtimeId === undefined || runtimeId === null
      ? { ...options, runtimeId: randomUUID() }
      : options
    const transport = createHostTransport(transportOptions, entityId ?? undefined)
    this.#binding = new binding.AgentlessExporter(
      bindingOptions,
      transport.request,
      transport.cancelRequest,
      transport.sleep,
      transport.cancelSleep,
    )
    this.#statsInterval = stats?.intervalMs
    if (this.#statsInterval !== undefined) {
      this.#beforeExitHandler = () => this.flush()
      const beforeExitHandlers = globalThis[Symbol.for('dd-trace')]?.beforeExitHandlers
      if (typeof beforeExitHandlers?.add === 'function' && typeof beforeExitHandlers?.delete === 'function') {
        this.#beforeExitHandlers = beforeExitHandlers
        beforeExitHandlers.add(this.#beforeExitHandler)
      } else {
        process.once('beforeExit', this.#beforeExitHandler)
      }
    }
  }

  #startStatsTimer () {
    if (this.#statsInterval === undefined || this.#statsTimer !== undefined) return
    this.#statsTimer = setInterval(() => this.#flushStats(false, undefined, this.#log), this.#statsInterval)
    this.#statsTimer.unref?.()
  }

  /**
   * @param {boolean} force
   * @param {() => void} [done]
   * @param {AgentlessLogger} [log]
   */
  #flushStats (force, done = () => {}, log) {
    if (this.#closed || this.#statsInterval === undefined) {
      done()
      return
    }
    if (this.#statsFlushInFlight) {
      if (force) {
        this.#pendingForceFlushes ??= []
        this.#pendingForceFlushes.push({ done, log })
      } else {
        done()
      }
      return
    }
    this.#statsFlushInFlight = true
    /** @param {unknown} error */
    const complete = (error) => {
      this.#statsFlushInFlight = false
      if (error !== undefined) {
        const message = errorMessage(error)
        if (!this.#closed || message !== canceledError) {
          log?.error('Failed to flush data-pipeline stats: %s', message)
        }
      }
      done()
      const pending = this.#pendingForceFlushes
      if (pending !== undefined) {
        this.#pendingForceFlushes = undefined
        this.#flushStats(true, () => {
          for (const callback of pending) callback.done()
        }, pending[0].log)
      }
    }
    try {
      this.#binding.flushStats(force, complete)
    } catch (error) {
      complete(error)
    }
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
    this.#log = log
    this.#startStatsTimer()

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

  /**
   * @param {() => void} [done]
   * @param {AgentlessLogger} [log]
   */
  flush (done = () => {}, log = this.#log) {
    this.#flushStats(true, done, log)
  }

  close () {
    this.#closed = true
    clearInterval(this.#statsTimer)
    if (this.#beforeExitHandlers) {
      this.#beforeExitHandlers.delete(this.#beforeExitHandler)
    } else if (this.#beforeExitHandler) {
      process.removeListener('beforeExit', this.#beforeExitHandler)
    }
    this.#binding.cancelAll()
  }
}

/**
 * @param {import('../index').AgentlessStatsOptions} options
 */
function validateStatsOptions (options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('stats must be an object')
  }
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0 || options.intervalMs > maxTimerInterval) {
    throw new TypeError(`stats.intervalMs must be a positive integer no greater than ${maxTimerInterval}`)
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
