'use strict'

const { describe, it, before, beforeEach } = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')

const { NativeSpanState, OpCode } = require('..').maybeLoad('pipeline')

function getRandomBigInt (byteCount) {
  return BigInt('0x' + crypto.randomBytes(byteCount).toString('hex'))
}

// The Span and NativeSpansInterface classes act as a sketch of what should
// be implemented in dd-trace-js.

// TODO should NativeSpansInterface actually be implemented in this package?

class Span {
  constructor (nativeSpans, traceId, parentId) {
    this.nativeSpans = nativeSpans
    this.traceId = traceId || [getRandomBigInt(8), getRandomBigInt(8)]
    this.parentId = parentId || 0n
    this.spanId = getRandomBigInt(8)
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

class NativeSpansInterface {
  constructor (options = {}) {
    this.changeQueueBuffer = Buffer.alloc(64 * 1024)
    this.stringTableInputBuffer = Buffer.alloc(10 * 1024)
    this.samplingBuffer = Buffer.alloc(1024)
    this.flushBuffer = Buffer.alloc(10 * 1024)

    this.cqbIndex = 8 // Start at 8 since first u64 is count
    this.cqbCount = 0
    this.stibCount = 0
    this.stringMap = new Map()

    this.state = new NativeSpanState(
      options.agentUrl || process.env.AGENT_URL || 'http://127.0.0.1:8126',
      options.tracerVersion || '1.0.0',
      options.lang || 'nodejs',
      options.langVersion || process.version,
      options.langInterpreter || 'v8',
      this.changeQueueBuffer,
      this.stringTableInputBuffer,
      options.pid ?? process.pid,
      options.tracerService || 'test-service',
      this.samplingBuffer
    )
  }

  resetChangeQueue () {
    this.cqbIndex = 8
    this.cqbCount = 0
    this.changeQueueBuffer.fill(0)
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
    // Check if Rust flushed the queue (wrote 0 to count position)
    if (this.changeQueueBuffer.readBigUInt64LE(0) === 0n && this.cqbCount > 0) {
      this.cqbIndex = 8
      this.cqbCount = 0
    }

    this.changeQueueBuffer.writeBigUInt64LE(BigInt(op), this.cqbIndex)
    this.cqbIndex += 8
    this.changeQueueBuffer.writeBigUInt64LE(spanId, this.cqbIndex)
    this.cqbIndex += 8

    for (const arg of args) {
      if (typeof arg === 'string') {
        const stringId = this.getStringId(arg)
        this.changeQueueBuffer.writeUint32LE(stringId, this.cqbIndex)
        this.cqbIndex += 4
      } else {
        const [typ, num] = arg
        switch (typ) {
          case 'u64':
            this.changeQueueBuffer.writeBigUInt64LE(num, this.cqbIndex)
            this.cqbIndex += 8
            break
          case 'u128':
            this.changeQueueBuffer.writeBigUInt64LE(num[0], this.cqbIndex)
            this.cqbIndex += 8
            this.changeQueueBuffer.writeBigUInt64LE(num[1], this.cqbIndex)
            this.cqbIndex += 8
            break
          case 'i64':
            this.changeQueueBuffer.writeBigInt64LE(num, this.cqbIndex)
            this.cqbIndex += 8
            break
          case 'i32':
            this.changeQueueBuffer.writeInt32LE(num, this.cqbIndex)
            this.cqbIndex += 4
            break
          case 'f64':
            this.changeQueueBuffer.writeDoubleLE(num, this.cqbIndex)
            this.cqbIndex += 8
            break
          default:
            throw new Error('unsupported number type: ' + typ)
        }
      }
    }

    this.cqbCount++
    this.changeQueueBuffer.writeBigUInt64LE(BigInt(this.cqbCount), 0)
  }

  createSpan (traceId, parentId) {
    return new Span(this, traceId, parentId)
  }

  async flushSpans (...spans) {
    this.flushBuffer.fill(0) // TODO is this necessary, since we're sending the length?
    let index = 0
    for (const span of spans) {
      const spanId = span.spanId ?? span
      this.flushBuffer.writeBigUint64LE(spanId, index)
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
    it('should export NativeSpanState', () => {
      assert(NativeSpanState)
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

  describe('NativeSpanState', () => {
    it('should create an instance', () => {
      assert(nativeSpans.state instanceof NativeSpanState)
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
        if (err.message?.includes('Network') || err.message?.includes('Connect') || err.message?.includes('connect')) {
          t.skip('no agent running')
        } else {
          throw err
        }
      }
    })
  })
})
