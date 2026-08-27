'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { test } = require('node:test')
const { Worker } = require('node:worker_threads')
const { zstdDecompressSync } = require('node:zlib')

const { encode } = require('@msgpack/msgpack')

const zstdMagic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

const packageRoot = path.join(__dirname, '..')
const nativeDirectory = path.join(packageRoot, 'dist', 'native')
const nativeArtifact = fs.existsSync(nativeDirectory)
  ? fs.readdirSync(nativeDirectory).find(file => file.startsWith('libdatadog.') && file.endsWith('.node'))
  : undefined
const wasmArtifact = path.join(packageRoot, 'wasm', 'dist', 'libdatadog_wasm.js')

test('native backend compresses agentless v0.4 exports with Zstandard', {
  skip: !nativeArtifact,
}, async () => {
  process.env.DD_LIBDATADOG_NATIVE_PATH = path.join(nativeDirectory, nativeArtifact)
  await assertExport(
    require('../lib/native'),
    'native',
  )
  delete process.env.DD_LIBDATADOG_NATIVE_PATH
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
  await exporter.close()

  assert.throws(
    () => pipeline.createAgentlessExporter({ ...options, timeoutMs: 1.5 }),
    /timeoutMs must be an unsigned integer/,
  )
})

const backends = [
  {
    name: 'native',
    skip: !nativeArtifact,
    load: loadNativePipeline,
  },
  {
    name: 'inline-WASM',
    skip: !fs.existsSync(wasmArtifact),
    load: () => require('../wasm'),
  },
]

for (const backend of backends) {
  test(`${backend.name} retries in Rust until the third attempt succeeds`, {
    skip: backend.skip,
  }, async () => {
    const pipeline = backend.load()
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
      await exporter.sendV04(tracePayload())
      assert.strictEqual(requests, 3)
    } finally {
      await exporter.close()
      await new Promise(resolve => server.close(resolve))
    }
  })

  test(`${backend.name} applies Rust timeouts and retry policy`, {
    skip: backend.skip,
  }, async () => {
    const pipeline = backend.load()
    let requests = 0
    const server = http.createServer((incoming) => {
      requests++
      incoming.resume()
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const exporter = createExporter(pipeline, server, { timeoutMs: 100 })
    try {
      await assert.rejects(exporter.sendV04(tracePayload()), /Request timed out/)
      assert.strictEqual(requests, 3)
    } finally {
      await exporter.close()
      await new Promise(resolve => server.close(resolve))
    }
  })

  test(`${backend.name} close cancels an active HTTP request`, {
    skip: backend.skip,
  }, async () => {
    const pipeline = backend.load()
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
      const send = exporter.sendV04(tracePayload())
      await request
      await exporter.close()
      await assert.rejects(send, /export was cancelled/)
    } finally {
      await exporter.close()
      await new Promise(resolve => server.close(resolve))
    }
  })

  test(`${backend.name} close cancels retry backoff`, {
    skip: backend.skip,
  }, async () => {
    const pipeline = backend.load()
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
      const send = exporter.sendV04(tracePayload())
      await responseSent
      await new Promise(resolve => setTimeout(resolve, 50))
      await exporter.close()
      await assert.rejects(send, /export was cancelled/)
      await new Promise(resolve => setTimeout(resolve, 1100))
      assert.strictEqual(requests, 1)
    } finally {
      await exporter.close()
      await new Promise(resolve => server.close(resolve))
    }
  })
}

test('an idle NAPI exporter does not keep Node alive', {
  skip: !nativeArtifact,
}, () => {
  const nativePath = path.join(nativeDirectory, nativeArtifact)
  const modulePath = path.join(packageRoot, 'lib', 'native.js')
  const script = `
    const pipeline = require(${JSON.stringify(modulePath)})
    pipeline.createAgentlessExporter({
      endpoint: 'http://127.0.0.1:1/api/v2/spans',
      apiKey: 'test-api-key',
      tracerVersion: '0.1.0',
      languageVersion: process.version,
      languageInterpreter: 'v8',
    })
  `
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, DD_LIBDATADOG_NATIVE_PATH: nativePath },
    encoding: 'utf8',
    timeout: 3000,
  })

  assert.notStrictEqual(result.error?.code, 'ETIMEDOUT')
  assert.strictEqual(result.status, 0, result.stderr)
})

test('NAPI exporter survives worker teardown during an HTTP request', {
  skip: !nativeArtifact,
}, async () => {
  let resolveRequest
  const request = new Promise((resolve) => {
    resolveRequest = resolve
  })
  const server = http.createServer((incoming) => {
    incoming.resume()
    incoming.once('end', resolveRequest)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads')
    process.env.DD_LIBDATADOG_NATIVE_PATH = workerData.nativePath
    const pipeline = require(workerData.modulePath)
    const exporter = pipeline.createAgentlessExporter({
      endpoint: workerData.endpoint,
      apiKey: 'test-api-key',
      tracerVersion: '0.1.0',
      languageVersion: process.version,
      languageInterpreter: 'v8',
    })
    exporter.sendV04(Buffer.from(workerData.payload)).catch(() => {})
  `, {
    eval: true,
    workerData: {
      nativePath: path.join(nativeDirectory, nativeArtifact),
      modulePath: path.join(packageRoot, 'lib', 'native.js'),
      endpoint: `http://127.0.0.1:${port}/api/v2/spans`,
      payload: tracePayload(),
    },
  })
  const workerError = new Promise((_, reject) => {
    worker.once('error', reject)
  })

  try {
    await Promise.race([request, workerError])
    const exitCode = await worker.terminate()
    assert.strictEqual(exitCode, 1)
  } finally {
    await worker.terminate()
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
      service: 'service',
      containerId: 'container-id',
    })

    try {
      await exporter.sendV04(tracePayload())
    } finally {
      await exporter.close()
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
    return require('../lib/native')
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
