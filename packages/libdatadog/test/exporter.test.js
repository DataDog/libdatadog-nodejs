'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const { test } = require('node:test')
const { zstdDecompressSync } = require('node:zlib')

const { encode } = require('@msgpack/msgpack')

const zstdMagic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

const packageRoot = path.join(__dirname, '..')
const nativeDirectory = path.join(packageRoot, 'dist', 'native')
const nativeArtifact = fs.existsSync(nativeDirectory)
  ? fs.readdirSync(nativeDirectory).find(file => file.startsWith('libdatadog.') && file.endsWith('.node'))
  : undefined
const wasmArtifact = path.join(packageRoot, 'wasm', 'dist', 'libdatadog_wasm.js')

test('package entry points defer unused agentless modules', {
  skip: !fs.existsSync(wasmArtifact),
}, () => {
  const agentlessPath = require.resolve('../lib/agentless')
  const wasmBindingPath = require.resolve('@datadog/libdatadog-wasm')

  if (nativeArtifact) {
    loadNativePipeline()
    assert.strictEqual(require.cache[wasmBindingPath], undefined)
  } else {
    require('..')
  }
  assert.strictEqual(require.cache[agentlessPath], undefined)

  require('../wasm')
  assert.strictEqual(require.cache[agentlessPath], undefined)
})

test('agentless exporter reports completion through its callback', async () => {
  class BindingExporter {
    sendV04 () {
      return Promise.resolve()
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

test('agentless exporter logs asynchronous failures before reporting completion', async () => {
  class BindingExporter {
    sendV04 () {
      return Promise.reject('intake unavailable')
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
  let rejectSend

  class BindingExporter {
    sendV04 () {
      return new Promise((resolve, reject) => {
        rejectSend = reject
      })
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

  rejectSend('intake unavailable')
  exporter.close()
  await send

  assert.strictEqual(completed, 1)
  assert.deepStrictEqual(log.errors, [[
    'Failed to send data-pipeline export: %s',
    'intake unavailable',
  ]])
})

test('agentless exporter reports sends after close without calling the binding', () => {
  let cancellations = 0
  let sends = 0

  class BindingExporter {
    sendV04 () {
      sends++
      return Promise.resolve()
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

  assert.strictEqual(result, undefined)
  assert.strictEqual(cancellations, 1)
  assert.strictEqual(completed, 1)
  assert.strictEqual(sends, 0)
  assert.deepStrictEqual(log.errors, [[
    'Cannot send data-pipeline export after the exporter is closed',
  ]])
})

test('native backend compresses agentless v0.4 exports with Zstandard', {
  skip: !nativeArtifact,
}, async () => {
  await assertExport(loadNativePipeline(), 'native')
})

test('native backend invokes the transport in the send caller context', {
  skip: !nativeArtifact,
}, async (context) => {
  const storage = new AsyncLocalStorage()
  const stores = []
  context.mock.method(http, 'request', (target, options, onResponse) => {
    stores.push(storage.getStore())
    const outgoing = new EventEmitter()
    outgoing.destroy = error => outgoing.emit('error', error)
    outgoing.end = () => {
      const response = new PassThrough()
      response.statusCode = 200
      onResponse(response)
      response.end()
    }
    return outgoing
  })

  const exporter = loadNativePipeline().createAgentlessExporter(exporterOptions())
  try {
    await storage.run('send-context', () => sendExport(exporter))
    assert.deepStrictEqual(stores, ['send-context'])
  } finally {
    exporter.close()
  }
})

test('inline-WASM backend compresses agentless v0.4 exports with Zstandard', {
  skip: !fs.existsSync(wasmArtifact),
}, async () => {
  await assertExport(
    require('../wasm'),
    'wasm',
  )
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
    timeoutMs: null,
  })
  exporter.close()

  assert.throws(
    () => pipeline.createAgentlessExporter({ ...options, timeoutMs: 1.5 }),
    /timeoutMs must be an unsigned integer/,
  )
})

test('agentless exporter retries in Rust until the third attempt succeeds', {
  skip: !fs.existsSync(wasmArtifact),
}, async () => {
  const pipeline = require('../wasm')
  let requests = 0
  const server = http.createServer((incoming, response) => {
    incoming.resume()
    incoming.once('end', () => {
      requests++
      response.writeHead(requests < 3 ? 500 : 202)
      response.end()
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const exporter = createExporter(pipeline, server)
  try {
    await sendExport(exporter)
    assert.strictEqual(requests, 3)
  } finally {
    exporter.close()
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

async function assertExport (pipeline, expectedBackend) {
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
    })

    try {
      await sendExport(exporter)
    } finally {
      exporter.close()
    }
  })

  assert.strictEqual(pipeline.backend(), expectedBackend)
  assert.strictEqual(received.headers['dd-api-key'], 'test-api-key')
  assert.strictEqual(received.headers['datadog-container-id'], 'container-id')
  assert.match(received.headers['content-type'], /^application\/json/)
  assert.strictEqual(received.headers['content-encoding'], 'zstd')
  assert.deepStrictEqual(received.body.subarray(0, zstdMagic.length), zstdMagic)
  if (zstdDecompressSync) {
    const body = JSON.parse(zstdDecompressSync(received.body).toString())
    assert.strictEqual(body.traces[0].runtimeID, 'runtime-id')
    assert.strictEqual(body.traces[0].spans[0].name, 'operation')
    assert.strictEqual(body.traces[0].spans[0].service, 'service')
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

function loadNativePipeline () {
  process.env.DD_LIBDATADOG_NATIVE_PATH = path.join(nativeDirectory, nativeArtifact)
  try {
    return require('..')
  } finally {
    delete process.env.DD_LIBDATADOG_NATIVE_PATH
  }
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
    endpoint: 'http://example.test/api/v2/spans',
    apiKey: 'test-api-key',
    tracerVersion: '0.1.0',
    languageVersion: process.version,
    languageInterpreter: 'v8',
  }
}

/**
 * @typedef {object} TestBindingExporter
 * @property {(payload: Uint8Array) => Promise<void>} sendV04
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
 * @param {{ sendV04: (payload: Uint8Array, done: () => void, log: ReturnType<typeof testLog>) => void }} exporter
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

async function withIntake (send) {
  let resolveRequest
  const request = new Promise((resolve) => {
    resolveRequest = resolve
  })
  const server = http.createServer((incoming, response) => {
    const chunks = []
    incoming.on('data', chunk => chunks.push(chunk))
    incoming.on('end', () => {
      resolveRequest({
        headers: incoming.headers,
        body: Buffer.concat(chunks),
      })
      response.end()
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    await send(`http://127.0.0.1:${port}/api/v2/spans`)
    return await request
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}
