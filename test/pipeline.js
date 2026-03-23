'use strict'

const { describe, it, before, beforeEach } = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')

const pipeline = require('..').maybeLoad('pipeline')
const { WasmSpanState } = pipeline
const OpCode = pipeline.getOpCodes()
const wasmMemory = pipeline.getWasmMemory()

function getRandomBytes (byteCount) {
  return new Uint8Array(crypto.randomBytes(byteCount))
}

function bytesToBigInt (bytes) {
  let val = 0n
  for (let i = 0; i < bytes.length; i++) {
    val = (val << 8n) | BigInt(bytes[i])
  }
  return val
}

// The Span and NativeSpansInterface classes act as a sketch of what should
// be implemented in dd-trace-js.

// TODO should NativeSpansInterface actually be implemented in this package?

class Span {
  constructor (nativeSpans, traceId, parentId) {
    this.nativeSpans = nativeSpans
    this.traceId = traceId || [getRandomBytes(8), getRandomBytes(8)]
    this.parentId = parentId || new Uint8Array(8)
    this.spanId = getRandomBytes(8)
    this._startTime = BigInt(Date.now()) * 1000000n

    this.nativeSpans.queueOp(OpCode.Create, this.spanId, ['u128', this.traceId], ['u64', this.parentId])
    this.nativeSpans.queueOp(OpCode.SetStart, this.spanId, ['i64', this._startTime])
  }

  setTag (key, value) {
    if (typeof value === 'number') {
      this.nativeSpans.queueOp(OpCode.SetMetricAttr, this.spanId, key, ['f64', value])
    } else {
      this.nativeSpans.queueOp(OpCode.SetMetaAttr, this.spanId, key, value)
    }
    return this
  }

  getTag (key) {
    return this.nativeSpans.state.getMetaAttr(this.spanId, key) ??
           this.nativeSpans.state.getMetricAttr(this.spanId, key)
  }

  setTraceTag (key, value) {
    const opcode = OpCode[typeof value === 'number' ? 'SetTraceMetricsAttr' : 'SetTraceMetaAttr']
    if (typeof value === 'number') {
      value = ['f64', value]
    }
    this.nativeSpans.queueOp(opcode, this.spanId, key, value)
    return this
  }

  getTraceTag (key) {
    return this.nativeSpans.state.getTraceMetaAttr(this.spanId, key) ??
           this.nativeSpans.state.getTraceMetricAttr(this.spanId, key)
  }

  setTraceOrigin (origin) {
    this.nativeSpans.queueOp(OpCode.SetTraceOrigin, this.spanId, origin)
    return this
  }

  getTraceOrigin () {
    return this.nativeSpans.state.getTraceOrigin(this.spanId)
  }

  finish () {
    this.duration = BigInt(Date.now()) * 1000000n - this._startTime
    return this
  }
}

const spanAccessors = {
  // [getterName, opCode, valueType (null for string)]
  name: ['getName', 'SetName', null],
  service: ['getServiceName', 'SetServiceName', null],
  resource: ['getResourceName', 'SetResourceName', null],
  type: ['getType', 'SetType', null],
  error: ['getError', 'SetError', 'i32'],
  start: ['getStart', null, null],
  duration: ['getDuration', 'SetDuration', 'i64']
}

Object.entries(spanAccessors).forEach(([prop, [getter, setter, valueType]]) => {
  Object.defineProperty(Span.prototype, prop, {
    get () {
      return this.nativeSpans.state[getter](this.spanId)
    },
    set (val) {
      val = valueType ? [valueType, val] : val
      this.nativeSpans.queueOp(OpCode[setter], this.spanId, val);
    }
  })
})

const CHANGE_QUEUE_SIZE = 64 * 1024
const STRING_TABLE_INPUT_SIZE = 10 * 1024

class NativeSpansInterface {
  constructor (options = {}) {
    this.flushBuffer = Buffer.alloc(10 * 1024)

    this.cqbIndex = 8 // Start at 8 since first u64 is count
    this.cqbCount = 0
    this.stibCount = 0
    this.stringMap = new Map()

    this.state = new WasmSpanState(
      options.agentUrl || process.env.AGENT_URL || 'http://127.0.0.1:8126',
      options.tracerVersion || '1.0.0',
      options.lang || 'nodejs',
      options.langVersion || process.version,
      options.langInterpreter || 'v8',
      CHANGE_QUEUE_SIZE,
      STRING_TABLE_INPUT_SIZE,
      options.pid ?? process.pid,
      options.tracerService || 'test-service'
    )

    // Get pointers into WASM memory for direct buffer access
    this._wasmMemory = wasmMemory
    this._cqbPtr = this.state.change_queue_ptr()
    this._refreshViews()
  }

