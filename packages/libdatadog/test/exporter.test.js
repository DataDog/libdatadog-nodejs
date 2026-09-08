'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { test } = require('node:test')
const { zstdDecompressSync } = require('node:zlib')

const { decode, encode } = require('@msgpack/msgpack')

const { createHostTransport } = require('../lib/agentless-transport')

const zstdMagic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

const packageRoot = path.join(__dirname, '..')
const wasmArtifact = path.join(packageRoot, 'wasm', 'dist', 'libdatadog_wasm.js')

/** @typedef {(error?: unknown) => void} BindingDone */

class TrackingAgent extends http.Agent {
  connections = 0
  requests = 0
  destroyed = false

  constructor () {
    super({ keepAlive: true })
  }

  /**
   * @param {import('node:http').ClientRequestArgs} options
   * @param {(error: Error | null, stream: import('node:stream').Duplex) => void} [callback]
   */
  createConnection (options, callback) {
    this.connections++
    return super.createConnection(options, callback)
  }

  /**
   * @param {import('node:http').ClientRequest} request
   * @param {import('node:http').RequestOptions} options
   */
  addRequest (request, options) {
    this.requests++
    super.addRequest(request, options)
  }

  destroy () {
    this.destroyed = true
    super.destroy()
  }
}

test('package entry points defer unused agentless modules', {
  skip: !fs.existsSync(wasmArtifact),
}, () => {
  const agentlessPath = require.resolve('../lib/agentless')

  require('..')
  assert.strictEqual(require.cache[agentlessPath], undefined)

  require('../wasm')
  assert.strictEqual(require.cache[agentlessPath], undefined)
})

test('agentless exporter reports completion through its callback', async () => {
  class BindingExporter {
    /**
     * @param {Uint8Array} payload
     * @param {BindingDone} done
     */
    sendV04 (payload, done) {
      done()
    }

    cancelAll () {}
  }

  const exporter = createTestExporter(BindingExporter)
  const log = { error: assert.fail }
  let completed = 0
  let result

  await new Promise((resolve) => {
    result = exporter.sendV04(Buffer.alloc(0), () => {
      completed++
      resolve()
    }, log)
  })

  assert.strictEqual(result, undefined)
  assert.strictEqual(completed, 1)
})

test('agentless exporter reports stats completion through its callback', async () => {
  class BindingExporter {
    /**
     * @param {Uint8Array} payload
     * @param {BindingDone} done
     */
    sendStats (payload, done) {
      done()
    }

    cancelAll () {}
  }

  const exporter = createTestExporter(BindingExporter)
  const log = { error: assert.fail }
  let completed = 0
  let result

  await new Promise((resolve) => {
    result = exporter.sendStats(Buffer.alloc(0), () => {
      completed++
      resolve()
    }, log)
  })

  assert.strictEqual(result, undefined)
  assert.strictEqual(completed, 1)
})

test('agentless exporter logs asynchronous failures before reporting completion', async () => {
  class BindingExporter {
    /**
     * @param {Uint8Array} payload
     * @param {BindingDone} done
     */
    sendV04 (payload, done) {
      queueMicrotask(() => done('intake unavailable'))
    }

    cancelAll () {}
  }

  const exporter = createTestExporter(BindingExporter)
  const log = testLog()
  let completed = 0

  await new Promise((resolve) => {
    exporter.sendV04(Buffer.alloc(0), () => {
      completed++
      assert.strictEqual(log.errors.length, 1)
      resolve()
    }, log)
  })

  assert.strictEqual(completed, 1)
  assert.deepStrictEqual(log.errors, [[
    'Failed to send data-pipeline export: %s',
    'intake unavailable',
  ]])
})

