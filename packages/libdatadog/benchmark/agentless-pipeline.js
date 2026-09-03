'use strict'

const assert = require('node:assert/strict')

const { encode } = require('@msgpack/msgpack')
const binding = require('@datadog/libdatadog-wasm')

const emptyBody = Buffer.alloc(0)
const zstdMagic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
const richMetaStruct = encode({ attempt: 1, feature: 'checkout' })
const selectedWorkload = process.argv[2]

/** @typedef {'http' | 'mixed-repeated-sql' | 'mixed-unique-sql' | 'rich'} WorkloadShape */
/**
 * @typedef {object} WorkloadOptions
 * @property {string} name
 * @property {number} traceCount
 * @property {number} spansPerTrace
 * @property {WorkloadShape} shape
 * @property {number} iterations
 */
/**
 * @typedef {object} Workload
 * @property {string} name
 * @property {number} traceCount
 * @property {number} spansPerTrace
 * @property {number} iterations
 * @property {Uint8Array} payload
 */
/** @typedef {{ name: string, value: string }} Header */
/** @typedef {{ method: string, url: string, headers: Header[], body: Uint8Array }} RequestPlan */
/** @typedef {{ status: number, body: Uint8Array }} BindingResponse */
/** @typedef {{ elapsedNanoseconds: number, outputBytes: number, requests: number, plan?: RequestPlan }} Sample */

const exporterOptions = {
  endpoint: 'https://example.test/v1/input',
  apiKey: 'test-api-key',
  hostname: 'benchmark-host',
  env: 'benchmark',
  service: 'web',
  version: '1.0.0',
  runtimeId: 'benchmark-runtime',
  containerId: 'benchmark-container',
  tracerVersion: '0.1.0',
  languageVersion: process.version,
  languageInterpreter: 'v8',
}

const workloadOptions = [
  { name: 'tiny', traceCount: 1, spansPerTrace: 1, shape: 'http', iterations: 5000 },
  { name: 'common-http', traceCount: 100, spansPerTrace: 3, shape: 'http', iterations: 300 },
  {
    name: 'mixed-repeated-sql',
    traceCount: 100,
    spansPerTrace: 3,
    shape: 'mixed-repeated-sql',
    iterations: 200,
  },
  {
    name: 'mixed-unique-sql',
    traceCount: 100,
    spansPerTrace: 3,
    shape: 'mixed-unique-sql',
    iterations: 200,
  },
  { name: 'rich', traceCount: 25, spansPerTrace: 8, shape: 'rich', iterations: 200 },
  { name: 'large', traceCount: 1000, spansPerTrace: 5, shape: 'mixed-repeated-sql', iterations: 15 },
]

/** @param {WorkloadOptions} options */
function createWorkload (options) {
  const traces = Array.from({ length: options.traceCount })
  for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
    const spans = Array.from({ length: options.spansPerTrace })
    for (let spanIndex = 0; spanIndex < spans.length; spanIndex++) {
      spans[spanIndex] = createSpan(traceIndex, spanIndex, options.spansPerTrace, options.shape)
    }
    traces[traceIndex] = spans
  }

  return {
    name: options.name,
    traceCount: options.traceCount,
    spansPerTrace: options.spansPerTrace,
    iterations: options.iterations,
    payload: encode(traces, { useBigInt64: true }),
  }
}

/**
 * @param {number} traceIndex
 * @param {number} spanIndex
 * @param {number} spansPerTrace
 * @param {WorkloadShape} shape
 */
