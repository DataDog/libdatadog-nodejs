'use strict'

/* eslint-disable unicorn/prefer-event-target -- Node stream mocks use EventEmitter. */

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')
const { EventEmitter } = require('node:events')
const https = require('node:https')
const { test } = require('node:test')

const { RemoteConfigFetcher, setStorage } = require('../remote-config')

const CONFIG_PATH = 'datadog/2/ASM_FEATURES/asm-features-1/config'

/** @typedef {import('../remote-config').RemoteConfigFetcherOptions} RemoteConfigFetcherOptions */

/**
 * @param {Partial<RemoteConfigFetcherOptions>} [overrides]
 */
function fetcherOptions (overrides = {}) {
  return {
    clientId: 'client-id',
    runtimeId: 'runtime-id',
    service: 'service',
    env: 'env',
    appVersion: '1.0.0',
    tags: [],
    processTags: [],
    language: 'nodejs',
    tracerVersion: '1.0.0',
    url: 'https://datadoghq.com',
    timeoutMs: 5000,
    apiKey: 'api-key',
    hostname: 'host',
    ...overrides,
  }
}

test('keeps remote config out of the universal WASM entry point', () => {
  const wasm = require('../wasm')

  assert.strictEqual(wasm.RemoteConfigFetcher, undefined)
  assert.strictEqual(wasm.setStorage, undefined)
  assert.strictEqual(typeof RemoteConfigFetcher, 'function')
})

test('exports agentless remote config from the dedicated entry point', async () => {
  const requests = []
  const storage = new AsyncLocalStorage()
  const storageValue = {}
  const observedStorageValues = []
  const originalRequest = https.request

  /** @param {() => void} callback */
  function runInStorage (callback) {
    storage.run(storageValue, callback)
  }

  /**
   * @param {import('node:https').RequestOptions} options
   * @param {(response: import('node:http').IncomingMessage) => void} onResponse
   */
  function request (options, onResponse) {
    observedStorageValues.push(storage.getStore())
    const outgoing = new EventEmitter()
    const chunks = []

    /**
     * @param {string | Uint8Array} chunk
     */
    outgoing.write = function write (chunk) {
      chunks.push(Buffer.from(chunk))
    }
    outgoing.end = () => {
      requests.push({ body: Buffer.concat(chunks), options })
      queueMicrotask(() => {
        const response = new EventEmitter()
        response.statusCode = 200
        response.rawHeaders = []
        onResponse(response)
        response.emit('end')
      })
    }
    return outgoing
  }
  https.request = request
  setStorage(runInStorage)

  try {
    const fetcher = new RemoteConfigFetcher(fetcherOptions())
    assert.deepStrictEqual(
      fetcher.setProductCapabilities(['ASM_FEATURES'], ['ASM_ACTIVATION']),
      [],
    )
    fetcher.setExtraServices(['extra-service'])

    await assert.rejects(fetcher.fetchChanges())
    assert.strictEqual(observedStorageValues.some(value => value !== storageValue), false)
    assert(observedStorageValues.length > 0)

    let configRequest
    for (const request of requests) {
      if (request.options.path === '/api/v0.1/configurations') {
        configRequest = request
        break
      }
    }
    assert(configRequest)
    assert.strictEqual(configRequest.options.headers['dd-api-key'], 'api-key')
    assert.strictEqual(configRequest.options.method, 'POST')
    assert(configRequest.body.length > 0)
  } finally {
    setStorage(runWithoutStorage)
    https.request = originalRequest
  }
})

test('rejects an aborted agentless remote config response', async () => {
  const originalRequest = https.request
  let requestCount = 0

  /**
   * @param {import('node:https').RequestOptions} requestOptions
   * @param {(response: import('node:http').IncomingMessage) => void} onResponse
   */
  function request (requestOptions, onResponse) {
    assert.strictEqual(typeof requestOptions.method, 'string')
    requestCount++
    const outgoing = new EventEmitter()
    outgoing.write = () => {}
    outgoing.end = () => {
      queueMicrotask(() => {
        const response = new EventEmitter()
        response.statusCode = 200
        response.rawHeaders = []
        onResponse(response)
        response.emit('aborted')
      })
    }
    return outgoing
  }

  https.request = request
  try {
    const fetcher = new RemoteConfigFetcher(fetcherOptions())

    await assert.rejects(fetcher.fetchChanges(), /response aborted/)
    assert(requestCount > 0)
  } finally {
    https.request = originalRequest
  }
})

/** @param {() => void} callback */
function runWithoutStorage (callback) {
  callback()
}

test('keeps the WASM remote config validation contract', () => {
  const fetcher = new RemoteConfigFetcher(fetcherOptions())

  assert.deepStrictEqual(
    fetcher.setProductCapabilities(
      ['ASM_FEATURES', 'NOT_A_PRODUCT'],
      ['ASM_ACTIVATION', 'NOT_A_CAPABILITY'],
    ),
    ['NOT_A_PRODUCT', 'NOT_A_CAPABILITY'],
  )
  assert.throws(
    () => fetcher.setConfigState(CONFIG_PATH, 42),
    /Unknown apply state 42/,
  )
  assert.strictEqual(typeof setStorage, 'function')
})