  _refreshViews () {
    this._cqbView = new DataView(this._wasmMemory.buffer, this._cqbPtr)
    this._cqbBytes = new Uint8Array(this._wasmMemory.buffer, this._cqbPtr)
  }

  resetChangeQueue () {
    this.cqbIndex = 8
    this.cqbCount = 0
    // Check if WASM memory was detached/grown
    if (this._wasmMemory.buffer !== this._cqbView.buffer) {
      this._refreshViews()
    }
    this._cqbView.setUint32(0, 0, true)
    this._cqbView.setUint32(4, 0, true)
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

  // Write 8 big-endian bytes as a little-endian u64 into the change buffer
  _writeBytesLE (bytes, offset) {
    const buf = this._cqbBytes
    for (let i = 0; i < 8; i++) {
      buf[offset + i] = bytes[7 - i]
    }
  }

  queueOp (op, spanId, ...args) {
    // Check if WASM memory was detached/grown
    if (this._wasmMemory.buffer !== this._cqbView.buffer) {
      this._refreshViews()
    }

    // Check if Rust flushed the queue (wrote 0 to count position)
    if (this._cqbView.getUint32(0, true) === 0 && this.cqbCount > 0) {
      this.cqbIndex = 8
      this.cqbCount = 0
    }

    const view = this._cqbView
    view.setBigUint64(this.cqbIndex, BigInt(op), true)
    this.cqbIndex += 8
    this._writeBytesLE(spanId, this.cqbIndex)
    this.cqbIndex += 8

    for (const arg of args) {
      if (typeof arg === 'string') {
        const stringId = this.getStringId(arg)
        view.setUint32(this.cqbIndex, stringId, true)
        this.cqbIndex += 4
      } else {
        const [typ, num] = arg
        switch (typ) {
          case 'u64':
            this._writeBytesLE(num, this.cqbIndex)
            this.cqbIndex += 8
            break
          case 'u128':
            this._writeBytesLE(num[0], this.cqbIndex)
            this.cqbIndex += 8
            this._writeBytesLE(num[1], this.cqbIndex)
            this.cqbIndex += 8
            break
          case 'i64':
            view.setBigInt64(this.cqbIndex, num, true)
            this.cqbIndex += 8
            break
          case 'i32':
            view.setInt32(this.cqbIndex, num, true)
            this.cqbIndex += 4
            break
          case 'f64':
            view.setFloat64(this.cqbIndex, num, true)
            this.cqbIndex += 8
            break
          default:
            throw new Error('unsupported number type: ' + typ)
        }
      }
    }

    this.cqbCount++
    view.setBigUint64(0, BigInt(this.cqbCount), true)
  }

  createSpan (traceId, parentId) {
    return new Span(this, traceId, parentId)
  }

  async flushSpans (...spans) {
    this.flushBuffer.fill(0) // TODO is this necessary, since we're sending the length?
    let index = 0
    for (const span of spans) {
      const spanId = span.spanId ?? span
      // Write big-endian span ID bytes as little-endian u64
      for (let i = 0; i < 8; i++) {
        this.flushBuffer[index + i] = spanId[7 - i]
      }
      index += 8
    }
    return this.state.flushChunk(spans.length, true, this.flushBuffer)
  }
}

describe('pipeline', () => {
  let nativeSpans

  before(() => {
    nativeSpans = new NativeSpansInterface()
  })

  beforeEach(() => {
    nativeSpans.resetChangeQueue()
  })

  describe('module exports', () => {
    it('should export WasmSpanState', () => {
      assert(WasmSpanState)
    })

    it('should export OpCode', () => {
      assert(OpCode)
    })

    it('should export all OpCodes', () => {
      const expectedOpCodes = [
        'Create', 'SetMetaAttr', 'SetMetricAttr', 'SetServiceName',
        'SetResourceName', 'SetError', 'SetStart', 'SetDuration',
        'SetType', 'SetName', 'SetTraceMetaAttr', 'SetTraceMetricsAttr',
        'SetTraceOrigin'
      ]
      for (const opCode of expectedOpCodes) {
        assert.strictEqual(typeof OpCode[opCode], 'number')
      }
    })
  })

  describe('WasmSpanState', () => {
    it('should create an instance', () => {
      assert(nativeSpans.state instanceof WasmSpanState)
    })
  })

  describe('span creation', () => {
    it('should create a span with basic attributes', () => {
      const span = nativeSpans.createSpan()
      span.name = 'test-span'
      span.service = 'test-service'
      span.resource = '/api/test'
      span.type = 'web'
      span.error = 0

      assert.strictEqual(span.name, 'test-span')
      assert.strictEqual(span.service, 'test-service')
      assert.strictEqual(span.resource, '/api/test')
      assert.strictEqual(span.type, 'web')
      assert.strictEqual(span.error, 0)
    })

    it('should create a child span with parent', () => {
      const parent = nativeSpans.createSpan()
      parent.name = 'parent-span'

      const child = nativeSpans.createSpan(parent.traceId, parent.spanId)
      child.name = 'child-span'

      assert.strictEqual(child.name, 'child-span')
    })
  })

  describe('span attributes', () => {
    it('should set and get string tags', () => {
      const span = nativeSpans.createSpan()
      span.setTag('http.method', 'GET')
      span.setTag('http.url', 'http://example.com/api')

      assert.strictEqual(span.getTag('http.method'), 'GET')
      assert.strictEqual(span.getTag('http.url'), 'http://example.com/api')
    })

    it('should set and get numeric tags', () => {
      const span = nativeSpans.createSpan()
      span.setTag('http.status_code', 200)
      span.setTag('custom.metric', 3.14159)

      assert.strictEqual(span.getTag('http.status_code'), 200)
      assert.strictEqual(span.getTag('custom.metric'), 3.14159)
    })

    it('should set and get error state', () => {
      const span = nativeSpans.createSpan()
      span.error = 0
      assert.strictEqual(span.error, 0)

      span.error = 1
      assert.strictEqual(span.error, 1)
    })
  })

  describe('span timing', () => {
    it('should set and get start time', () => {
      const span = nativeSpans.createSpan()
      assert(span.start > 0)
    })

    it('should set and get duration', () => {
      const duration = 1000000n
      const span = nativeSpans.createSpan()
      span.duration = duration
      assert.strictEqual(span.duration, Number(duration))
    })
  })

  describe('trace-level attributes', () => {
    it('should set and get trace string tags', () => {
      const span = nativeSpans.createSpan()
      span.setTraceTag('_dd.p.dm', '-0')
      assert.strictEqual(span.getTraceTag('_dd.p.dm'), '-0')
    })

    it('should set and get trace numeric tags', () => {
      const span = nativeSpans.createSpan()
      span.setTraceTag('_sampling_priority_v1', 1)
      assert.strictEqual(span.getTraceTag('_sampling_priority_v1'), 1)
    })

    it('should set and get trace origin', () => {
      const span = nativeSpans.createSpan()
      span.setTraceOrigin('synthetics')
      assert.strictEqual(span.getTraceOrigin(), 'synthetics')
    })

    it('should share trace attributes across spans in same trace', () => {
      const parent = nativeSpans.createSpan()
      parent.setTraceTag('shared_key', 'shared_value')
      parent.setTraceTag('shared_metric', 42)
      parent.setTraceOrigin('lambda')

      const child = nativeSpans.createSpan(parent.traceId, parent.spanId)

      assert.strictEqual(child.getTraceTag('shared_key'), 'shared_value')
      assert.strictEqual(child.getTraceTag('shared_metric'), 42)
      assert.strictEqual(child.getTraceOrigin(), 'lambda')
    })
  })

  describe('sampling', () => {
    it('should not expose sample() in WASM module', () => {
      // Sampling is handled JS-side; the WASM module does not expose a sample() method
      assert.strictEqual(typeof nativeSpans.state.sample, 'undefined')
    })
  })

  describe('string table', () => {
    it('should evict strings from the table', () => {
      const testKey = 'eviction-test-key-' + Math.random()
      const testVal = 'eviction-test-value'
      const span = nativeSpans.createSpan()
      span.setTag(testKey, testVal)

      assert.strictEqual(span.getTag(testKey), testVal)

      const keyId = nativeSpans.stringMap.get(testKey)
      nativeSpans.state.stringTableEvict(keyId)
      // String is evicted from table but span still has the value
    })
  })

  describe('flush to agent', () => {
    it('should flush spans to agent', async (t) => {
      const span = nativeSpans.createSpan()
      span.name = 'flush-test-span'
      span.service = 'test-service'
      span.resource = 'test-resource'
      span.type = 'web'
      span.duration = 1000000n

      try {
        const result = await nativeSpans.flushSpans(span)
        assert(result)
      } catch (err) {
        const msg = typeof err === 'string' ? err : err.message || ''
        if (msg.includes('Network') || msg.includes('Connect') || msg.includes('connect')) {
          t.skip('no agent running')
        } else {
          throw err
        }
      }
    })
  })
})