function createSpan (traceIndex, spanIndex, spansPerTrace, shape) {
  const isDatabaseSpan = shape !== 'http' && spanIndex !== 0
  const queryId = shape === 'mixed-unique-sql'
    ? traceIndex * spansPerTrace + spanIndex
    : 7
  const name = isDatabaseSpan ? 'postgres.query' : 'http.request'
  const resource = isDatabaseSpan
    ? `SELECT id, email FROM users WHERE tenant_id = 42 AND id = ${queryId}`
    : `GET /users/${traceIndex % 100}`
  const start = 1_800_000_000_000_000_000n + BigInt(traceIndex * 1_000_000 + spanIndex * 1000)
  const meta = {
    'component': isDatabaseSpan ? 'pg' : 'http',
    'env': 'benchmark',
    'span.kind': spanIndex === 0 ? 'server' : 'client',
    'version': '1.0.0',
  }
  if (isDatabaseSpan) {
    meta['db.system'] = 'postgresql'
    meta['db.user'] = 'benchmark-user'
  } else {
    meta['http.method'] = 'GET'
    meta['http.status_code'] = '200'
    meta['http.url'] = `https://example.test/users/${traceIndex}?token=secret`
  }

  const span = {
    service: isDatabaseSpan ? 'postgres' : 'web',
    name,
    resource,
    trace_id: BigInt(traceIndex + 1),
    span_id: BigInt(traceIndex * 16 + spanIndex + 1),
    parent_id: spanIndex === 0 ? 0n : BigInt(traceIndex * 16 + spanIndex),
    start,
    duration: 100_000 + spanIndex * 1000,
    error: shape === 'rich' && spanIndex % 7 === 0 ? 1 : 0,
    meta,
    metrics: {
      '_dd.measured': 1,
      '_sampling_priority_v1': 1,
    },
    type: isDatabaseSpan ? 'sql' : 'web',
  }

  if (shape === 'rich') {
    for (let tagIndex = 0; tagIndex < 8; tagIndex++) {
      meta[`benchmark.tag.${tagIndex}`] = `value-${traceIndex}-${spanIndex}-${tagIndex}`
    }
    span.meta_struct = { 'benchmark.context': richMetaStruct }
    if (spanIndex % 4 === 0) {
      span.span_events = [{
        name: 'exception',
        time_unix_nano: start + 500n,
        attributes: {
          'exception.count': { type: 2, int_value: 1n },
          'exception.escaped': { type: 1, bool_value: false },
          'exception.message': { type: 0, string_value: 'request timed out' },
        },
      }]
      span.span_links = [{
        trace_id: BigInt(traceIndex + 10_001),
        trace_id_high: 0x12_34n,
        span_id: BigInt(spanIndex + 20_001),
        attributes: { 'link.name': 'scheduled_by' },
        flags: 1,
        tracestate: 'dd=s:1',
      }]
    }
  }

  return span
}

/**
 * @param {Uint8Array} payload
 * @param {number} iterations
 * @param {boolean} capturePlan
 * @returns {Promise<Sample>}
 */
function runIterations (payload, iterations, capturePlan) {
  let rejectRun
  let resolveRun
  let requests = 0
  let outputBytes = 0
  let plan
  /**
   * @param {(sample: Sample) => void} resolve
   * @param {(error: Error) => void} reject
   */
  const completed = new Promise((resolve, reject) => {
    resolveRun = resolve
    rejectRun = reject
  })

  /**
   * @param {RequestPlan} requestPlan
   * @param {(error: undefined, response: BindingResponse) => void} done
   */
  const request = (requestPlan, done) => {
    requests++
    outputBytes = requestPlan.body.byteLength
    if (capturePlan && plan === undefined) {
      plan = {
        ...requestPlan,
        body: Buffer.from(requestPlan.body),
      }
    }
    done(undefined, { status: 202, body: emptyBody })
  }

  let operations = 0

  /** @param {unknown} error */
  const complete = (error) => {
    if (error !== undefined) {
      exporter.free()
      rejectRun(new Error(String(error)))
      return
    }

    operations++
    if (operations < iterations) {
      exporter.sendV04(payload, complete)
      return
    }

    const elapsedNanoseconds = Number(process.hrtime.bigint() - start)
    exporter.free()
    resolveRun({ elapsedNanoseconds, outputBytes, requests, plan })
  }

  const exporter = new binding.AgentlessExporter(
    exporterOptions,
    request,
    cancelRequest,
    completeSleep,
    cancelSleep,
  )
  const start = process.hrtime.bigint()
  exporter.sendV04(payload, complete)
  return completed
}

