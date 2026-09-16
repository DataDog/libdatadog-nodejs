'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { test } = require('node:test')

const libdatadog = require('..')
const { RemoteConfigFetcher } = libdatadog.load('remote_config')
assert(RemoteConfigFetcher !== undefined)

const APPLY_STATE_ACKNOWLEDGED = 2

const CONFIG_PATH = 'datadog/2/ASM_FEATURES/asm-features-1/config'

/** @typedef {import('../packages/libdatadog/wasm/remote-config').RemoteConfigFetcherOptions} RemoteConfigFetcherOptions */

/** @param {Partial<RemoteConfigFetcherOptions>} [overrides] */
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
    url: 'https://api.example.invalid',
    timeoutMs: 5000,
    apiKey: 'an-api-key',
    hostname: 'my-host',
    ...overrides,
  }
}

test('requires agentless credentials', () => {
  for (const name of ['apiKey', 'hostname']) {
    const options = fetcherOptions()
    delete options[name]

    assert.throws(
      () => new RemoteConfigFetcher(options),
      new RegExp('missing field `' + name + '`'),
    )
  }
})

test('skips unknown products and capabilities, and rejects bad apply states', () => {
  const fetcher = new RemoteConfigFetcher(fetcherOptions())

  // Names this build does not know are skipped and returned, so that a tracer whose own lists
  // have moved ahead of libdatadog's keeps working with the names that do resolve.
  assert.deepStrictEqual(
    fetcher.setProductCapabilities(['ASM_FEATURES', 'NOT_A_PRODUCT'], ['ASM_ACTIVATION', 'NOT_A_CAPABILITY']),
    ['NOT_A_PRODUCT', 'NOT_A_CAPABILITY'],
  )

  assert.throws(() => fetcher.setConfigState(CONFIG_PATH, 42, ''), { message: /Unknown apply state 42/ })
  assert.throws(() => fetcher.setConfigState('nonsense', APPLY_STATE_ACKNOWLEDGED, ''))
})

test('polls on a runtime without a WebCrypto global', () => {
  // libdatadog identifies the client with a UUID, and `uuid`'s wasm RNG is bound to
  // `globalThis.crypto` with no fallback -- a global Node only exposes inside a module from v20, so
  // it panicked there and trapped the whole module. libdatadog draws those bytes through
  // `getrandom` instead, which reaches Node's `crypto` module when the global is missing.
  //
  // Polling rather than constructing: the id is generated when the fetcher is built, which is
  // deferred to the first poll, so a constructor alone proves nothing. A child process, because
  // the global has to be absent before the module loads.
  const script = String.raw`
    delete globalThis.crypto
    if (globalThis.crypto !== undefined) throw new Error('could not hide the global')
    const assert = require('node:assert/strict')
    const { RemoteConfigFetcher } = require(${JSON.stringify(require.resolve('..'))}).load('remote_config')
    const options = ${JSON.stringify(fetcherOptions())}

    async function poll () {
      await assert.rejects(
        new RemoteConfigFetcher(options).fetchChanges(),
        { message: /config\.api\.example\.invalid/ },
      )
      process.stdout.write('polled')
    }

    poll()
  `

  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })

  assert.strictEqual(out, 'polled')
})

test('rejects a url without a scheme and host', () => {
  assert.throws(
    () => new RemoteConfigFetcher(fetcherOptions({ url: 'agent-host:8126' })),
    { message: /needs both a scheme and a host/ },
  )
})

test('rejects a failed agentless poll', async () => {
  const fetcher = new RemoteConfigFetcher(fetcherOptions())

  // The backend cannot be faked: its responses are verified against TUF roots embedded in
  // libdatadog. What the failure does show is that the poll went to the configs endpoint derived
  // from the site URL rather than to the URL itself, which only happens in agentless mode.
  await assert.rejects(fetcher.fetchChanges(), { message: /config\.api\.example\.invalid/ })
})

test('rejects an agentless url without https', () => {
  assert.throws(
    () => new RemoteConfigFetcher(fetcherOptions({ url: 'http://127.0.0.1:8126' })),
    { message: /agentless endpoint is invalid/ },
  )
})

test('rejects an empty hostname', () => {
  assert.throws(
    () => new RemoteConfigFetcher(fetcherOptions({ hostname: '' })),
    { message: /hostname is empty/ },
  )
})
