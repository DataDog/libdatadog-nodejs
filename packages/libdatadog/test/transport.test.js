'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { test } = require('node:test')

const { createHostTransport } = require('../lib/agentless-transport')

/** @typedef {ReturnType<typeof createHostTransport>} HostTransport */
/** @typedef {Parameters<HostTransport['request']>[0]} RequestPlan */

/**
 * @param {HostTransport} transport
 * @param {RequestPlan} plan
 */
function sendRequest (transport, plan) {
  return new Promise((resolve, reject) => {
    const result = transport.request(plan, (error, response) => {
      if (error) {
        reject(error)
      } else {
        resolve(response)
      }
    })
    assert.strictEqual(result, undefined)
  })
}

test('host transport rejects when a response is aborted', async () => {
  const transport = createHostTransport()
  let resolveResponseClosed
  const responseClosed = new Promise((resolve) => {
    resolveResponseClosed = resolve
  })
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-length': 100 })
    response.write('partial')
    response.once('close', resolveResponseClosed)
    setImmediate(() => response.destroy())
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const result = assert.rejects(sendRequest(transport, {
      id: 1,
      url: `http://127.0.0.1:${port}`,
      method: 'POST',
      headers: [],
      body: Buffer.alloc(0),
    }), /response aborted|aborted/)

    await Promise.all([responseClosed, result])
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('host transport cancels an active request', async () => {
  const transport = createHostTransport()
  let completed = 0
  let resolveRequest
  const received = new Promise((resolve) => {
    resolveRequest = resolve
  })
  const server = http.createServer((request) => {
    request.resume()
    request.once('end', resolveRequest)
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const result = transport.request({
      id: 2,
      url: `http://127.0.0.1:${port}`,
      method: 'POST',
      headers: [],
      body: Buffer.alloc(0),
    }, () => completed++)
    assert.strictEqual(result, undefined)
    await received
    transport.cancelRequest(2)
    assert.strictEqual(completed, 0)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('host transport bounds active request buffers', async () => {
  const transport = createHostTransport()
  let requestCount = 0
  let resolveFirstRequest
  const firstRequestReceived = new Promise((resolve) => {
    resolveFirstRequest = resolve
  })
  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  const server = http.createServer((request, response) => {
    requestCount++
    if (requestCount === 1) {
      request.resume()
      resolveFirstRequest()
      return
    }
    request.once('end', () => response.end())
    request.resume()
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const atLimitBody = Buffer.alloc(16 * 1024 * 1024)
  const overLimitBody = Buffer.alloc(atLimitBody.length + 1)
  const firstRequest = transport.request({
    id: 4,
    url: `http://127.0.0.1:${port}`,
    method: 'POST',
    headers: [],
    body: atLimitBody,
  }, assert.fail)
  assert.strictEqual(firstRequest, undefined)

  try {
    await firstRequestReceived
    const discarded = await sendRequest(transport, {
      id: 5,
      url: `http://127.0.0.1:${port}`,
      method: 'POST',
      headers: [],
      body: Buffer.alloc(1),
    })
    assert.strictEqual(discarded.status, 200)
    assert.strictEqual(discarded.body.length, 0)

    transport.cancelRequest(4)

    const oversized = await sendRequest(transport, {
      id: 6,
      url: `http://127.0.0.1:${port}`,
      method: 'POST',
      headers: [],
      body: overLimitBody,
    })
    assert.strictEqual(oversized.status, 200)
    assert.strictEqual(oversized.body.length, 0)
    assert.strictEqual(requestCount, 1)

    const nextResponse = await sendRequest(transport, {
      id: 7,
      url: `http://127.0.0.1:${port}`,
      method: 'POST',
      headers: [],
      body: Buffer.alloc(1),
    })
    assert.strictEqual(nextResponse.status, 200)
    assert.strictEqual(requestCount, 2)
  } finally {
    transport.cancelRequest(4)
    await new Promise(resolve => server.close(resolve))
  }
})

test('host transport cancels a pending timer', () => {
  const transport = createHostTransport()
  let completed = 0
  const pendingSleep = transport.sleep(3, 60_000, () => completed++)
  assert.strictEqual(pendingSleep, undefined)

  transport.cancelSleep(3)

  assert.strictEqual(completed, 0)
})