test('agentless exporter logs synchronous failures before reporting completion', () => {
  class BindingExporter {
    sendV04 () {
      throw new Error('binding unavailable')
    }

    cancelAll () {}
  }

  const exporter = createTestExporter(BindingExporter)
  const log = testLog()
  let completed = 0

  exporter.sendV04(Buffer.alloc(0), () => {
    completed++
    assert.strictEqual(log.errors.length, 1)
  }, log)

  assert.strictEqual(completed, 1)
  assert.deepStrictEqual(log.errors, [[
    'Failed to send data-pipeline export: %s',
    'binding unavailable',
  ]])
})

test('agentless exporter logs failures settled before close', async () => {
  let completeSend

  class BindingExporter {
    /**
     * @param {Uint8Array} payload
     * @param {BindingDone} done
     */
    sendV04 (payload, done) {
      completeSend = done
    }

    cancelAll () {}
  }

  const exporter = createTestExporter(BindingExporter)
  const log = testLog()
  let completed = 0
  const send = new Promise((resolve) => {
    exporter.sendV04(Buffer.alloc(0), () => {
      completed++
      resolve()
    }, log)
  })

  completeSend('intake unavailable')
  exporter.close()
  await send

  assert.strictEqual(completed, 1)
  assert.deepStrictEqual(log.errors, [[
    'Failed to send data-pipeline export: %s',
    'intake unavailable',
  ]])
})

test('agentless exporter reports trace and stats sends after close without calling the binding', () => {
  let cancellations = 0
  let traceSends = 0
  let statsSends = 0

  class BindingExporter {
    sendV04 () {
      traceSends++
    }

    sendStats () {
      statsSends++
    }

    cancelAll () {
      cancellations++
    }
  }

  const exporter = createTestExporter(BindingExporter)
  const log = testLog()
  let completed = 0

  const result = exporter.close()
  exporter.sendV04(Buffer.alloc(0), () => completed++, log)
  exporter.sendStats(Buffer.alloc(0), () => completed++, log)

  assert.strictEqual(result, undefined)
  assert.strictEqual(cancellations, 1)
  assert.strictEqual(completed, 2)
  assert.strictEqual(traceSends, 0)
  assert.strictEqual(statsSends, 0)
  assert.deepStrictEqual(log.errors, [
    ['Cannot send data-pipeline export after the exporter is closed'],
    ['Cannot send agentless stats after the exporter is closed'],
  ])
})

test('package entry point compresses agentless v0.4 exports with Zstandard', {
  skip: !fs.existsSync(wasmArtifact),
}, async () => {
  await assertExport(require('..'))
})

test('package entry point exports agentless client stats', {
  skip: !fs.existsSync(wasmArtifact) || !zstdDecompressSync,
}, async () => {
  const pipeline = require('..')
  const requests = await withRecordingIntake(async (endpoint, server) => {
    const exporter = createExporter(pipeline, server, {
      statsEndpoint: statsEndpoint(endpoint),
      hostname: 'host',
      env: 'test',
      runtimeId: 'runtime-id',
      containerId: 'container-id',
      entityId: 'in-1234',
      clientComputedTopLevel: true,
    })
    try {
      await sendStatsExport(exporter, statsPayload())
    } finally {
      exporter.close()
    }
  })

  assert.strictEqual(requests.length, 1)
  const received = requests[0]
  assert.strictEqual(received.method, 'POST')
  assert.strictEqual(received.path, '/api/v0.2/stats')
  assert.strictEqual(received.headers['dd-api-key'], 'test-api-key')
  assert.strictEqual(received.headers['datadog-container-id'], 'container-id')
  assert.strictEqual(received.headers['datadog-entity-id'], 'in-1234')
  assert.strictEqual(received.headers['datadog-client-computed-stats'], 'true')
  assert.strictEqual(received.headers['datadog-client-computed-top-level'], 'true')
  assert.strictEqual(received.headers['datadog-obfuscation-version'], '1')
  assert.match(received.headers['content-type'], /^application\/msgpack/)
  assert.strictEqual(received.headers['content-encoding'], 'zstd')
  assert.deepStrictEqual(received.body.subarray(0, zstdMagic.length), zstdMagic)

  const payload = decodeStatsRequest(received)
  assert.strictEqual(payload.AgentHostname, 'host')
  assert.strictEqual(payload.AgentEnv, 'test')
  assert.strictEqual(payload.AgentVersion, '0.1.0-nodejs')
  assert.strictEqual(payload.ClientComputed, true)
  assert.strictEqual(payload.SplitPayload, false)
  assert.strictEqual(payload.Stats[0].Lang, 'nodejs')
  assert.strictEqual(payload.Stats[0].TracerVersion, '0.1.0')
  assert.strictEqual(payload.Stats[0].RuntimeID, 'runtime-id')
  assert.strictEqual(payload.Stats[0].ContainerID, 'container-id')
  assert.strictEqual(payload.Stats[0].Stats[0].Stats[0].Resource, 'SELECT * FROM users WHERE id = ?')
})

