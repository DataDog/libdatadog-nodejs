'use strict'

/** @typedef {{ name: string, value: string }} Header */
/** @typedef {{ id: number, url: string, method: string, headers: Header[], body: Uint8Array }} RequestPlan */
/** @typedef {{ status: number | undefined, body: Buffer }} Response */
/** @typedef {(error?: Error, response?: Response) => void} RequestCallback */
/** @typedef {import('../index').AgentlessTransportOptions} AgentlessTransportOptions */

const maxActiveBufferSize = 16 * 1024 * 1024
const discardedResponse = { status: 200, body: Buffer.alloc(0) }

let activeBufferSize = 0

/** @param {AgentlessTransportOptions} [options] */
function createHostTransport ({ agent } = {}) {
  const requests = new Map()
  const timers = new Map()

  /**
   * @param {RequestPlan} plan
   * @param {RequestCallback} done
   */
  function request ({ id, url, method, headers: headerList, body }, done) {
    const bodySize = body.byteLength
    if (activeBufferSize + bodySize > maxActiveBufferSize) {
      done(undefined, discardedResponse)
      return
    }

    const target = new URL(url)
    const client = target.protocol === 'https:' ? require('node:https') : require('node:http')
    const headers = Object.fromEntries(headerList.map(({ name, value }) => [name, value]))

    let settled = false
    /**
     * @param {Error | undefined} error
     * @param {Response} [response]
     * @param {boolean} [notify=true]
     */
    const finish = (error, response, notify = true) => {
      if (settled) return false
      settled = true
      requests.delete(id)
      activeBufferSize -= bodySize
      if (notify) done(error, response)
      return true
    }
    const outgoing = client.request(target, {
      agent: agent ?? false,
      headers: { ...headers, connection: 'close' },
      method,
    }, (response) => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.once('aborted', () => finish(new Error('response aborted')))
      response.once('error', finish)
      response.once('end', () => finish(undefined, {
        status: response.statusCode,
        body: Buffer.concat(chunks),
      }))
    })
    activeBufferSize += bodySize

    requests.set(id, {
      cancel: () => {
        if (finish(undefined, undefined, false)) outgoing.destroy()
      },
    })
    outgoing.once('error', finish)
    outgoing.end(body)
  }

  /** @param {number} id */
  function cancelRequest (id) {
    requests.get(id)?.cancel()
  }

  // TODO(libdd-capabilities): Make host-backed capability futures cancel their
  // underlying operation when dropped. Then the transport can remove timer IDs,
  // the timers map, and cancelSleep.
  /**
   * @param {number} id
   * @param {number} milliseconds
   * @param {() => void} done
   */
  function sleep (id, milliseconds, done) {
    const timeout = setTimeout(() => {
      timers.delete(id)
      done()
    }, milliseconds)
    timeout.unref?.()
    timers.set(id, {
      cancel: () => {
        clearTimeout(timeout)
        timers.delete(id)
      },
    })
  }

  /** @param {number} id */
  function cancelSleep (id) {
    timers.get(id)?.cancel()
  }

  return { request, cancelRequest, sleep, cancelSleep }
}

module.exports = { createHostTransport }