function cancelRequest () {}

/**
 * @param {number} id
 * @param {number} milliseconds
 * @param {() => void} done
 */
function completeSleep (id, milliseconds, done) {
  assert(Number.isInteger(id))
  assert(Number.isInteger(milliseconds))
  done()
}

function cancelSleep () {}

/** @param {number} left @param {number} right */
function compareNumbers (left, right) {
  return left - right
}

/** @param {number[]} samples */
function trimmedMean (samples) {
  const sorted = [...samples]
  sorted.sort(compareNumbers)
  let sum = 0
  for (let index = 1; index < sorted.length - 1; index++) {
    sum += sorted[index]
  }
  return sum / (sorted.length - 2)
}

/** @param {Workload} workload */
async function validateWorkload (workload) {
  const sample = await runIterations(workload.payload, 1, true)
  const { plan } = sample
  assert(plan)
  assert.strictEqual(sample.requests, 1)
  assert.strictEqual(plan.method, 'POST')
  assert.strictEqual(plan.url, exporterOptions.endpoint)
  assert.strictEqual(findHeader(plan.headers, 'content-encoding'), 'zstd')
  assert.strictEqual(findHeader(plan.headers, 'content-type'), 'application/json')
  assert.strictEqual(findHeader(plan.headers, 'dd-api-key'), exporterOptions.apiKey)
  assert.deepStrictEqual(plan.body.subarray(0, zstdMagic.length), zstdMagic)
}

/** @param {Header[]} headers @param {string} name */
function findHeader (headers, name) {
  for (const header of headers) {
    if (header.name === name) return header.value
  }
}

/** @param {Workload} workload */
async function benchmarkWorkload (workload) {
  await validateWorkload(workload)
  const warmupBatchIterations = Math.max(workload.iterations, 50)
  let warmupElapsedNanoseconds = 0
  let warmupIterations = 0
  do {
    const sample = await runIterations(workload.payload, warmupBatchIterations, false)
    warmupElapsedNanoseconds += sample.elapsedNanoseconds
    warmupIterations += warmupBatchIterations
  } while (warmupElapsedNanoseconds < 1e9)

  const samples = Array.from({ length: 7 })
  let outputBytes = 0
  for (let trial = 0; trial < samples.length; trial++) {
    const sample = await runIterations(workload.payload, workload.iterations, false)
    assert.strictEqual(sample.requests, workload.iterations)
    samples[trial] = sample.elapsedNanoseconds / workload.iterations
    outputBytes = sample.outputBytes
  }

  const mean = trimmedMean(samples)
  return {
    name: workload.name,
    traceCount: workload.traceCount,
    spansPerTrace: workload.spansPerTrace,
    inputBytes: workload.payload.byteLength,
    outputBytes,
    warmupIterations,
    iterationsPerTrial: workload.iterations,
    samplesNanosecondsPerOperation: samples,
    trimmedMeanNanosecondsPerOperation: mean,
    operationsPerSecond: 1e9 / mean,
  }
}

function selectedWorkloads () {
  const workloads = []
  for (const options of workloadOptions) {
    if (selectedWorkload === undefined || selectedWorkload === options.name) {
      workloads.push(createWorkload(options))
    }
  }
  if (workloads.length === 0) {
    throw new Error(`unknown workload: ${selectedWorkload}`)
  }
  return workloads
}

async function main () {
  const results = []
  for (const workload of selectedWorkloads()) {
    results.push(await benchmarkWorkload(workload))
  }
  console.log(JSON.stringify({
    benchmark: 'agentless-pipeline',
    node: process.version,
    v8: process.versions.v8,
    trials: 7,
    results,
  }))
}

// CommonJS does not support top-level await.
// eslint-disable-next-line unicorn/prefer-top-level-await
main()