test('package entry point exports stats without an optional span type', {
  skip: !fs.existsSync(wasmArtifact) || !zstdDecompressSync,
}, async () => {
  const pipeline = require('..')
  const requests = await withRecordingIntake(async (endpoint, server) => {
    const exporter = createExporter(pipeline, server, {
      statsEndpoint: statsEndpoint(endpoint),
    })
    try {
      await sendStatsExport(exporter, statsPayload(1, false))
    } finally {
      exporter.close()
    }
  })

  assert.strictEqual(requests.length, 1)
  const stats = decodeStatsRequest(requests[0]).Stats[0].Stats[0].Stats[0]
  assert.strictEqual(Object.hasOwn(stats, 'Type'), false)
})

test('agentless client stats split at the intake limit', {
  skip: !fs.existsSync(wasmArtifact) || !zstdDecompressSync,
}, async () => {
  for (const [groupedStatsCount, expectedRequests] of [[4000, 1], [4001, 2]]) {
    const pipeline = require('../wasm')
    const requests = await withRecordingIntake(async (endpoint, server) => {
      const exporter = createExporter(pipeline, server, {
        statsEndpoint: statsEndpoint(endpoint),
      })
      try {
        await sendStatsExport(exporter, statsPayload(groupedStatsCount))
      } finally {
        exporter.close()
      }
    })

    let receivedStats = 0
    assert.strictEqual(requests.length, expectedRequests)
    for (const request of requests) {
      const payload = decodeStatsRequest(request)
      assert.strictEqual(payload.SplitPayload, expectedRequests > 1)
      assert.strictEqual(payload.Stats[0].Sequence, 1)
      const requestStats = payload.Stats[0].Stats[0].Stats.length
      assert.ok(requestStats <= 4000)
      receivedStats += requestStats
    }
    assert.strictEqual(receivedStats, groupedStatsCount)
  }
})

test('stats endpoint suppresses backend stats computation for v0.4 traces', {
  skip: !fs.existsSync(wasmArtifact) || !zstdDecompressSync,
}, async () => {
  const pipeline = require('../wasm')
  const requests = await withRecordingIntake(async (endpoint, server) => {
    const exporter = createExporter(pipeline, server, {
      statsEndpoint: statsEndpoint(endpoint),
    })
    try {
      await sendExport(exporter)
    } finally {
      exporter.close()
    }
  })

  assert.strictEqual(requests.length, 1)
  const payload = JSON.parse(zstdDecompressSync(requests[0].body).toString())
  assert.strictEqual(Object.hasOwn(payload.traces[0].spans[0].meta, '_dd.compute_stats'), false)
})

