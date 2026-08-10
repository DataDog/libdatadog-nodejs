'use strict'

const assert = require('node:assert')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { createServer } = require('node:http')
const { test } = require('node:test')

const libdatadog = require('..')
const { RemoteConfigFetcher } = libdatadog.load('remote_config')
assert(RemoteConfigFetcher !== undefined)

const APPLY_STATE_ACKNOWLEDGED = 2
const APPLY_STATE_ERROR = 3

const CONFIG_PATH = 'datadog/2/ASM_FEATURES/asm-features-1/config'

/**
 * Builds a `/v0.7/config` response body: a base64 encoded TUF-like `targets` document plus the
 * base64 encoded files themselves, which is what the agent sends.
 */
function agentResponse (configs, targetsVersion) {
  const targets = {}
  const targetFiles = []

  for (const { path, file, version } of configs) {
    const raw = Buffer.from(JSON.stringify(file), 'utf8')
    targets[path] = {
      custom: { v: version },
      hashes: { sha256: createHash('sha256').update(raw).digest('hex') },
      length: raw.length,
    }
    targetFiles.push({ path, raw: raw.toString('base64') })
  }

  return JSON.stringify({
    client_configs: configs.map(({ path }) => path),
    targets: Buffer.from(JSON.stringify({
      signatures: [],
      signed: {
        _type: 'targets',
        custom: { agent_refresh_interval: 5, opaque_backend_state: `backend-state-${targetsVersion}` },
        expires: '2100-01-01T00:00:00.000000000Z',
        spec_version: '1.0.0',
        targets,
        version: targetsVersion,
      },
    }), 'utf8').toString('base64'),
    target_files: targetFiles,
  })
}

