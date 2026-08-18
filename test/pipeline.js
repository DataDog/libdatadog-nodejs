'use strict'

const { describe, it, before, beforeEach } = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')

const libdatadog = require('..')

assert.strictEqual(libdatadog.pipelineApiVersion, 1)

const pipeline = libdatadog.maybeLoad('pipeline')
// The pipeline binding is wasm-only and is absent in the native
// (action-prebuildify) test matrix, where `maybeLoad` returns undefined. Skip
// the suite there instead of crashing on the destructure below; the pipeline
// wasm is built and these tests run for real in the `build-test-wasm` job.
const skip = pipeline === undefined
const { WasmSpanState } = pipeline ?? {}
const OpCode = pipeline ? pipeline.getOpCodes() : {}
const wasmMemory = pipeline ? pipeline.getWasmMemory() : undefined
const ENCODED_TRACE_PAYLOAD = Buffer.from([
  'dd00000001dd000000018ea474797065a3776562a874726163655f6964cf0000000000000001a77370616e5f6964cf',
  '0000000000000002a9706172656e745f6964cf0000000000000000a46e616d65ac656e636f6465642d6e616d65a8',
  '7265736f75726365b0656e636f6465642d7265736f75726365a773657276696365af656e636f6465642d7365727669',
  '6365a56572726f7200a57374617274cf17979cfe362a0000a86475726174696f6ece000f4240a46d657461df000000',
  '02ac656e636f6465642e6d657461ad656e636f6465642d76616c7565a97370616e2e6b696e64a6736572766572a7',
  '6d657472696373df00000003ae656e636f6465642e6d65747269632aad5f64642e746f705f6c6576656c01ac5f64',
  '642e6d6561737572656401ab7370616e5f6576656e7473dd0000000183a46e616d65ad656e636f6465642d657665',
  '6e74ae74696d655f756e69785f6e616e6fcf17979cfe362a0000aa61747472696275746573df00000001a46b696e',
  '6482a47479706500ac737472696e675f76616c7565b1656e636f6465642d617474726962757465ab6d6574615f73',
  '7472756374df00000001a6617070736563c600000023df00000002a7626c6f636b6564c3a576616c7565ae656e63',
  '6f6465642d737472756374',
].join(''), 'hex')

function getRandomBytes (byteCount) {
  return new Uint8Array(crypto.randomBytes(byteCount))
}

function bytesToBigInt (bytes) {
  let val = 0n
  for (const byte of bytes) {
    val = (val << 8n) | BigInt(byte)
  }
  return val
}

/**
 * @param {string} name
 * @param {string | undefined} value
 */
function restoreEnv (name, value) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
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
    // Spans are addressed by their span_id (u64). Operations carry the raw
    // 8-byte id in their header; getters take the numeric id as a BigInt.
    this.spanIdBig = bytesToBigInt(this.spanId)
    // Trace-level attributes live on a Segment (a local trace chunk). JS owns
    // segment_id allocation and shares it across spans in the same trace.
    this.segmentId = nativeSpans.allocSegment(this.traceId)
    this._startTime = BigInt(Date.now()) * 1_000_000n

    this.nativeSpans.queueOp(OpCode.Create, this.spanId, ['u128', this.traceId], ['u64n', this.segmentId], ['u64', this.parentId])
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
    return this.nativeSpans.state.getMetaAttr(this.spanIdBig, key)
      ?? this.nativeSpans.state.getMetricAttr(this.spanIdBig, key)
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
    return this.nativeSpans.state.getTraceMetaAttr(this.segmentId, key)
      ?? this.nativeSpans.state.getTraceMetricAttr(this.segmentId, key)
  }

  setTraceOrigin (origin) {
    this.nativeSpans.queueOp(OpCode.SetTraceOrigin, this.spanId, origin)
    return this
  }

  getTraceOrigin () {
    return this.nativeSpans.state.getTraceOrigin(this.segmentId)
  }

  setMetaStruct (key, bytes) {
    this.nativeSpans.state.setMetaStruct(this.spanIdBig, key, bytes)
    return this
  }

  getMetaStruct (key) {
    return this.nativeSpans.state.getMetaStruct(this.spanIdBig, key)
  }

  addSpanEvent (name, timeUnixNano, attributes = {}) {
    this.nativeSpans.state.addSpanEvent(
      this.spanIdBig,
      name,
      BigInt(timeUnixNano),
      encodeSpanEventAttrs(attributes),
    )
    return this
  }

  getSpanEvents () {
    return JSON.parse(this.nativeSpans.state.getSpanEventsJson(this.spanIdBig))
  }

  finish () {
    this.duration = BigInt(Date.now()) * 1_000_000n - this._startTime
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
  duration: ['getDuration', 'SetDuration', 'i64'],
}

for (const [prop, [getter, setter, valueType]] of Object.entries(spanAccessors)) {
  Object.defineProperty(Span.prototype, prop, {
    get () {
      return this.nativeSpans.state[getter](this.spanIdBig)
    },
    set (val) {
      val = valueType ? [valueType, val] : val
      this.nativeSpans.queueOp(OpCode[setter], this.spanId, val)
    },
  })
}

const CHANGE_QUEUE_SIZE = 64 * 1024
const STRING_TABLE_INPUT_SIZE = 10 * 1024

