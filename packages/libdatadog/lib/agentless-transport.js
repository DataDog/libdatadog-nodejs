'use strict'

const { AsyncResource } = require('node:async_hooks')

function createHostTransport () {
  const asyncResources = new Map()
  const requests = new Map()
  const timers = new Map()
  let nextContextId = 1

  function runWithAsyncResource (type, callback) {
    const contextId = nextContextId
    nextContextId = nextContextId === 4_294_967_295 ? 1 : nextContextId + 1
    const resource = new AsyncResource(type, { requireManualDestroy: true })
    asyncResources.set(contextId, resource)

    let operation
    try {
      operation = resource.runInAsyncScope(callback, undefined, contextId)
    } catch (error) {
      destroyAsyncResource(contextId, resource)
      throw error
    }

    return Promise.resolve(operation).finally(() => {
      destroyAsyncResource(contextId, resource)
    })
  }

  function runInAsyncScope (contextId, callback, ...args) {
    const resource = asyncResources.get(contextId)
    return resource
      ? resource.runInAsyncScope(callback, undefined, ...args)
      : callback(...args)
  }

  function destroyAsyncResource (contextId, resource) {
    asyncResources.delete(contextId)
    resource.emitDestroy()
  }

  function request (args) {
    return runInAsyncScope(args.contextId, startRequest, args)
  }

  function startRequest ({ id, contextId, url, method, headers: headerList, body }) {
    const target = new URL(url)
    const client = target.protocol === 'https:' ? require('node:https') : require('node:http')
    const headers = Object.fromEntries(headerList.map(({ name, value }) => [name, value]))

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        requests.delete(id)
        callback(value)
      }
      const outgoing = client.request(target, {
        agent: false,
        headers: { ...headers, connection: 'close' },
        method,
      }, (response) => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.once('aborted', () => finish(reject, new Error('response aborted')))
        response.once('error', error => finish(reject, error))
        response.on('end', () => finish(resolve, {
          status: response.statusCode,
          body: Buffer.concat(chunks),
        }))
      })

      requests.set(id, {
        contextId,
        cancel: () => {
          const error = new Error('agentless request was cancelled')
          finish(reject, error)
          outgoing.destroy(error)
        },
      })
      outgoing.once('error', error => finish(reject, error))
      outgoing.end(body)
    })
  }

  function cancelRequest (id) {
    const request = requests.get(id)
    if (request) runInAsyncScope(request.contextId, request.cancel)
  }

  // TODO(libdd-capabilities): Make host-backed capability futures cancel their
  // underlying operation when dropped. Then sleep can return a cancellable
  // operation directly, removing timer IDs, the timers map, and cancelSleep.
  function sleep (id, milliseconds, contextId) {
    return runInAsyncScope(contextId, startSleep, id, milliseconds, contextId)
  }

  function startSleep (id, milliseconds, contextId) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        timers.delete(id)
        resolve()
      }, milliseconds)
      timeout.unref?.()
      timers.set(id, {
        contextId,
        cancel: () => {
          clearTimeout(timeout)
          timers.delete(id)
          reject(new Error('agentless timer was cancelled'))
        },
      })
    })
  }

  function cancelSleep (id) {
    const timer = timers.get(id)
    if (timer) runInAsyncScope(timer.contextId, timer.cancel)
  }

  return { request, cancelRequest, sleep, cancelSleep, runWithAsyncResource }
}

module.exports = { createHostTransport }