test('agentless exporter skips empty stats and reports malformed stats', {
  skip: !fs.existsSync(wasmArtifact),
}, async () => {
  const pipeline = require('../wasm')
  const log = testLog()
  const requests = await withRecordingIntake(async (endpoint, server) => {
    const exporter = createExporter(pipeline, server, {
      statsEndpoint: statsEndpoint(endpoint),
    })
    try {
      await sendStatsExport(exporter, statsPayload(0), log)
      await sendStatsExport(exporter, Buffer.from([0xC0]), log)
      await sendStatsExport(exporter, Buffer.from([0x81]), log)
      await sendStatsExport(exporter, Buffer.from([0x80, 0xC0]), log)
    } finally {
      exporter.close()
    }
  })

  assert.strictEqual(requests.length, 0)
  assert.strictEqual(log.errors.length, 3)
  assert.strictEqual(log.errors[0][0], 'Failed to send agentless stats: %s')
  assert.match(log.errors[0][1], /expected a MessagePack map/)
  assert.match(log.errors[1][1], /failed to decode client stats/)
  assert.match(log.errors[2][1], /trailing bytes/)
})

test('agentless exporter reports missing and invalid stats endpoints', {
  skip: !fs.existsSync(wasmArtifact),
}, async () => {
  const pipeline = require('../wasm')
  const log = testLog()
  const requests = await withRecordingIntake(async (endpoint, server) => {
    const exporter = createExporter(pipeline, server)
    const invalidExporter = createExporter(pipeline, server, {
      statsEndpoint: 'not a URL',
    })
    try {
      await sendStatsExport(exporter, statsPayload(), log)
      await sendStatsExport(invalidExporter, statsPayload(), log)
    } finally {
      exporter.close()
      invalidExporter.close()
    }
  })

  assert.strictEqual(requests.length, 0)
  assert.strictEqual(log.errors.length, 2)
  assert.deepStrictEqual(log.errors[0], [
    'Failed to send agentless stats: %s',
    'statsEndpoint must be configured before sending stats',
  ])
  assert.strictEqual(log.errors[1][0], 'Failed to send agentless stats: %s')
  assert.match(log.errors[1][1], /invalid agentless stats endpoint URL/)
})

test('package entry point uses a borrowed transport agent', {
  skip: !fs.existsSync(wasmArtifact),
}, async () => {
  const agent = new TrackingAgent()

  try {
    await assertExport(require('..'), { agent }, 2)
    assert.strictEqual(agent.requests, 2)
    assert.strictEqual(agent.connections, 1)
    assert.strictEqual(agent.destroyed, false)
  } finally {
    agent.destroy()
  }
})

test('inline-WASM backend validates optional values', {
  skip: !fs.existsSync(wasmArtifact),
}, async () => {
  const pipeline = require('../wasm')
  const options = {
    endpoint: 'http://127.0.0.1:8126/api/v2/spans',
    apiKey: 'test-api-key',
    tracerVersion: '0.1.0',
    languageVersion: process.version,
    languageInterpreter: 'v8',
  }

  const exporter = pipeline.createAgentlessExporter({
    ...options,
    hostname: null,
    env: null,
    service: null,
    version: null,
    runtimeId: null,
    containerId: null,
    entityId: null,
    clientComputedTopLevel: null,
    timeoutMs: null,
    statsEndpoint: null,
  })
  exporter.close()

  assert.throws(
    () => pipeline.createAgentlessExporter({ ...options, timeoutMs: 1.5 }),
    /timeoutMs must be an unsigned integer/,
  )
  assert.throws(
    () => pipeline.createAgentlessExporter({ ...options, statsEndpoint: 1 }),
    /statsEndpoint must be a string/,
  )
  assert.throws(
    () => pipeline.createAgentlessExporter({ ...options, entityId: 1 }),
    /entityId must be a string/,
  )
  assert.throws(
    () => pipeline.createAgentlessExporter({ ...options, clientComputedTopLevel: 'true' }),
    /clientComputedTopLevel must be a boolean/,
  )
})