class NativeSpansInterface {
  constructor (options = {}) {
    this.flushBuffer = Buffer.alloc(10 * 1024)

    this.cqbIndex = 8 // Start at 8 since first u64 is count
    this.cqbCount = 0
    this.stibCount = 0
    this.segmentCount = 0 // Monotonic segment_id allocator
    this.segmentByTrace = new Map() // trace key -> segment_id (BigInt)
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
      options.tracerService || 'test-service',
      options.statsEnabled ?? false,
      options.hostname || 'test-host',
      options.env || 'test-env',
      options.appVersion || '1.0.0',
      options.runtimeId || '00000000-0000-0000-0000-000000000000',
      options.clientComputedStats ?? false,
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

  // Any Rust call can trigger a WASM memory.grow(), which detaches the
  // JS-side ArrayBuffer. Callers must invoke this before every read/write to
  // the shared buffers when a Rust call may have happened since the last check.
  _ensureViews () {
    if (this._wasmMemory.buffer !== this._cqbView.buffer) {
      this._refreshViews()
    }
  }

  resetChangeQueue () {
    this.cqbIndex = 8
    this.cqbCount = 0
    this._ensureViews()
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

  // Allocate (or reuse) a segment_id for a given trace. Spans sharing a trace
  // share a segment so trace-level attributes are visible across them.
  allocSegment (traceId) {
    const key = traceId.map(b => Buffer.from(b).toString('hex')).join('')
    let id = this.segmentByTrace.get(key)
    if (id === undefined) {
      id = BigInt(this.segmentCount++)
      this.segmentByTrace.set(key, id)
    }
    return id
  }

  queueOp (op, spanId, ...args) {
    this._ensureViews()

    // Check if Rust flushed the queue (wrote 0 to count position)
    if (this._cqbView.getUint32(0, true) === 0 && this.cqbCount > 0) {
      this.cqbIndex = 8
      this.cqbCount = 0
    }

    // Op header: opcode (u16 LE) + span_id (u64 LE) = 10 bytes. Rust reads the
    // opcode as a u16, then the span_id as a u64.
    this._cqbView.setUint16(this.cqbIndex, op, true)
    this.cqbIndex += 2
    this._writeBytesLE(spanId, this.cqbIndex)
    this.cqbIndex += 8

    for (const arg of args) {
      if (typeof arg === 'string') {
        // getStringId may call into Rust (stringTableInsertOne), which can
        // grow WASM memory and detach our views. Re-check after the call.
        const stringId = this.getStringId(arg)
        this._ensureViews()
        this._cqbView.setUint32(this.cqbIndex, stringId, true)
        this.cqbIndex += 4
      } else {
        const [typ, num] = arg
        switch (typ) {
          case 'u64': {
            this._writeBytesLE(num, this.cqbIndex)
            this.cqbIndex += 8
            break
          }
          case 'u64n': {
            this._cqbView.setBigUint64(this.cqbIndex, BigInt(num), true)
            this.cqbIndex += 8
            break
          }
          case 'u32n': { // raw, pre-resolved string-table id
            this._cqbView.setUint32(this.cqbIndex, num, true)
            this.cqbIndex += 4
            break
          }
          case 'u128': {
            this._writeBytesLE(num[0], this.cqbIndex)
            this.cqbIndex += 8
            this._writeBytesLE(num[1], this.cqbIndex)
            this.cqbIndex += 8
            break
          }
          case 'i64': {
            this._cqbView.setBigInt64(this.cqbIndex, num, true)
            this.cqbIndex += 8
            break
          }
          case 'i32': {
            this._cqbView.setInt32(this.cqbIndex, num, true)
            this.cqbIndex += 4
            break
          }
          case 'f64': {
            this._cqbView.setFloat64(this.cqbIndex, num, true)
            this.cqbIndex += 8
            break
          }
          default: {
            throw new Error('unsupported number type: ' + typ)
          }
        }
      }
    }

    this.cqbCount++
    this._cqbView.setBigUint64(0, BigInt(this.cqbCount), true)
  }

  createSpan (traceId, parentId) {
    return new Span(this, traceId, parentId)
  }

  async flushSpans (...spans) {
    this.flushBuffer.fill(0) // TODO is this necessary, since we're sending the length?
    let index = 0
    for (const span of spans) {
      // The chunk buffer carries u64 span IDs (8 bytes LE each).
      const spanId = span.spanId ?? span
      for (let i = 0; i < 8; i++) {
        this.flushBuffer[index + i] = spanId[7 - i]
      }
      index += 8
    }
    const hasSpans = this.state.prepareChunk(spans.length, true, this.flushBuffer)
    if (!hasSpans) return false
    return this.state.sendPreparedChunk()
  }
}

// Build the flat span-event attribute buffer consumed by the Rust decoder
// (`decode_span_event_attributes` in crates/pipeline/src/lib.rs). This mirrors
// what dd-trace-js's `addSpanEvent` wrapper produces. Tags: String=0,
// Boolean=1, Integer=2, Double=3, Array=4 (matching libdatadog's
// AttributeArrayValue discriminants).
function encodeSpanEventAttrs (attributes) {
  const enc = new TextEncoder()
  const chunks = []
  const u32 = (n) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(n >>> 0, 0)
    return b
  }
  const i64 = (n) => {
    const b = Buffer.alloc(8)
    b.writeBigInt64LE(BigInt(n), 0)
    return b
  }
  const f64 = (n) => {
    const b = Buffer.alloc(8)
    b.writeDoubleLE(n, 0)
    return b
  }
  const str = (s) => {
    const sb = Buffer.from(enc.encode(s))
    return Buffer.concat([u32(sb.length), sb])
  }
  // Returns `[tag][value]` — used both for single values and array items.
  const scalar = (v) => {
    if (typeof v === 'string') return Buffer.concat([Buffer.from([0]), str(v)])
    if (typeof v === 'boolean') return Buffer.concat([Buffer.from([1]), Buffer.from([v ? 1 : 0])])
    if (typeof v === 'number') {
      return Number.isInteger(v)
        ? Buffer.concat([Buffer.from([2]), i64(v)])
        : Buffer.concat([Buffer.from([3]), f64(v)])
    }
    throw new TypeError(`unsupported span-event attribute value: ${typeof v}`)
  }
  for (const [key, value] of Object.entries(attributes)) {
    chunks.push(str(key))
    if (Array.isArray(value)) {
      chunks.push(Buffer.from([4]), u32(value.length))
      for (const item of value) chunks.push(scalar(item))
    } else {
      chunks.push(scalar(value))
    }
  }
  return new Uint8Array(Buffer.concat(chunks))
}

// Read just the length of the outer msgpack array (the v0.4 trace payload is an
// array of trace chunks). Enough to assert how many separate traces were sent.
function msgpackOuterArrayLen (buf) {
  const b = buf[0]
  if (b >= 0x90 && b <= 0x9F) return b & 0x0F // fixarray
  if (b === 0xDC) return buf.readUInt16BE(1) // array16
  if (b === 0xDD) return buf.readUInt32BE(1) // array32
  throw new Error('payload is not a msgpack array: 0x' + b.toString(16))
}

describe('pipeline', { skip }, () => {
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
        'SetTraceOrigin',
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
      span.setTag('custom.metric', 3.141_59)

      assert.strictEqual(span.getTag('http.status_code'), 200)
      assert.strictEqual(span.getTag('custom.metric'), 3.141_59)
    })

