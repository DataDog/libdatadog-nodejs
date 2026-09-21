'use strict'

const assert = require('node:assert')
const { existsSync, rmSync } = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { execSync, exec } = require('node:child_process')

let currentTest
let PORT
const MAX_BODY_SIZE = 10 * 1024 * 1024

execSync('yarn install', getExecOptions())

rmSync(path.join(__dirname, 'stdout.log'), { force: true })
rmSync(path.join(__dirname, 'stderr.log'), { force: true })

const timeout = setTimeout(() => {
  const stdoutLog = path.join(__dirname, 'stdout.log')
  const stderrLog = path.join(__dirname, 'stderr.log')
  if (existsSync(stdoutLog)) {
    execSync(`cat ${stdoutLog}`, getExecOptions())
  } else {
    console.error('stdout.log not found (crashtracker-receiver may not have started)')
  }
  if (existsSync(stderrLog)) {
    execSync(`cat ${stderrLog}`, getExecOptions())
  } else {
    console.error('stderr.log not found (crashtracker-receiver may not have started)')
  }

  throw new Error('No crash report received before timing out.')
}, 20_000)

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/telemetry/proxy/api/v2/apmtelemetry') {
    res.writeHead(404).end()
    return
  }

  const chunks = []
  let bodySize = 0
  let bodyTooLarge = false
  req.on('data', (chunk) => {
    if (bodyTooLarge) return

    bodySize += chunk.length
    if (bodySize > MAX_BODY_SIZE) {
      bodyTooLarge = true
      res.writeHead(413).end()
      return
    }

    chunks.push(chunk)
  })
  req.on('end', () => {
    if (bodyTooLarge) return

    let body
    try {
      body = JSON.parse(Buffer.concat(chunks, bodySize).toString())
    } catch {
      res.writeHead(400).end()
      return
    }

    const logPayload = body?.payload?.logs?.[0]
    if (!logPayload) {
      res.writeHead(400).end()
      return
    }

    // Only process crash reports (not pings)
    if (!logPayload.is_crash) {
      res.writeHead(200).end()
      return
    }

    if (!currentTest) {
      throw new Error('Received unexpected crash report with no active test.')
    }

    res.writeHead(200).end()

    const tags = logPayload.tags ? logPayload.tags.split(',') : []

    currentTest(logPayload, tags)
  })
})

server.listen(async () => {
  PORT = server.address().port

  await testReceiverValidation()
  await testSegfault()
  await testUnhandledError('uncaught-exception', 'app-uncaught-exception', {
    expectedType: 'TypeError',
    expectedMessage: 'something went wrong',
    expectedFrame: 'myFaultyFunction',
  })
  await testUnhandledError('uncaught-exception-cross-context', 'app-uncaught-exception-cross-context', {
    expectedType: 'TypeError',
    expectedMessage: 'cross-realm failure',
    expectedFrame: 'customerVmHandler',
  })
  await testUnhandledError('uncaught-exception-proxy-error', 'app-uncaught-exception-proxy-error', {
    expectedType: 'TypeError',
    expectedMessage: 'proxied failure',
    expectedFrame: 'customerProxyHandler',
  })
  await testUnhandledNonError('uncaught-exception-non-error', 'app-uncaught-exception-non-error', {
    expectedFallbackType: 'uncaughtException',
    expectedValue: 'a plain string error',
  })
  await testUnhandledError('unhandled-rejection', 'app-unhandled-rejection', {
    expectedType: 'Error',
    expectedMessage: 'async went wrong',
    expectedFrame: 'myAsyncFaultyFunction',
  })
  // Node wraps non-Error rejections in an Error with name 'UnhandledPromiseRejection'
  // before passing to uncaughtExceptionMonitor, so this hits the Error path.
  // However, this test case rejects with a plain string, so the wrapped Error object has useless
  // stack trace
  await testUnhandledError('unhandled-rejection-non-error', 'app-unhandled-rejection-non-error', {
    expectedType: 'UnhandledPromiseRejection',
    expectedMessage: 'a plain string rejection',
  })

  clearTimeout(timeout)
  server.close()
})

