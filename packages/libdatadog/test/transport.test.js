'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { test } = require('node:test')

const { createHostTransport } = require('../lib/agentless-transport')

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
    const result = transport.request({
      id: 1,
      url: `http://127.0.0.1:${port}`,
      method: 'POST',
      headers: [],
      body: Buffer.alloc(0),
    }).then(
      () => ({ status: 'resolved' }),
      error => ({ error, status: 'rejected' }),
    )

    await responseClosed
    const outcome = await result

    assert.strictEqual(outcome.status, 'rejected')
    assert.match(outcome.error.message, /response aborted|aborted/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('host transport cancels an active request', async () => {
  const transport = createHostTransport()
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
    const request = transport.request({
      id: 2,
      url: `http://127.0.0.1:${port}`,
      method: 'POST',
      headers: [],
      body: Buffer.alloc(0),
    })
    await received
    transport.cancelRequest(2)
    await assert.rejects(request, /request was cancelled/)
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
  const firstRequest = transport.request({
    id: 4,
    url: `http://127.0.0.1:${port}`,
    method: 'POST',
    headers: [],
    body: atLimitBody,
  })
  const firstRequestCanceled = assert.rejects(firstRequest, /request was cancelled/)

  try {
    await firstRequestReceived
    await assert.rejects(transport.request({
      id: 5,
      url: `http://127.0.0.1:${port}`,
      method: 'POST',
      headers: [],
      body: Buffer.alloc(1),
    }), /Maximum active agentless request buffer size reached/)

    transport.cancelRequest(4)
    await firstRequestCanceled

    const response = await transport.request({
      id: 6,
      url: `http://127.0.0.1:${port}`,
      method: 'POST',
      headers: [],
      body: atLimitBody,
    })
    assert.strictEqual(response.status, 200)

    const nextResponse = await transport.request({
      id: 7,
      url: `http://127.0.0.1:${port}`,
      method: 'POST',
      headers: [],
      body: Buffer.alloc(1),
    })
    assert.strictEqual(nextResponse.status, 200)
  } finally {
    transport.cancelRequest(4)
    await firstRequestCanceled
    await new Promise(resolve => server.close(resolve))
  }
})

test('host transport cancels a pending timer', async () => {
  const transport = createHostTransport()
  const sleep = transport.sleep(3, 60_000)

  transport.cancelSleep(3)

  await assert.rejects(sleep, /timer was cancelled/)
})