    it('should set and get error state', () => {
      const span = nativeSpans.createSpan()
      span.error = 0
      assert.strictEqual(span.error, 0)

      span.error = 1
      assert.strictEqual(span.error, 1)
    })
  })

  describe('meta_struct', () => {
    it('round-trips raw bytes by key', () => {
      const span = nativeSpans.createSpan()
      const value = new Uint8Array([0x82, 0xA1, 0x61, 0x01, 0xA1, 0x62, 0x02])
      span.setMetaStruct('appsec', value)

      assert.deepStrictEqual(span.getMetaStruct('appsec'), value)
    })

    it('returns null for an unset meta_struct key', () => {
      const span = nativeSpans.createSpan()
      assert.strictEqual(span.getMetaStruct('missing'), null)
    })

    it('overwrites an existing key on repeated set', () => {
      const span = nativeSpans.createSpan()
      span.setMetaStruct('k', new Uint8Array([1, 2, 3]))
      span.setMetaStruct('k', new Uint8Array([9]))

      assert.deepStrictEqual(span.getMetaStruct('k'), new Uint8Array([9]))
    })
  })

  describe('span_events', () => {
    it('appends an event with no attributes', () => {
      const span = nativeSpans.createSpan()
      span.addSpanEvent('exception', 1_727_211_691_770_716_000n)

      const events = span.getSpanEvents()
      assert.strictEqual(events.length, 1)
      assert.strictEqual(events[0].name, 'exception')
      assert.strictEqual(events[0].time_unix_nano, 1_727_211_691_770_716_000)
      // Empty attributes are skipped by libdatadog's serializer.
      assert.strictEqual(events[0].attributes, undefined)
    })

    it('round-trips scalar attributes of every type with correct type tags', () => {
      const span = nativeSpans.createSpan()
      span.addSpanEvent('evt', 1000n, {
        s: 'hello',
        b: true,
        i: 42,
        d: 3.5,
      })

      const [event] = span.getSpanEvents()
      assert.strictEqual(event.name, 'evt')
      assert.strictEqual(event.time_unix_nano, 1000)
      // type tags: String=0, Boolean=1, Integer=2, Double=3
      assert.deepStrictEqual(event.attributes.s, { type: 0, string_value: 'hello' })
      assert.deepStrictEqual(event.attributes.b, { type: 1, bool_value: true })
      assert.deepStrictEqual(event.attributes.i, { type: 2, int_value: 42 })
      assert.deepStrictEqual(event.attributes.d, { type: 3, double_value: 3.5 })
    })

    it('round-trips an array attribute (type 4) with typed items', () => {
      const span = nativeSpans.createSpan()
      span.addSpanEvent('evt', 1n, { tags: ['a', 'b'], nums: [1, 2, 3] })

      const [event] = span.getSpanEvents()
      assert.deepStrictEqual(event.attributes.tags, {
        type: 4,
        array_value: { values: [{ type: 0, string_value: 'a' }, { type: 0, string_value: 'b' }] },
      })
      assert.deepStrictEqual(event.attributes.nums, {
        type: 4,
        array_value: { values: [{ type: 2, int_value: 1 }, { type: 2, int_value: 2 }, { type: 2, int_value: 3 }] },
      })
    })

    it('appends multiple events in order', () => {
      const span = nativeSpans.createSpan()
      span.addSpanEvent('first', 1n)
      span.addSpanEvent('second', 2n, { k: 'v' })

      const events = span.getSpanEvents()
      assert.strictEqual(events.length, 2)
      assert.strictEqual(events[0].name, 'first')
      assert.strictEqual(events[1].name, 'second')
      assert.deepStrictEqual(events[1].attributes.k, { type: 0, string_value: 'v' })
    })

    it('returns an empty array for a span with no events', () => {
      const span = nativeSpans.createSpan()
      assert.deepStrictEqual(span.getSpanEvents(), [])
    })

    it('rejects a truncated attribute buffer instead of panicking', () => {
      const span = nativeSpans.createSpan()
      // key_len=5 but no key bytes follow → bounded read must error.
      const bad = new Uint8Array([5, 0, 0, 0])
      assert.throws(
        () => span.nativeSpans.state.addSpanEvent(span.spanIdBig, 'evt', 1n, bad),
        /truncated span-event attribute buffer/,
      )
    })

    it('rejects an overflowing key_len without trapping (wasm32 usize)', () => {
      const span = nativeSpans.createSpan()
      // key_len = 0xFFFFFFFF: on wasm32 `idx + key_len` would wrap and slip
      // past the bound, trapping on the slice. The remaining-byte form must
      // reject it as a truncated buffer instead.
      const bad = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00])
      assert.throws(
        () => span.nativeSpans.state.addSpanEvent(span.spanIdBig, 'evt', 1n, bad),
        /truncated span-event attribute buffer/,
      )
    })
  })

  describe('span timing', () => {
    it('should set and get start time', () => {
      const span = nativeSpans.createSpan()
      assert(span.start > 0n) // populated from the constructor's SetStart (BigInt ns)

      // Verify an exact round-trip. getStart returns an f64, so real ns
      // timestamps (> 2^53) can't be checked to the nanosecond; use a small,
      // exactly-representable value so an off-by-one would actually be caught.
      nativeSpans.queueOp(OpCode.SetStart, span.spanId, ['i64', 12_345n])
      assert.strictEqual(span.start, 12_345n)
    })

    it('should set and get duration', () => {
      const duration = 1_000_000n
      const span = nativeSpans.createSpan()
      span.duration = duration
      // getDuration returns i64 nanoseconds as a BigInt (no f64 truncation).
      assert.strictEqual(span.duration, duration)
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

    it('should isolate trace attributes across different traces', () => {
      const a = nativeSpans.createSpan()
      a.setTraceTag('iso_key', 'a_value')
      a.setTraceOrigin('origin-a')

      // A span in a DIFFERENT trace must not see trace a's segment data.
      const b = nativeSpans.createSpan()
      assert.notStrictEqual(a.segmentId, b.segmentId)
      assert.strictEqual(b.getTraceTag('iso_key'), null)
      assert.strictEqual(b.getTraceOrigin(), null)
    })
  })

  describe('absent values and error handling', () => {
    it('returns null for tags that were never set', () => {
      const span = nativeSpans.createSpan()
      assert.strictEqual(nativeSpans.state.getMetaAttr(span.spanIdBig, 'never-set'), null)
      assert.strictEqual(nativeSpans.state.getMetricAttr(span.spanIdBig, 'never-set'), null)
      assert.strictEqual(span.getTag('never-set'), null)
    })

    it('throws when reading an unknown span id', () => {
      // Convention: span-level getters throw on an unknown span_id, while
      // trace-level getters return null for an unknown segment. All span
      // getters share the get_span error path, so assert each one throws.
      const bogus = 0xDE_AD_BE_EFn
      for (const getter of [
        'getName', 'getServiceName', 'getResourceName',
        'getType', 'getError', 'getStart', 'getDuration',
      ]) {
        assert.throws(() => nativeSpans.state[getter](bogus), `${getter} should throw`)
      }
    })
  })

  describe('default meta', () => {
    it('applies default meta to new spans and validates inputs', () => {
      // Fresh interface so the default doesn't leak into the shared instance.
      const ns = new NativeSpansInterface()
      ns.state.setDefaultMeta(['dk', 'dv'])
      const span = ns.createSpan()
      assert.strictEqual(span.getTag('dk'), 'dv')

      // Non-string key or value must throw.
      assert.throws(() => ns.state.setDefaultMeta(['k', 123]))
      assert.throws(() => ns.state.setDefaultMeta([123, 'v']))
      // A trailing unpaired key is ignored, not an error.
      assert.doesNotThrow(() => ns.state.setDefaultMeta(['lonely']))
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
      assert.strictEqual(typeof keyId, 'number', 'key was interned in the string table')
      nativeSpans.state.stringTableEvict(keyId)

      // Evicting the key from the string table must not affect spans that have
      // already resolved it: the tag was materialized onto the span at flush
      // time, so the span keeps its own copy of the value.
      assert.strictEqual(span.getTag(testKey), testVal)
    })

    it('bulk-inserts strings via stringTableInsertMany', () => {
      // Wire format per entry: [key:u32 LE][cstr bytes][NUL]. Two entries
      // exercise the NUL-terminator advance (a missing +1 would misparse the
      // second entry).
      const ptr = nativeSpans.state.string_table_input_ptr()
      const view = new DataView(wasmMemory.buffer, ptr)
      const bytes = new Uint8Array(wasmMemory.buffer, ptr)
      const entries = [[60_001, 'bulk-key'], [60_002, 'bulk-val']]
      let off = 0
      for (const [key, str] of entries) {
        view.setUint32(off, key, true)
        off += 4
        for (let i = 0; i < str.length; i++) bytes[off++] = str.codePointAt(i)
        bytes[off++] = 0
      }
      nativeSpans.state.stringTableInsertMany(entries.length)

      // Reference the pre-inserted ids directly (raw u32, not via getStringId)
      // in a SetMetaAttr op; at flush they must resolve to the bulk strings.
      const span = nativeSpans.createSpan()
      nativeSpans.queueOp(OpCode.SetMetaAttr, span.spanId, ['u32n', 60_001], ['u32n', 60_002])
      assert.strictEqual(span.getTag('bulk-key'), 'bulk-val')
    })

    it('rejects a malformed (non-terminated) stringTableInsertMany entry', () => {
      const ptr = nativeSpans.state.string_table_input_ptr()
      const len = nativeSpans.state.string_table_input_len()
      const view = new DataView(wasmMemory.buffer, ptr)
      const bytes = new Uint8Array(wasmMemory.buffer, ptr, len)
      bytes.fill(0xFF) // no NUL terminator anywhere in the buffer
      view.setUint32(0, 70_001, true)
      // from_bytes_until_nul finds no terminator -> error surfaced as a throw,
      // not an out-of-bounds read.
      assert.throws(() => nativeSpans.state.stringTableInsertMany(1))
    })

    it('rejects a stringTableInsertMany count larger than the buffer holds', () => {
      const ptr = nativeSpans.state.string_table_input_ptr()
      const len = nativeSpans.state.string_table_input_len()
      const view = new DataView(wasmMemory.buffer, ptr)
      const bytes = new Uint8Array(wasmMemory.buffer, ptr, len)
      bytes.fill(0)
      // One valid entry consuming almost the whole buffer, so claiming a count
      // of 2 makes the second u32 key read run past the end -> bounded error,
      // not an out-of-bounds panic.
      view.setUint32(0, 71_000, true)
      for (let i = 4; i < len - 1; i++) bytes[i] = 0x61 // 'a'
      bytes[len - 1] = 0 // NUL terminator at the very end
      assert.throws(() => nativeSpans.state.stringTableInsertMany(2), /exceeds the entries/)
    })
  })

  describe('input validation', () => {
    it('throws when prepareChunk len exceeds the chunk size', () => {
      // 100 span ids would need 800 bytes; the chunk only has 8.
      assert.throws(() => nativeSpans.state.prepareChunk(100, true, Buffer.alloc(8)))
    })

    it('flushSpans with no spans is a no-op returning false', async () => {
      assert.strictEqual(await nativeSpans.flushSpans(), false)
    })

    it('rejects malformed and empty encoded trace payloads', async () => {
      await assert.rejects(nativeSpans.state.sendEncodedTraces(Buffer.alloc(0)), /sendEncodedTraces/)
      await assert.rejects(nativeSpans.state.sendEncodedTraces(Buffer.from([0x80])), /sendEncodedTraces/)
      await assert.rejects(nativeSpans.state.sendEncodedTraces(Buffer.from([0xDC, 0])), /MessagePack array32/)
      await assert.rejects(nativeSpans.state.sendEncodedTraces(Buffer.from([0xDD, 0, 0, 0])), /incomplete MessagePack/)
      await assert.rejects(
        nativeSpans.state.sendEncodedTraces(Buffer.from([0xDD, 0, 0, 0, 0])),
        /no encoded traces to send/,
      )
    })
  })

  describe('flush to agent', () => {
    it('sends multiple encoded trace chunks without dropping structured fields', async () => {
      const http = require('node:http')
      const payloads = []
      const server = http.createServer((req, res) => {
        const chunks = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('end', () => {
          payloads.push({ url: req.url, body: Buffer.concat(chunks) })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const ns = new NativeSpansInterface({ agentUrl: `http://127.0.0.1:${port}` })
      const payload = Buffer.concat([
        Buffer.from([0xDD, 0, 0, 0, 2]),
        ENCODED_TRACE_PAYLOAD.subarray(5),
        ENCODED_TRACE_PAYLOAD.subarray(5),
      ])

      try {
        assert.ok(await ns.state.sendEncodedTraces(payload))
        const post = payloads.find(payload => payload.url.includes('/v0.4/traces'))
        assert.ok(post)
        assert.deepStrictEqual(post.body, payload)
        assert.strictEqual(msgpackOuterArrayLen(post.body), 2)
        assert.ok(post.body.includes(Buffer.from('encoded-name')))
        assert.ok(post.body.includes(Buffer.from('encoded-value')))
        assert.ok(post.body.includes(Buffer.from('encoded-struct')))
        assert.ok(post.body.includes(Buffer.from('encoded-event')))
        assert.ok(post.body.includes(Buffer.from('encoded-attribute')))
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    })

    it('should flush spans to a (mock) agent', async () => {
      // Stand up a throwaway HTTP server acting as the agent so the flush path
      // (prepareChunk -> build exporter -> serialize -> send) is exercised
      // end-to-end in CI, instead of being skipped when no agent is present.
      const http = require('node:http')
      const payloads = []
      const server = http.createServer((req, res) => {
        const chunks = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => {
          payloads.push(Buffer.concat(chunks))
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()

      const ns = new NativeSpansInterface({ agentUrl: `http://127.0.0.1:${port}` })
      const span = ns.createSpan()
      span.name = 'flush-test-span'
      span.service = 'test-service'
      span.resource = 'test-resource'
      span.type = 'web'
      span.duration = 1_000_000n

      try {
        const result = await ns.flushSpans(span)
        assert(result, 'exporter returned an agent response')
        assert(payloads.length > 0, 'agent received a trace payload')
        assert(payloads[0].length > 0, 'trace payload is non-empty')
        // process_span stamps the `language` meta at flush. For the Node tracer
        // it must be "javascript" (matching the JS pipeline), NOT the `nodejs`
        // header/tracer-lang. The v0.4 span payload has no other nodejs/javascript
        // string, so a byte check unambiguously distinguishes the two.
        assert(payloads[0].includes(Buffer.from('javascript')), 'span meta carries language=javascript')
        assert(!payloads[0].includes(Buffer.from('nodejs')), 'span meta must not carry language=nodejs')
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    })

    it('accumulates one chunk per trace into a single multi-trace request', async () => {
      // prepareChunk stages one chunk per call; a single sendPreparedChunk sends
      // them all as one request. Before accumulation, a second prepareChunk
      // overwrote the first, so only one trace shipped per request. Here two
      // spans in two DISTINCT traces must arrive as two separate trace chunks.
      const http = require('node:http')
      const payloads = []
      const server = http.createServer((req, res) => {
        const chunks = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => {
          payloads.push({ url: req.url, body: Buffer.concat(chunks) })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const ns = new NativeSpansInterface({ agentUrl: `http://127.0.0.1:${port}` })

      const mk = (name) => {
        const s = ns.createSpan() // distinct random trace id per span
        s.name = name
        s.service = 'svc'
        s.resource = 'res'
        s.type = 'web'
        s.duration = 1_000_000n
        return s
      }
      const a = mk('trace-a')
      const b = mk('trace-b')

      // Prepare one chunk per trace (span id written LE), then send once.
      const prepareOne = (span) => {
        const buf = Buffer.alloc(8)
        for (let i = 0; i < 8; i++) buf[i] = span.spanId[7 - i]
        return ns.state.prepareChunk(1, true, buf)
      }

      try {
        assert.strictEqual(prepareOne(a), true, 'first chunk staged')
        assert.strictEqual(prepareOne(b), true, 'second chunk staged')
        const result = await ns.state.sendPreparedChunk()
        assert(result, 'agent responded')
        const post = payloads.find(p => p.url.includes('/v0.4/traces'))
        assert.ok(post, 'received a v0.4 POST')
        assert.strictEqual(
          msgpackOuterArrayLen(post.body), 2,
          'payload carries two separate trace chunks, not one lumped chunk',
        )
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    })
  })

  describe('v0.5 output format', () => {
    // Spin up a mock agent that records the request path, so we can assert the
    // exporter targets /v0.4/traces by default and /v0.5/traces after
    // setUseV05(true). (v0.5 itself drops meta_struct/span_events by design;
    // here we only verify endpoint routing, which is the observable behavior.)
    async function flushAndCapturePath (useV05) {
      const http = require('node:http')
      const seen = []
      const server = http.createServer((req, res) => {
        req.on('data', () => {})
        req.on('end', () => {
          seen.push({ method: req.method, url: req.url })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const ns = new NativeSpansInterface({ agentUrl: `http://127.0.0.1:${port}` })
      if (useV05) ns.state.setUseV05(true)
      try {
        await ns.state.sendEncodedTraces(ENCODED_TRACE_PAYLOAD)
        return seen.find(r => r.method === 'POST')
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    }

    it('targets /v0.4/traces by default', async () => {
      const req = await flushAndCapturePath(false)
      assert.ok(req, 'agent received a POST')
      assert.strictEqual(req.url, '/v0.4/traces')
    })

    it('targets /v0.5/traces after setUseV05(true)', async () => {
      const req = await flushAndCapturePath(true)
      assert.ok(req, 'agent received a POST')
      assert.strictEqual(req.url, '/v0.5/traces')
    })

    it('exports via OTLP HTTP after setOtlpEndpoint(url)', async () => {
      // libdatadog maps its internal traces to OTLP and POSTs them to the
      // configured endpoint instead of the Datadog agent. Confirms the OTLP
      // path runs end-to-end over the wasm HTTP transport.
      const http = require('node:http')
      const seen = []
      const server = http.createServer((req, res) => {
        const chunks = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => {
          seen.push({
            method: req.method,
            url: req.url,
            ct: req.headers['content-type'],
            len: Buffer.concat(chunks).length,
            body: Buffer.concat(chunks).toString(),
          })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const ns = new NativeSpansInterface({
        agentUrl: `http://127.0.0.1:${port}`,
        tracerVersion: '7.0.0-pre',
      })
      ns.state.setOtlpEndpoint(`http://127.0.0.1:${port}/v1/traces`)
      try {
        await ns.state.sendEncodedTraces(ENCODED_TRACE_PAYLOAD)
        const req = seen.find(r => r.method === 'POST')
        assert.ok(req, 'OTLP endpoint received a POST')
        assert.strictEqual(req.url, '/v1/traces')
        // No setOtlpProtocol call — pins the default wire protocol (http/json).
        assert.match(req.ct || '', /json/)
        assert.ok(req.len > 0, 'OTLP body is non-empty')
        const body = JSON.parse(req.body)
        assert.strictEqual(body.resourceSpans[0].scopeSpans[0].scope.name, 'dd-trace-js')
        assert.strictEqual(body.resourceSpans[0].scopeSpans[0].scope.version, '7.0.0-pre')
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    })

    it('honors setOtlpProtocol(http/protobuf) and setOtlpHeaders', async () => {
      const http = require('node:http')
      let captured
      const server = http.createServer((req, res) => {
        req.on('data', () => {})
        req.on('end', () => {
          if (req.method === 'POST') {
            captured = {
              ct: req.headers['content-type'],
              auth: req.headers.authorization,
              custom: req.headers['x-custom'],
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const ns = new NativeSpansInterface({ agentUrl: `http://127.0.0.1:${port}` })
      ns.state.setOtlpEndpoint(`http://127.0.0.1:${port}/v1/traces`)
      ns.state.setOtlpProtocol('http/protobuf')
      // Two header pairs plus a trailing unpaired element (odd length): both
      // pairs are applied and the stray 'ignored-no-pair' is dropped.
      ns.state.setOtlpHeaders(['authorization', 'Bearer test-token', 'x-custom', 'cval', 'ignored-no-pair'])
      try {
        await ns.state.sendEncodedTraces(ENCODED_TRACE_PAYLOAD)
        assert.ok(captured, 'OTLP endpoint received a POST')
        assert.match(captured.ct || '', /protobuf/)
        assert.strictEqual(captured.auth, 'Bearer test-token')
        assert.strictEqual(captured.custom, 'cval')
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    })

    it('rejects unsupported OTLP protocols (e.g. grpc)', () => {
      const ns = new NativeSpansInterface({ agentUrl: 'http://127.0.0.1:8126' })
      assert.throws(() => ns.state.setOtlpProtocol('grpc'), /setOtlpProtocol|not supported/)
    })
  })

  describe('agentless output', () => {
    it('formats and obfuscates through libdatadog before direct intake', async () => {
      const http = require('node:http')
      let captured
      const server = http.createServer((req, res) => {
        const chunks = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('end', () => {
          captured = {
            apiKey: req.headers['dd-api-key'],
            body: Buffer.concat(chunks),
            contentType: req.headers['content-type'],
            method: req.method,
            url: req.url,
          }
          res.writeHead(200)
          res.end()
        })
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const previousRules = process.env.DD_APM_REPLACE_TAGS
      const nativeSpans = new NativeSpansInterface({ agentUrl: 'http://127.0.0.1:1' })

      try {
        process.env.DD_APM_REPLACE_TAGS = JSON.stringify([{
          name: 'encoded.meta',
          pattern: 'encoded-value',
          repl: '?',
        }])
        nativeSpans.state.setAgentlessEndpoint(`http://127.0.0.1:${port}/v1/input`, 'test-api-key')
        restoreEnv('DD_APM_REPLACE_TAGS', previousRules)

        await nativeSpans.state.sendEncodedTraces(ENCODED_TRACE_PAYLOAD)

        assert.ok(captured, 'direct intake received a POST')
        assert.strictEqual(captured.body.includes(Buffer.from('encoded-value')), false)
        assert.strictEqual(captured.method, 'POST')
        assert.strictEqual(captured.url, '/v1/input')
        assert.strictEqual(captured.apiKey, 'test-api-key')
        assert.match(captured.contentType ?? '', /json/)
        const payload = JSON.parse(captured.body)
        const span = payload.traces[0].spans[0]
        assert.strictEqual(span.start, 1_700_000_000)
        assert.strictEqual(span.meta['encoded.meta'], '?')
        assert.deepStrictEqual(span.meta_struct.appsec, {
          blocked: true,
          value: 'encoded-struct',
        })

        const oldStartPayload = Buffer.from(ENCODED_TRACE_PAYLOAD)
        const startMarker = Buffer.from('a57374617274cf', 'hex')
        const startMarkerOffset = oldStartPayload.indexOf(startMarker)
        assert.notStrictEqual(startMarkerOffset, -1)
        const startOffset = startMarkerOffset + startMarker.length
        oldStartPayload.writeBigUInt64BE(1_000_000_000n, startOffset)

        await nativeSpans.state.sendEncodedTraces(oldStartPayload)

        const normalized = JSON.parse(captured.body).traces[0].spans[0]
        assert.strictEqual(Number.isInteger(normalized.start), true)
        assert.ok(normalized.start >= 946_684_800)
      } finally {
        restoreEnv('DD_APM_REPLACE_TAGS', previousRules)
        server.closeAllConnections?.()
        await new Promise(resolve => server.close(resolve))
      }
    })

    it('rejects malformed replacement rules before export', () => {
      const previousRules = process.env.DD_APM_REPLACE_TAGS
      const nativeSpans = new NativeSpansInterface()

      try {
        process.env.DD_APM_REPLACE_TAGS = '[{"name":"tag","pattern":"[","repl":"?"}]'
        assert.throws(
          () => nativeSpans.state.setAgentlessEndpoint('http://127.0.0.1:1/v1/input', 'test-api-key'),
          /setAgentlessEndpoint/,
        )
      } finally {
        restoreEnv('DD_APM_REPLACE_TAGS', previousRules)
      }
    })

    it('rejects agentless and OTLP trace destinations together', async () => {
      const nativeSpans = new NativeSpansInterface()
      nativeSpans.state.setAgentlessEndpoint('http://127.0.0.1:1/v1/input', 'test-api-key')
      nativeSpans.state.setOtlpEndpoint('http://127.0.0.1:1/v1/traces')

      await assert.rejects(
        nativeSpans.state.sendEncodedTraces(ENCODED_TRACE_PAYLOAD),
        /OTLP and agentless trace export cannot both be enabled/,
      )
    })
  })

  describe('client-computed-stats header', () => {
    async function captureTraceHeader (nsOptions) {
      const http = require('node:http')
      let header
      let sawTraces = false
      const server = http.createServer((req, res) => {
        req.on('data', () => {})
        req.on('end', () => {
          if (req.url === '/v0.4/traces') {
            sawTraces = true
            header = req.headers['datadog-client-computed-stats']
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const ns = new NativeSpansInterface({ agentUrl: `http://127.0.0.1:${port}`, ...nsOptions })
      const span = ns.createSpan()
      span.name = 'span'
      span.service = 'test-service'
      span.resource = 'test-resource'
      span.type = 'web'
      span.duration = 1_000_000n
      try {
        await ns.flushSpans(span)
        return { header, sawTraces }
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    }

    it('sends Datadog-Client-Computed-Stats: true when enabled', async () => {
      const { header, sawTraces } = await captureTraceHeader({ clientComputedStats: true })
      assert.ok(sawTraces, 'expected a POST to /v0.4/traces')
      assert.strictEqual(header, 'true')
    })

    it('omits the header when both flags are disabled', async () => {
      const { header, sawTraces } = await captureTraceHeader({ clientComputedStats: false, statsEnabled: false })
      assert.ok(sawTraces, 'expected a POST to /v0.4/traces')
      assert.strictEqual(header, undefined)
    })

    it('sends the header when stats are enabled (client-side stats imply it)', async () => {
      // Enabling client-side stats without clientComputedStats must still send
      // the header, otherwise the agent double-counts APM stats.
      const { header, sawTraces } = await captureTraceHeader({ statsEnabled: true, clientComputedStats: false })
      assert.ok(sawTraces, 'expected a POST to /v0.4/traces')
      assert.strictEqual(header, 'true')
    })
  })

  describe('client-side stats', () => {
    it('aggregates and flushes stats to /v0.6/stats', async () => {
      const http = require('node:http')
      const seen = []
      const server = http.createServer((req, res) => {
        const chunks = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => {
          seen.push({ method: req.method, url: req.url, len: Buffer.concat(chunks).length })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()

      // statsEnabled:true builds the StatsCollector; sendEncodedTraces feeds
      // decoded spans into it, and flushStats(true) force-flushes to /v0.6/stats.
      const ns = new NativeSpansInterface({ agentUrl: `http://127.0.0.1:${port}`, statsEnabled: true })

      try {
        await ns.state.sendEncodedTraces(ENCODED_TRACE_PAYLOAD)
        const result = await ns.state.flushStats(true)
        assert.deepStrictEqual(result, { sent: true, collapsedSpans: 0 }, 'flushStats reported a send')
        const statsReq = seen.find(r => r.url === '/v0.6/stats')
        assert.ok(statsReq, 'agent received a /v0.6/stats request')
        assert.strictEqual(statsReq.method, 'PUT')
        assert.ok(statsReq.len > 0, 'stats payload is non-empty')

        // Nothing new aggregated -> a second forced flush is a no-op.
        assert.deepStrictEqual(await ns.state.flushStats(true), { sent: false, collapsedSpans: 0 }, 'second flush has nothing to send')
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    })

    it('returns collapsed span count when stats cardinality overflows', async () => {
      const http = require('node:http')
      const seen = []
      const server = http.createServer((req, res) => {
        const chunks = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => {
          seen.push({ method: req.method, url: req.url, len: Buffer.concat(chunks).length })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()

      const ns = new NativeSpansInterface({ agentUrl: `http://127.0.0.1:${port}`, statsEnabled: true })
      let batch = []

      try {
        for (let i = 0; i < 7001; i++) {
          const span = ns.createSpan()
          span.name = 'stats-span'
          span.service = `stats-svc-${i}`
          span.resource = '/stats'
          span.type = 'web'
          span.setTag('span.kind', 'server')
          span.duration = 5_000_000n
          ns.flushChangeQueue()
          batch.push(span)
          if (batch.length === 500) {
            await ns.flushSpans(...batch)
            batch = []
          }
        }
        if (batch.length > 0) {
          await ns.flushSpans(...batch)
        }

        const result = await ns.state.flushStats(true)
        assert.strictEqual(result.sent, true)
        assert.strictEqual(result.collapsedSpans, 1, 'stats cardinality overflow reported the first collapsed span')
        assert.ok(seen.some(r => r.url === '/v0.6/stats'), 'agent received a /v0.6/stats request')
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    })

    it('flushStats reports no send when stats are disabled', async () => {
      const ns = new NativeSpansInterface({ statsEnabled: false })
      assert.deepStrictEqual(await ns.state.flushStats(true), { sent: false, collapsedSpans: 0 })
    })

    it('flushes stats to /v0.6/stats over a Unix domain socket', { skip: process.platform === 'win32' }, async () => {
      // A `unix://` agent URL must route /v0.6/stats over the socket, like
      // traces do. parse_uri hex-encodes the socket path into the URI authority
      // (which the transport's decode_socket_path reverses); a raw parse would
      // leave the path in the URI path and never reach the socket.
      const http = require('node:http')
      const os = require('node:os')
      const fs = require('node:fs')
      const nodePath = require('node:path')
      // Keep the path short — AF_UNIX paths are capped (~104 bytes on macOS).
      const sockPath = nodePath.join(os.tmpdir(), `dd-st-${process.pid}.sock`)
      try {
        fs.unlinkSync(sockPath)
      } catch {
        // not present
      }
      const seen = []
      const server = http.createServer((req, res) => {
        const chunks = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => {
          seen.push({ method: req.method, url: req.url, len: Buffer.concat(chunks).length })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(sockPath, resolve)
      })

      const ns = new NativeSpansInterface({ agentUrl: `unix://${sockPath}`, statsEnabled: true })
      const span = ns.createSpan()
      span.name = 'stats-span'
      span.service = 'stats-svc'
      span.resource = '/stats'
      span.type = 'web'
      span.duration = 5_000_000n

      try {
        await ns.flushSpans(span)
        const result = await ns.state.flushStats(true)
        assert.deepStrictEqual(
          result,
          { sent: true, collapsedSpans: 0 },
          'flushStats reported a send over the socket',
        )
        const statsReq = seen.find(r => r.url === '/v0.6/stats')
        assert.ok(statsReq, 'agent received a /v0.6/stats request over the socket')
        assert.ok(statsReq.len > 0, 'stats payload is non-empty')
      } finally {
        server.closeAllConnections?.()
        server.close()
        try {
          fs.unlinkSync(sockPath)
        } catch {
          // already gone
        }
      }
    })
  })

  describe('send re-entrancy', () => {
    it('rejects overlapping prepared and encoded sends', async () => {
      const http = require('node:http')
      const server = http.createServer((req, res) => {
        req.resume()
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const ns = new NativeSpansInterface({ agentUrl: `http://127.0.0.1:${port}` })
      const span = ns.createSpan()
      span.name = 'reentrancy'
      ns.flushBuffer.fill(0)
      for (let i = 0; i < 8; i++) ns.flushBuffer[i] = span.spanId[7 - i]
      assert.ok(ns.state.prepareChunk(1, true, ns.flushBuffer))

      try {
        // Two calls without awaiting the first: the in-flight guard must reject
        // the second instead of aliasing the exporter (UB).
        const settled = await Promise.allSettled([
          ns.state.sendPreparedChunk(),
          ns.state.sendPreparedChunk(),
        ])
        const reasons = settled
          .filter(s => s.status === 'rejected')
          .map(s => String(s.reason))
        assert.ok(
          reasons.some(r => /already in flight/.test(r)),
          'one overlapping call rejected as already-in-flight',
        )

        const encodedSettled = await Promise.allSettled([
          ns.state.sendEncodedTraces(ENCODED_TRACE_PAYLOAD),
          ns.state.sendEncodedTraces(ENCODED_TRACE_PAYLOAD),
        ])
        const encodedReasons = encodedSettled
          .filter(result => result.status === 'rejected')
          .map(result => String(result.reason))
        assert.ok(
          encodedReasons.some(reason => /already in flight/.test(reason)),
          'one overlapping encoded call rejected as already-in-flight',
        )
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    })
  })
})