test('agentless exporter retries trace and stats exports until the third attempt succeeds', {
  skip: !fs.existsSync(wasmArtifact),
}, async () => {
  const pipeline = require('../wasm')
  const requests = new Map()
  const server = http.createServer((incoming, response) => {
    incoming.resume()
    incoming.once('end', () => {
      const count = (requests.get(incoming.url) ?? 0) + 1
      requests.set(incoming.url, count)
      response.writeHead(count < 3 ? 500 : 202)
      response.end()
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const exporter = createExporter(pipeline, server, {
    statsEndpoint: `http://127.0.0.1:${port}/api/v0.2/stats`,
  })
  try {
    await Promise.all([
      sendExport(exporter),
      sendStatsExport(exporter, statsPayload()),
    ])
    assert.strictEqual(requests.get('/api/v2/spans'), 3)
    assert.strictEqual(requests.get('/api/v0.2/stats'), 3)
  } finally {
    exporter.close()
    await new Promise(resolve => server.close(resolve))
  }
})

test('agentless exporter drops over-budget requests without retrying', {
  skip: !fs.existsSync(wasmArtifact),
}, async () => {
  const pipeline = require('../wasm')
  const transport = createHostTransport()
  let requests = 0
  let resolveFirstRequest
  const firstRequestReceived = new Promise((resolve) => {
    resolveFirstRequest = resolve
  })
  const server = http.createServer((incoming) => {
    requests++
    incoming.resume()
    resolveFirstRequest()
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  transport.request({
    id: 1,
    url: `http://127.0.0.1:${port}`,
    method: 'POST',
    headers: [],
    body: Buffer.alloc(16 * 1024 * 1024),
  }, assert.fail)
  const exporter = createExporter(pipeline, server)
  try {
    await firstRequestReceived
    const log = testLog()
    await sendExport(exporter, log)
    assert.deepStrictEqual(log.errors, [])
    assert.strictEqual(requests, 1)
  } finally {
    exporter.close()
    transport.cancelRequest(1)
    await new Promise(resolve => server.close(resolve))
  }
})

test('agentless exporter applies Rust timeouts and retry policy', {
  skip: !fs.existsSync(wasmArtifact),
}, async () => {
  const pipeline = require('../wasm')
  let requests = 0
  const server = http.createServer((incoming) => {
    requests++
    incoming.resume()
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const exporter = createExporter(pipeline, server, { timeoutMs: 100 })
  try {
    const log = testLog()
    await sendExport(exporter, log)
    assert.strictEqual(requests, 3)
    assert.strictEqual(log.errors.length, 1)
    assert.strictEqual(log.errors[0][0], 'Failed to send data-pipeline export: %s')
    assert.match(log.errors[0][1], /Request timed out/)
    assert.doesNotMatch(log.errors[0][1], /data-pipeline export/)
  } finally {
    exporter.close()
    await new Promise(resolve => server.close(resolve))
  }
})

test('agentless exporter close cancels trace and stats sends started in the same turn', {
  skip: !fs.existsSync(wasmArtifact),
}, async () => {
  const pipeline = require('../wasm')
  let requests = 0
  const server = http.createServer((incoming, response) => {
    requests++
    incoming.resume()
    incoming.once('end', () => response.end())
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const exporter = createExporter(pipeline, server, {
    statsEndpoint: `http://127.0.0.1:${port}/api/v0.2/stats`,
  })
  try {
    const log = testLog()
    const sends = Promise.all([
      sendExport(exporter, log),
      sendStatsExport(exporter, statsPayload(), log),
    ])
    exporter.close()
    await sends
    assert.strictEqual(requests, 0)
    assert.deepStrictEqual(log.errors, [])
  } finally {
    exporter.close()
    await new Promise(resolve => server.close(resolve))
  }
})

test('agentless exporter close cancels an active HTTP request', {
  skip: !fs.existsSync(wasmArtifact),
}, async () => {
  const pipeline = require('../wasm')
  let resolveRequest
  const request = new Promise((resolve) => {
    resolveRequest = resolve
  })
  const server = http.createServer((incoming) => {
    incoming.resume()
    incoming.once('end', resolveRequest)
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const exporter = createExporter(pipeline, server)
  try {
    const log = testLog()
    const send = sendExport(exporter, log)
    await request
    exporter.close()
    await send
    assert.deepStrictEqual(log.errors, [])
  } finally {
    exporter.close()
    await new Promise(resolve => server.close(resolve))
  }
})

test('agentless exporter close cancels retry backoff', {
  skip: !fs.existsSync(wasmArtifact),
}, async () => {
  const pipeline = require('../wasm')
  let requests = 0
  let resolveResponse
  const responseSent = new Promise((resolve) => {
    resolveResponse = resolve
  })
  const server = http.createServer((incoming, response) => {
    incoming.resume()
    incoming.once('end', () => {
      requests++
      response.writeHead(500)
      response.end(resolveResponse)
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const exporter = createExporter(pipeline, server)
  try {
    const log = testLog()
    const send = sendExport(exporter, log)
    await responseSent
    await new Promise(resolve => setTimeout(resolve, 50))
    exporter.close()
    await send
    assert.deepStrictEqual(log.errors, [])
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.strictEqual(requests, 1)
  } finally {
    exporter.close()
    await new Promise(resolve => server.close(resolve))
  }
})

/**
 * @param {typeof import('..')} pipeline
 * @param {import('../index').AgentlessTransportOptions} [transportOptions]
 * @param {number} [count]
 */
async function assertExport (pipeline, transportOptions, count = 1) {
  const received = await withIntake(async (endpoint) => {
    const exporter = pipeline.createAgentlessExporter({
      endpoint,
      apiKey: 'test-api-key',
      tracerVersion: '0.1.0',
      languageVersion: process.version,
      languageInterpreter: 'v8',
      runtimeId: 'runtime-id',
      service: 'service',
      containerId: 'container-id',
      entityId: 'in-1234',
      clientComputedTopLevel: true,
    }, transportOptions)

    try {
      for (let i = 0; i < count; i++) {
        await sendExport(exporter)
      }
    } finally {
      exporter.close()
    }
  })

  assert.strictEqual(pipeline.backend(), 'wasm')
  assert.strictEqual(received.headers['dd-api-key'], 'test-api-key')
  assert.strictEqual(received.headers['datadog-container-id'], 'container-id')
  assert.strictEqual(received.headers['datadog-entity-id'], 'in-1234')
  assert.strictEqual(received.headers['datadog-client-computed-top-level'], 'true')
  assert.match(received.headers['content-type'], /^application\/json/)
  assert.strictEqual(received.headers['content-encoding'], 'zstd')
  assert.deepStrictEqual(received.body.subarray(0, zstdMagic.length), zstdMagic)
  if (zstdDecompressSync) {
    const body = JSON.parse(zstdDecompressSync(received.body).toString())
    assert.strictEqual(body.traces[0].runtimeID, 'runtime-id')
    assert.strictEqual(body.traces[0].spans[0].name, 'operation')
    assert.strictEqual(body.traces[0].spans[0].service, 'service')
    assert.strictEqual(body.traces[0].spans[0].meta['_dd.compute_stats'], '1')
  }
}

function tracePayload () {
  return encode([[{
    service: 'service',
    name: 'operation',
    resource: 'resource',
    trace_id: 1n,
    span_id: 2n,
    parent_id: 0n,
    start: 1,
    duration: 1,
    error: 0,
    meta: {},
    metrics: {},
  }]], { useBigInt64: true })
}

function createExporter (pipeline, server, options = {}) {
  const { port } = server.address()
  return pipeline.createAgentlessExporter({
    endpoint: `http://127.0.0.1:${port}/api/v2/spans`,
    apiKey: 'test-api-key',
    tracerVersion: '0.1.0',
    languageVersion: process.version,
    languageInterpreter: 'v8',
    ...options,
  })
}

function exporterOptions () {
  return {
    endpoint: 'https://example.test/api/v2/spans',
    apiKey: 'test-api-key',
    tracerVersion: '0.1.0',
    languageVersion: process.version,
    languageInterpreter: 'v8',
  }
}

/**
 * @typedef {object} TestBindingExporter
 * @property {(payload: Uint8Array, done: BindingDone) => void} sendV04
 * @property {() => void} cancelAll
 */

/**
 * @param {new (...args: unknown[]) => TestBindingExporter} BindingExporter
 */
function createTestExporter (BindingExporter) {
  const { createAgentlessExporter } = require('../lib/agentless')
  return createAgentlessExporter({ AgentlessExporter: BindingExporter }, exporterOptions())
}

function testLog () {
  const errors = []
  return {
    errors,
    error (...args) {
      errors.push(args)
    },
  }
}

/**
 * @param {import('../index').AgentlessExporter} exporter
 * @param {ReturnType<typeof testLog>} [log]
 */
function sendExport (exporter, log = testLog()) {
  let result
  const completed = new Promise((resolve) => {
    result = exporter.sendV04(tracePayload(), resolve, log)
  })
  assert.strictEqual(result, undefined)
  return completed
}

/**
 * @param {import('../index').AgentlessExporter} exporter
 * @param {Uint8Array} payload
 * @param {ReturnType<typeof testLog>} [log]
 */
function sendStatsExport (exporter, payload, log = testLog()) {
  let result
  const completed = new Promise((resolve) => {
    result = exporter.sendStats(payload, resolve, log)
  })
  assert.strictEqual(result, undefined)
  return completed
}

/**
 * @param {number} [groupedStatsCount]
 * @param {boolean} [includeType]
 */
function statsPayload (groupedStatsCount = 1, includeType = true) {
  const stats = []
  for (let i = 0; i < groupedStatsCount; i++) {
    const groupedStats = {
      Service: 'service',
      Name: 'operation',
      Resource: 'SELECT * FROM users WHERE id = 42',
      HTTPStatusCode: 200,
      Hits: 1,
      Errors: 0,
      Duration: 1,
      OkSummary: Buffer.alloc(0),
      ErrorSummary: Buffer.alloc(0),
      Synthetics: false,
      TopLevelHits: 1,
      HTTPMethod: '',
      HTTPEndpoint: '',
      srv_src: '',
      SpanKind: 'server',
      GRPCStatusCode: '',
    }
    if (includeType) groupedStats.Type = 'sql'
    stats.push(groupedStats)
  }
  return encode({
    Hostname: 'host',
    Env: 'test',
    Version: '1.0.0',
    Stats: [{
      Start: 1,
      Duration: 10_000_000_000,
      Stats: stats,
    }],
    Lang: 'javascript',
    TracerVersion: '0.1.0',
    RuntimeID: 'runtime-id',
    Sequence: 1,
  })
}

/**
 * @param {{ body: Buffer }} request
 */
function decodeStatsRequest (request) {
  return decode(zstdDecompressSync(request.body))
}

/**
 * @param {string} endpoint
 */
function statsEndpoint (endpoint) {
  return new URL('/api/v0.2/stats', endpoint).href
}

/**
 * @param {(endpoint: string) => Promise<void>} send
 */
async function withIntake (send) {
  const requests = await withRecordingIntake(send)
  return requests[0]
}

/**
 * @param {(endpoint: string, server: import('node:http').Server) => Promise<void>} send
 */
async function withRecordingIntake (send) {
  const requests = []
  const server = http.createServer((incoming, response) => {
    const chunks = []
    incoming.on('data', chunk => chunks.push(chunk))
    incoming.on('end', () => {
      requests.push({
        headers: incoming.headers,
        body: Buffer.concat(chunks),
        method: incoming.method,
        path: incoming.url,
      })
      response.end()
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    await send(`http://127.0.0.1:${port}/api/v2/spans`, server)
    return requests
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}
