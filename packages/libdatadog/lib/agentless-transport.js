'use strict'

const maxActiveBufferSize = 16 * 1024 * 1024

let activeBufferSize = 0

function createHostTransport () {
  const requests = new Map()
  const timers = new Map()

  function request ({ id, url, method, headers: headerList, body }) {
    const target = new URL(url)
    const client = target.protocol === 'https:' ? require('node:https') : require('node:http')
    const headers = Object.fromEntries(headerList.map(({ name, value }) => [name, value]))
    const bodySize = body.byteLength

    if (activeBufferSize + bodySize > maxActiveBufferSize) {
      return Promise.reject(new Error('Maximum active agentless request buffer size reached: payload is discarded.'))
    }

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        requests.delete(id)
        activeBufferSize -= bodySize
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
      activeBufferSize += bodySize

      requests.set(id, {
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
    requests.get(id)?.cancel()
  }

  // TODO(libdd-capabilities): Make host-backed capability futures cancel their
  // underlying operation when dropped. Then sleep can return a cancellable
  // operation directly, removing timer IDs, the timers map, and cancelSleep.
  function sleep (id, milliseconds) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        timers.delete(id)
        resolve()
      }, milliseconds)
      timeout.unref?.()
      timers.set(id, {
        cancel: () => {
          clearTimeout(timeout)
          timers.delete(id)
          reject(new Error('agentless timer was cancelled'))
        },
      })
    })
  }

  function cancelSleep (id) {
    timers.get(id)?.cancel()
  }

  return { request, cancelRequest, sleep, cancelSleep }
}

module.exports = { createHostTransport }