async function testReceiverValidation () {
  console.log('Running test: testReceiverValidation')

  const logPayload = { is_crash: false, padding: '' }
  const body = { payload: { logs: [logPayload] } }
  const baseBody = JSON.stringify(body)
  const paddingSize = MAX_BODY_SIZE - Buffer.byteLength(baseBody)
  logPayload.padding = 'x'.repeat(paddingSize)
  const validBodyText = JSON.stringify(body)
  const validBody = Buffer.from(validBodyText)
  assert.strictEqual(validBody.length, MAX_BODY_SIZE)
  const extraByte = Buffer.from('x')
  const oversizedBody = Buffer.concat([validBody, extraByte])

  const [validStatus, invalidStatus, missingPayloadStatus, oversizedStatus] = await Promise.all([
    sendReceiverRequest(validBody),
    sendReceiverRequest('not JSON'),
    sendReceiverRequest('{}'),
    sendReceiverRequest(oversizedBody),
  ])

  assert.strictEqual(validStatus, 200)
  assert.strictEqual(invalidStatus, 400)
  assert.strictEqual(missingPayloadStatus, 400)
  assert.strictEqual(oversizedStatus, 413)
}

/**
 * @param {string | Buffer} body
 * @returns {Promise<number>}
 */
function sendReceiverRequest (body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      port: PORT,
      method: 'POST',
      path: '/telemetry/proxy/api/v2/apmtelemetry',
      headers: { 'content-type': 'application/json' },
    }, (response) => {
      if (response.statusCode === undefined) {
        response.resume()
        reject(new Error('Receiver response did not include a status code'))
        return
      }

      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })

    request.once('error', reject)
    request.end(body)
  })
}

async function testSegfault () {
  console.log('Running test: testSegfault')

  const { logPayload, tags } = await runApp('app-seg-fault')
  const stackTrace = JSON.parse(logPayload.message).error.stack.frames
  const boomFrame = stackTrace.find(frame => frame.function?.toLowerCase().includes('segfaultify'))

  if (existsSync('/etc/alpine-release')) {
    console.log('[segfault] Received crash report. Skipping stack trace test since it is currently unsupported for Alpine.')
  } else {
    assert(boomFrame, '[segfault] Expected stack frame for crashing function not found.')
  }

  assert(tags.includes('profiler_serializing:1'), '[segfault] Expected profiler_serializing:1 tag not found.')
}

async function testUnhandledError (label, script, { expectedType, expectedMessage, expectedFrame }) {
  console.log('Running test: testUnhandledError', label)

  const { logPayload } = await runApp(script)
  const crashReport = JSON.parse(logPayload.message)

  assert(crashReport.error.message.includes(expectedType), `[${label}] Expected exception type "${expectedType}" not found in message.`)
  assert(crashReport.error.message.includes(expectedMessage), `[${label}] Expected exception message "${expectedMessage}" not found.`)
  if (expectedFrame) {
    const frame = crashReport.error.stack.frames.find(f => f.function && f.function.includes(expectedFrame))
    assert(frame, `[${label}] Expected stack frame for ${expectedFrame} not found.`)
  }
}

async function testUnhandledNonError (label, script, { expectedFallbackType, expectedValue }) {
  console.log('Running test: testUnhandledNonError', label)

  const { logPayload } = await runApp(script)
  const crashReport = JSON.parse(logPayload.message)

  assert(crashReport.error.message.includes(expectedFallbackType), `[${label}] Expected fallback type "${expectedFallbackType}" not found in message.`)
  assert(crashReport.error.message.includes(expectedValue), `[${label}] Expected stringified value "${expectedValue}" not found in message.`)
  assert.strictEqual(crashReport.error.stack.frames.length, 0, `[${label}] Expected empty stack trace but got ${crashReport.error.stack.frames.length} frames.`)
}

function runApp (script) {
  return new Promise((resolve, reject) => {
    let closeTimer
    let done = false

    const child = exec(`node ${script}`, getExecOptions({
      env: { ...process.env, PORT },
    }))

    child.on('error', (err) => {
      cleanup()
      reject(new Error(`Child process for "${script}" failed to start`, { cause: err }))
    })

    child.on('close', (code, signal) => {
      if (done) return
      // Allow a grace period for the crash report HTTP request to arrive
      // after the child process exits (e.g. segfault sends report then dies).
      closeTimer = setTimeout(() => {
        const reason = signal ? `signal ${signal}` : `exit code ${code}`
        reject(new Error(`Child process for "${script}" exited with ${reason} before sending a crash report`))
      }, 5000)
    })

    currentTest = (logPayload, tags) => {
      cleanup()
      currentTest = undefined
      resolve({ logPayload, tags })
    }

    function cleanup () {
      clearTimeout(closeTimer)
      done = true
    }
  })
}

/**
 * @param {import('node:child_process').ExecOptions} [options]
 * @returns {import('node:child_process').ExecOptions}
 */
function getExecOptions (options) {
  return {
    cwd: __dirname,
    stdio: 'inherit',
    uid: process.getuid(),
    gid: process.getgid(),
    ...options,
  }
}
