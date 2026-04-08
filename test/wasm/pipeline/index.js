'use strict'

const http = require('http')
const assert = require('assert')
const crypto = require('crypto')
const loader = require('../../../load.js')

const pipeline = loader.load('pipeline')
assert(pipeline !== undefined, 'pipeline module loaded')

const { WasmSpanState, getOpCodes, getWasmMemory } = pipeline
const OpCode = getOpCodes()
const wasmMemory = getWasmMemory()

assert(WasmSpanState !== undefined, 'WasmSpanState exported')
assert(OpCode !== undefined, 'OpCode exported')

// Verify all OpCode values
const expectedOpCodes = [
  'Create', 'SetMetaAttr', 'SetMetricAttr', 'SetServiceName',
  'SetResourceName', 'SetError', 'SetStart', 'SetDuration',
  'SetType', 'SetName', 'SetTraceMetaAttr', 'SetTraceMetricsAttr',
  'SetTraceOrigin'
]
for (const name of expectedOpCodes) {
  assert.strictEqual(typeof OpCode[name], 'number', `OpCode.${name} should be a number`)
}
console.log('PASS: OpCode values exported correctly')

function getRandomU64 () {
  // Return a number that fits in u64 but also in f64 safely (< 2^53)
  const bytes = crypto.randomBytes(6)
  return bytes.readUIntBE(0, 6)
}

// Convert a u64 number to an 8-byte little-endian Uint8Array.
// Used to pass span IDs to WASM getter methods that expect &[u8; 8].
function u64ToLE8 (n) {
  const buf = new Uint8Array(8)
  const view = new DataView(buf.buffer)
  view.setBigUint64(0, BigInt(n), true)
  return buf
}

// WASM-adapted NativeSpansInterface
class WasmSpansInterface {
  constructor (state, wasmMemory) {
    this.state = state
    this.wasmMemory = wasmMemory

    // Get pointers into WASM memory for the change queue buffer
    const cqPtr = state.change_queue_ptr()
    const cqLen = state.change_queue_len()
    this.changeQueueBuffer = new DataView(wasmMemory.buffer, cqPtr, cqLen)

    // Get pointers into WASM memory for string table input buffer
    const stPtr = state.string_table_input_ptr()
    const stLen = state.string_table_input_len()
    this.stringTableInputBuffer = new DataView(wasmMemory.buffer, stPtr, stLen)

    this.cqbIndex = 4 // Start at 4 since first u32 is count
    this.cqbCount = 0
    this.stibCount = 0
    this.stringMap = new Map()
  }

  resetChangeQueue () {
    this.cqbIndex = 4
    this.cqbCount = 0
    // Zero out the change queue buffer
    const bytes = new Uint8Array(
      this.wasmMemory.buffer,
      this.state.change_queue_ptr(),
      this.state.change_queue_len()
    )
    bytes.fill(0)
  }

  flushChangeQueue () {
    this.state.flushChangeQueue()
    this.resetChangeQueue()
  }

  getStringId (str) {
    let id = this.stringMap.get(str)
    if (typeof id === 'number') return id

    id = this.stibCount++
    this.stringMap.set(str, id)
    this.state.stringTableInsertOne(id, str)
    return id
  }

  queueOp (op, spanId, ...args) {
    // Refresh DataView in case WASM memory grew
    const cqPtr = this.state.change_queue_ptr()
    const cqLen = this.state.change_queue_len()
    this.changeQueueBuffer = new DataView(this.wasmMemory.buffer, cqPtr, cqLen)

    // Check if Rust flushed the queue
    const currentCount = this.changeQueueBuffer.getUint32(0, true)
    if (currentCount === 0 && this.cqbCount > 0) {
      this.cqbIndex = 4
      this.cqbCount = 0
    }

    // Write OpCode as u16
    this.changeQueueBuffer.setUint16(this.cqbIndex, op, true)
    this.cqbIndex += 2
    // Write SpanId as u64
    this.changeQueueBuffer.setBigUint64(this.cqbIndex, BigInt(spanId), true)
    this.cqbIndex += 8

    for (const arg of args) {
      if (typeof arg === 'string') {
        const stringId = this.getStringId(arg)
        this.changeQueueBuffer.setUint16(this.cqbIndex, stringId, true)
        this.cqbIndex += 2
      } else {
        const [typ, num] = arg
        switch (typ) {
          case 'u64':
            this.changeQueueBuffer.setBigUint64(this.cqbIndex, BigInt(num), true)
            this.cqbIndex += 8
            break
          case 'u128': {
            // num is [lo, hi] pair of numbers
            this.changeQueueBuffer.setBigUint64(this.cqbIndex, BigInt(num[0]), true)
            this.cqbIndex += 8
            this.changeQueueBuffer.setBigUint64(this.cqbIndex, BigInt(num[1]), true)
            this.cqbIndex += 8
            break
          }
          case 'i64':
            this.changeQueueBuffer.setBigInt64(this.cqbIndex, BigInt(num), true)
            this.cqbIndex += 8
            break
          case 'i32':
            this.changeQueueBuffer.setInt32(this.cqbIndex, num, true)
            this.cqbIndex += 4
            break
          case 'f64':
            this.changeQueueBuffer.setFloat64(this.cqbIndex, num, true)
            this.cqbIndex += 8
            break
          default:
            throw new Error('unsupported number type: ' + typ)
        }
      }
    }

    this.cqbCount++
    this.changeQueueBuffer.setUint32(0, this.cqbCount, true)
  }

