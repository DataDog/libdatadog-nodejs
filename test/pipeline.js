'use strict'

const { NativeSpanState, OpCode } = require('..').maybeLoad('pipeline')
const crypto = require('crypto')

const changeQueueBuffer = Buffer.alloc(10 * 1024)
changeQueueBuffer.write("soup")
let cqbIndex = 0
let cqbCount = 0
const stringTableInputBuffer = Buffer.alloc(10 * 1024)
let stibCount = 0
const stringMap = new Map()

const state = new NativeSpanState(
  process.env.AGENT_URL || 'http://127.0.0.1:8126',
  '500.0',
  'nodejs',
  process.version,
  'v8',
  changeQueueBuffer,
  stringTableInputBuffer
)

function flushChangeQueue() {
  const result = state.flushChangeQueue(cqbCount);
}

const flushBuffer = Buffer.alloc(10 * 1024)
async function flushSpans(...spans) {
  flushChangeQueue()
  let index = 0
  for (const span of spans) {
    flushBuffer.writeBigUint64LE(span.spanId, index)
    index += 8
  }
  const result = await state.flushChunk(spans.length, flushBuffer)
  console.log(result)
}

function getStringId(str) {
  let id = stringMap[str]
  if (typeof id === 'number') return id

  id = stibCount++
  stringMap[str] = id
  state.stringTableInsertOne(id, str)
  return id
}

function queueOp(op, spanId, ...args) {
  changeQueueBuffer.writeBigUInt64LE(BigInt(op), cqbIndex)
  cqbIndex += 8
  changeQueueBuffer.writeBigUInt64LE(spanId, cqbIndex)
  cqbIndex += 8

  args.forEach(arg => {
    if (typeof arg === 'string') {
      const stringId = getStringId(arg)
      changeQueueBuffer.writeUint32LE(stringId, cqbIndex)
      cqbIndex += 4
    } else {
      const [typ, num] = arg
      switch (typ) {
        case 'u64': {
          changeQueueBuffer.writeBigUInt64LE(num, cqbIndex)
          cqbIndex += 8
          break
        }
        case 'u128': {
          changeQueueBuffer.writeBigUInt64LE(num[0], cqbIndex)
          cqbIndex += 8
          changeQueueBuffer.writeBigUInt64LE(num[1], cqbIndex)
          cqbIndex += 8
          break
        }
        case 'i64': {
          changeQueueBuffer.writeBigInt64LE(num, cqbIndex)
          cqbIndex += 8
          break
        }
        case 'i32': {
          changeQueueBuffer.writeInt32LE(num, cqbIndex)
          cqbIndex += 4
          break
        }
        case 'f64': {
          changeQueueBuffer.writeDoubleLE(num, cqbIndex)
          cqbIndex += 8
          break
        }
        default: {
          throw new Error('unsupported number type: ' + typ)
        }
      }
    }
  })

  cqbCount++
}

class Span {
  constructor (traceId, parentId) {
    this.traceId = traceId || [getRandomBigInt(8), getRandomBigInt(8)]
    if (!parentId) {
      parentId = 0n
    }
    this.parentId = parentId || 0n
    this.spanId = getRandomBigInt(8)
    queueOp(OpCode.Create, this.spanId, ['u128', this.traceId], ['u64', this.parentId])
    this.start = BigInt(Date.now() * 1000)
    queueOp(OpCode.SetStart, this.spanId, ['i64', this.start])
  }

  finish () {
    queueOp(OpCode.SetDuration, this.spanId, ['i64', BigInt(Date.now()*1000) - this.start])
  }

  set service (val) {
    queueOp(OpCode.SetServiceName, this.spanId, val)
  }

  set resource (val) {
    queueOp(OpCode.SetResourceName, this.spanId, val)
  }

  set type (val) {
    queueOp(OpCode.SetType, this.spanId, val)
  }

  set error (val) {
    queueOp(OpCode.SetError, this.spanId, ['i32', val])
  }

  set name (val) {
    queueOp(OpCode.SetName, this.spanId, val)
  }

  setAttribute (k, v) {
    if (typeof v !== 'number') {
      queueOp(OpCode.SetMetaAttr, this.spanId, k, v)
    } else {
      queueOp(OpCode.SetMetricAttr, this.spanId, k, ['f64', v])
    }
  }
}

function getRandomBigInt(byteCount) {
  return BigInt('0x' + crypto.randomBytes(byteCount).toString('hex'))
}

function sleep(ms){
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const span1 = new Span()

span1.name = 'span 1'
span1.resource = 'my resource 1'
span1.service = 'my service'
span1.type = 'server'
span1.setAttribute('key1', 'val1')

sleep(50)

const span2 = new Span(span1.traceId, span1.spanId)

span2.name = 'span 2'
span2.resource = 'my resource 2'
span2.service = 'my service'
span2.type = 'server'
span2.error = 1
span2.setAttribute('key2', Math.PI)

sleep(50)

span2.finish()

sleep(50)

span1.finish()

flushSpans(span1, span2)