async function withAgent (run) {
  const requests = []
  const responses = []

  const server = createServer((req, res) => {
    const chunks = []
    req
      .on('data', chunk => chunks.push(chunk))
      .on('end', () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(responses.shift() ?? '{}')
      })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  const fetcher = new RemoteConfigFetcher({
    clientId: 'client-id-1',
    runtimeId: 'runtime-id-1',
    service: 'my_svc',
    env: 'my_env',
    appVersion: '1.0.0',
    tags: ['runtime-id:runtime-id-1'],
    processTags: ['entrypoint.type:script'],
    language: 'nodejs',
    tracerVersion: '1.2.3',
    url: `http://127.0.0.1:${server.address().port}`,
    timeoutMs: 5000,
  })

  try {
    await run({ fetcher, requests, responses })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('reports the client identity, products and capabilities', async () => {
  await withAgent(async ({ fetcher, requests }) => {
    fetcher.setProductCapabilities(['ASM_FEATURES', 'ASM_DD'], ['ASM_ACTIVATION', 'ASM_DD_RULES'])
    fetcher.setExtraServices(['other_svc'])

    assert.deepStrictEqual(await fetcher.fetchChanges(), [])

    const { client } = requests[0]

    assert.strictEqual(client.id, 'client-id-1')
    assert.strictEqual(client.is_tracer, true)
    assert.deepStrictEqual(client.products, ['ASM_FEATURES', 'ASM_DD'])
    // Bits 1 (ASM_ACTIVATION) and 3 (ASM_DD_RULES) of a big-endian octet string.
    assert.deepStrictEqual(client.capabilities, [0b1010])
    assert.strictEqual(client.client_tracer.language, 'nodejs')
    assert.strictEqual(client.client_tracer.service, 'my_svc')
    assert.deepStrictEqual(client.client_tracer.extra_services, ['other_svc'])
    assert.deepStrictEqual(client.client_tracer.process_tags, ['entrypoint.type:script'])
  })
})

test('diffs successive polls into add, update and remove changes', async () => {
  await withAgent(async ({ fetcher, responses }) => {
    fetcher.setProductCapabilities(['ASM_FEATURES'], [])

    responses.push(agentResponse([{ path: CONFIG_PATH, file: { asm: { enabled: true } }, version: 1 }], 1))

    const added = await fetcher.fetchChanges()
    assert.strictEqual(added.length, 1)
    assert.strictEqual(added[0].kind, 'add')
    assert.strictEqual(added[0].path, CONFIG_PATH)
    assert.strictEqual(added[0].product, 'ASM_FEATURES')
    assert.strictEqual(added[0].configId, 'asm-features-1')
    assert.strictEqual(added[0].name, 'config')
    assert.strictEqual(added[0].version, 1)
    assert.deepStrictEqual(JSON.parse(added[0].contents), { asm: { enabled: true } })

    // An unchanged config is not reported again.
    responses.push(agentResponse([{ path: CONFIG_PATH, file: { asm: { enabled: true } }, version: 1 }], 2))
    assert.deepStrictEqual(await fetcher.fetchChanges(), [])

    responses.push(agentResponse([{ path: CONFIG_PATH, file: { asm: { enabled: false } }, version: 2 }], 3))

    const updated = await fetcher.fetchChanges()
    assert.strictEqual(updated.length, 1)
    assert.strictEqual(updated[0].kind, 'update')
    assert.strictEqual(updated[0].version, 2)
    assert.deepStrictEqual(JSON.parse(updated[0].contents), { asm: { enabled: false } })

    responses.push(agentResponse([], 4))

    const removed = await fetcher.fetchChanges()
    assert.strictEqual(removed.length, 1)
    assert.strictEqual(removed[0].kind, 'remove')
    assert.strictEqual(removed[0].path, CONFIG_PATH)
    assert.strictEqual(removed[0].contents, undefined)
  })
})

test('sends the apply state set for a config on the next poll', async () => {
  await withAgent(async ({ fetcher, requests, responses }) => {
    fetcher.setProductCapabilities(['ASM_FEATURES'], [])

    responses.push(agentResponse([{ path: CONFIG_PATH, file: { asm: { enabled: true } }, version: 1 }], 1))
    await fetcher.fetchChanges()

    fetcher.setConfigState(CONFIG_PATH, APPLY_STATE_ERROR, 'Error: could not apply')

    responses.push(agentResponse([{ path: CONFIG_PATH, file: { asm: { enabled: true } }, version: 1 }], 2))
    await fetcher.fetchChanges()

    assert.deepStrictEqual(requests[1].client.state.config_states, [{
      id: 'asm-features-1',
      version: 1,
      product: 'ASM_FEATURES',
      apply_state: APPLY_STATE_ERROR,
      apply_error: 'Error: could not apply',
    }])
    assert.deepStrictEqual(requests[1].cached_target_files, [{
      path: CONFIG_PATH,
      length: 24,
      hashes: [{
        algorithm: 'sha256',
        hash: createHash('sha256').update(JSON.stringify({ asm: { enabled: true } })).digest('hex'),
      }],
    }])

    fetcher.setConfigState(CONFIG_PATH, APPLY_STATE_ACKNOWLEDGED, '')

    responses.push(agentResponse([{ path: CONFIG_PATH, file: { asm: { enabled: true } }, version: 1 }], 3))
    await fetcher.fetchChanges()

    assert.strictEqual(requests[2].client.state.config_states[0].apply_state, APPLY_STATE_ACKNOWLEDGED)
    assert.strictEqual(requests[2].client.state.config_states[0].apply_error, '')
  })
})

test('skips unknown products and capabilities, and rejects bad apply states', async () => {
  await withAgent(async ({ fetcher }) => {
    // Names this build does not know are skipped and returned, so that a tracer whose own lists
    // have moved ahead of libdatadog's keeps working with the names that do resolve.
    assert.deepStrictEqual(
      fetcher.setProductCapabilities(['ASM_FEATURES', 'NOT_A_PRODUCT'], ['ASM_ACTIVATION', 'NOT_A_CAPABILITY']),
      ['NOT_A_PRODUCT', 'NOT_A_CAPABILITY'],
    )

    assert.throws(() => fetcher.setConfigState(CONFIG_PATH, 42, ''), { message: /Unknown apply state 42/ })
    assert.throws(() => fetcher.setConfigState('nonsense', APPLY_STATE_ACKNOWLEDGED, ''))
  })
})

test('constructs on a runtime without a WebCrypto global', () => {
  // libdatadog generates the default client id with a uuid whose wasm shim reads
  // `globalThis.crypto` and has no Node fallback. Node only exposes that global inside a module
  // from v20, so without the shim in `src/node_webcrypto.js` every constructor panics and traps the
  // module -- which is how it presented on Node 18, as total failure followed by a hang.
  //
  // A child process, because the shim runs once when the module loads: the global has to be absent
  // before that, which is exactly the Node 18 condition.
  const script = `
    delete globalThis.crypto
    if (typeof globalThis.crypto !== 'undefined') throw new Error('could not hide the global')
    const { RemoteConfigFetcher } = require(${JSON.stringify(require.resolve('..'))}).load('remote_config')
    new RemoteConfigFetcher({
      clientId: 'client-id-1', runtimeId: 'runtime-id-1', service: 'my_svc', env: 'my_env',
      appVersion: '1.0.0', tags: [], processTags: [], language: 'nodejs', tracerVersion: '1.2.3',
      url: 'http://127.0.0.1:8126', timeoutMs: 1000,
    })
    process.stdout.write('constructed')
  `

  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })

  assert.strictEqual(out, 'constructed')
})

test('rejects an agent url without a scheme and host', () => {
  // libdatadog appends the remote config path to this URI and unwraps the result, so a scheme
  // without an authority would panic -- and abort the process, since release builds do not unwind.
  // `agent-host:8126` is the reachable shape: JavaScript's `new URL` accepts it too.
  assert.throws(
    () => new RemoteConfigFetcher({
      clientId: 'client-id-1',
      runtimeId: 'runtime-id-1',
      service: 'my_svc',
      env: 'my_env',
      appVersion: '1.0.0',
      tags: [],
      processTags: [],
      language: 'nodejs',
      tracerVersion: '1.2.3',
      url: 'agent-host:8126',
      timeoutMs: 1000,
    }),
    { message: /needs both a scheme and a host/ },
  )
})

test('rejects a failed poll', async () => {
  // Only the URL parsing is exercised here: no socket is listening, so the poll fails.
  const fetcher = new RemoteConfigFetcher({
    clientId: 'client-id-1',
    runtimeId: 'runtime-id-1',
    service: 'my_svc',
    env: 'my_env',
    appVersion: '1.0.0',
    tags: [],
    processTags: [],
    language: 'nodejs',
    tracerVersion: '1.2.3',
    url: 'unix:///tmp/definitely-not-a-datadog-apm-socket',
    timeoutMs: 1000,
  })

  await assert.rejects(fetcher.fetchChanges())
})