  createSpan (traceId, parentId) {
    const tid = traceId || [getRandomU64(), getRandomU64()]
    const pid = parentId || 0
    const spanId = getRandomU64()
    const startTime = Date.now() * 1000000

    this.queueOp(OpCode.Create, spanId, ['u128', tid], ['u64', pid])
    this.queueOp(OpCode.SetStart, spanId, ['i64', startTime])

    return { spanId, traceId: tid, parentId: pid, startTime }
  }

  async flushSpans (...spans) {
    const flushBuf = new Uint8Array(spans.length * 8)
    const view = new DataView(flushBuf.buffer)
    let index = 0
    for (const span of spans) {
      const spanId = span.spanId ?? span
      view.setBigUint64(index, BigInt(spanId), true)
      index += 8
    }
    this.state.prepareChunk(spans.length, true, flushBuf)
    return this.state.sendPreparedChunk()
  }
}

// Create a WasmSpanState
const state = new WasmSpanState(
  'http://127.0.0.1:8126', // placeholder, overridden in flush test
  '1.0.0',
  'nodejs',
  process.version,
  'v8',
  64 * 1024,  // change_queue_size
  10 * 1024,  // string_table_input_size
  process.pid,
  'test-service',
  false,       // stats_enabled
  '',          // hostname
  '',          // env
  '',          // app_version
  ''           // runtime_id
)

const iface = new WasmSpansInterface(state, wasmMemory)

// Test: create span and read attributes
{
  const span = iface.createSpan()
  iface.queueOp(OpCode.SetName, span.spanId, 'test-span')
  iface.queueOp(OpCode.SetServiceName, span.spanId, 'my-service')
  iface.queueOp(OpCode.SetResourceName, span.spanId, '/api/test')
  iface.queueOp(OpCode.SetType, span.spanId, 'web')
  iface.queueOp(OpCode.SetError, span.spanId, ['i32', 0])

  assert.strictEqual(state.getName(u64ToLE8(span.spanId)), 'test-span')
  assert.strictEqual(state.getServiceName(u64ToLE8(span.spanId)), 'my-service')
  assert.strictEqual(state.getResourceName(u64ToLE8(span.spanId)), '/api/test')
  assert.strictEqual(state.getType(u64ToLE8(span.spanId)), 'web')
  assert.strictEqual(state.getError(u64ToLE8(span.spanId)), 0)
  console.log('PASS: span creation and basic attributes')
}

// Test: meta and metric attributes
{
  iface.resetChangeQueue()
  const span = iface.createSpan()
  iface.queueOp(OpCode.SetMetaAttr, span.spanId, 'http.method', 'GET')
  iface.queueOp(OpCode.SetMetricAttr, span.spanId, 'http.status_code', ['f64', 200])

  assert.strictEqual(state.getMetaAttr(u64ToLE8(span.spanId), 'http.method'), 'GET')
  assert.strictEqual(state.getMetricAttr(u64ToLE8(span.spanId), 'http.status_code'), 200)
  console.log('PASS: meta and metric attributes')
}

// Test: trace-level attributes
{
  iface.resetChangeQueue()
  const span = iface.createSpan()
  iface.queueOp(OpCode.SetTraceMetaAttr, span.spanId, '_dd.p.dm', '-0')
  iface.queueOp(OpCode.SetTraceMetricsAttr, span.spanId, '_sampling_priority_v1', ['f64', 1])
  iface.queueOp(OpCode.SetTraceOrigin, span.spanId, 'synthetics')

  assert.strictEqual(state.getTraceMetaAttr(u64ToLE8(span.spanId), '_dd.p.dm'), '-0')
  assert.strictEqual(state.getTraceMetricAttr(u64ToLE8(span.spanId), '_sampling_priority_v1'), 1)
  assert.strictEqual(state.getTraceOrigin(u64ToLE8(span.spanId)), 'synthetics')
  console.log('PASS: trace-level attributes')
}

// Test: string table eviction
{
  iface.resetChangeQueue()
  const span = iface.createSpan()
  iface.queueOp(OpCode.SetMetaAttr, span.spanId, 'evict-key', 'evict-val')
  assert.strictEqual(state.getMetaAttr(u64ToLE8(span.spanId), 'evict-key'), 'evict-val')

  const keyId = iface.stringMap.get('evict-key')
  state.stringTableEvict(keyId)
  console.log('PASS: string table eviction')
}

// Test: flush to mock agent
const server = http.createServer((req, res) => {
  let body = []
  req.on('data', chunk => body.push(chunk))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ rate_by_service: {} }))
  })
})

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const url = `http://127.0.0.1:${port}`

  try {
    // Create a new state pointing at the mock agent
    const flushState = new WasmSpanState(
      url, '1.0.0', 'nodejs', process.version, 'v8',
      64 * 1024, 10 * 1024, process.pid, 'test-service',
      false, '', '', '', ''
    )
    const flushIface = new WasmSpansInterface(flushState, wasmMemory)

    const span = flushIface.createSpan()
    flushIface.queueOp(OpCode.SetName, span.spanId, 'flush-test')
    flushIface.queueOp(OpCode.SetServiceName, span.spanId, 'test-service')
    flushIface.queueOp(OpCode.SetResourceName, span.spanId, 'test-resource')
    flushIface.queueOp(OpCode.SetType, span.spanId, 'web')
    flushIface.queueOp(OpCode.SetDuration, span.spanId, ['i64', 1000000])

    const result = await flushIface.flushSpans(span)
    assert(result !== undefined)
    console.log('Flush result:', result)
    console.log('PASS: flush to mock agent')
  } catch (err) {
    console.error('Flush test error:', err)
    process.exitCode = 1
  } finally {
    server.close()
  }
})
