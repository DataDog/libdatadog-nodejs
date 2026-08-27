'use strict'

/* eslint-disable unicorn/prefer-event-target -- Node stream mocks use EventEmitter. */

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')
const { execFileSync } = require('node:child_process')
const { EventEmitter } = require('node:events')
const https = require('node:https')
const { test } = require('node:test')

const selected = require('..')
const wasm = require('../wasm')
const backends = selected === wasm
  ? [['WASM', wasm]]
  : [['native', selected], ['WASM', wasm]]

const CONFIG_PATH = 'datadog/2/ASM_FEATURES/asm-features-1/config'

function fetcherOptions (overrides = {}) {
  return {
    clientId: 'client-id-1',
    runtimeId: 'runtime-id-1',
    service: 'my_svc',
    env: 'my_env',
    appVersion: '1.0.0',
    tags: ['runtime-id:runtime-id-1'],
    processTags: ['entrypoint.type:script'],
    language: 'nodejs',
    tracerVersion: '1.2.3',
    url: 'https://datadoghq.com',
    timeoutMs: 5000,
    apiKey: 'test-api-key',
    hostname: 'test-host',
    ...overrides,
  }
}

function mockHttps (context, onRequest = () => {}) {
  const requests = []
  context.mock.method(https, 'request', (url, options, onResponse) => {
    onRequest()
    const request = new EventEmitter()
    request.destroy = error => request.emit('error', error)
    request.end = (body) => {
      requests.push({ body: Buffer.from(body), options, url: url.toString() })
      queueMicrotask(() => {
        const response = new EventEmitter()
        response.statusCode = 200
        onResponse(response)
        response.emit('end')
      })
    }
    return request
  })
  return requests
}

test('WASM agentless remote config does not require WebCrypto', () => {
  const entryPoint = require.resolve('../wasm')
  const script = `
    delete globalThis.crypto
    if (globalThis.crypto !== undefined) throw new Error('could not hide WebCrypto')
    const { EventEmitter } = require('node:events')
    const https = require('node:https')
    let requested = false
    https.request = (_url, _options, onResponse) => {
      const request = new EventEmitter()
      request.destroy = error => request.emit('error', error)
      request.end = () => {
        requested = true
        queueMicrotask(() => {
          const response = new EventEmitter()
          response.statusCode = 200
          onResponse(response)
          response.emit('end')
        })
      }
      return request
    }
    const { RemoteConfigFetcher } = require(${JSON.stringify(entryPoint)})
    new RemoteConfigFetcher(${JSON.stringify(fetcherOptions())})
      .fetchChanges()
      .then(() => { throw new Error('invalid TUF response was accepted') })
      .catch(() => {
        if (!requested) throw new Error('agentless request was not sent')
        process.stdout.write('ok')
      })
  `

  assert.strictEqual(
    execFileSync(process.execPath, ['--eval', script], { encoding: 'utf8' }),
    'ok',
  )
})

for (const [name, { RemoteConfigFetcher }] of backends) {
  test(`${name} remote config preserves async context in host callbacks`, async (context) => {
    const storage = new AsyncLocalStorage()
    const stores = []
    mockHttps(context, () => stores.push(storage.getStore()))
    const fetcher = new RemoteConfigFetcher(fetcherOptions())
    const expected = { operation: 'remote-config' }

    await assert.rejects(
      storage.run(expected, () => fetcher.fetchChanges()),
      /missing config meta/,
    )
    assert.ok(stores.length > 0)
    assert.ok(stores.every(store => store === expected))
  })

  test(`${name} remote config sends directly to the backend`, async (context) => {
    const requests = mockHttps(context)
    const fetcher = new RemoteConfigFetcher(fetcherOptions())
    assert.deepStrictEqual(
      fetcher.setProductCapabilities(
        ['ASM_FEATURES', 'ASM_DD'],
        ['ASM_ACTIVATION', 'ASM_DD_RULES'],
      ),
      [],
    )
    fetcher.setExtraServices(['other_svc'])

    await assert.rejects(fetcher.fetchChanges(), /missing config meta/)
    assert.strictEqual(requests.length, 2)
    const request = requests.find(({ url }) => url.endsWith('/api/v0.1/configurations'))
    assert.ok(request)
    assert.strictEqual(
      request.url,
      'https://config.datadoghq.com/api/v0.1/configurations',
    )
    assert.strictEqual(request.options.headers['dd-api-key'], 'test-api-key')
    assert.strictEqual(request.options.method, 'POST')
    assert.ok(request.body.length > 0)
  })

  test(`${name} remote config validates input`, () => {
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
    assert.throws(
      () => new RemoteConfigFetcher(fetcherOptions({ url: 'http://datadoghq.com' })),
      /agentless endpoint is invalid/,
    )
    assert.throws(
      () => new RemoteConfigFetcher(fetcherOptions({ hostname: '' })),
      /hostname is empty/,
    )
  })

  test(`${name} remote config enforces its request timeout`, async (context) => {
    context.mock.method(https, 'request', () => {
      const request = new EventEmitter()
      request.destroy = error => request.emit('error', error)
      request.end = () => {}
      return request
    })

    const fetcher = new RemoteConfigFetcher(fetcherOptions({ timeoutMs: 1 }))
    await assert.rejects(fetcher.fetchChanges(), /timed out after 1ms/)
  })
}
