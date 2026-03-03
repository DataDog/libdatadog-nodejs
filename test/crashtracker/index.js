'use strict'

const assert = require('node:assert')
const { existsSync, rmSync } = require('node:fs')
const path = require('node:path')
const { execSync, exec } = require('node:child_process')

const bodyParser = require('body-parser')
const express = require('express')

const cwd = __dirname
const stdio = ['inherit', 'inherit', 'inherit']
const uid = process.getuid()
const gid = process.getgid()
const opts = { cwd, stdio, uid, gid }

execSync('yarn install', opts)

const app = express()

rmSync(path.join(cwd, 'stdout.log'), { force: true })
rmSync(path.join(cwd, 'stderr.log'), { force: true })

const timeout = setTimeout(() => {
  execSync('cat stdout.log', opts)
  execSync('cat stderr.log', opts)

  throw new Error('No crash report received before timing out.')
}, 10_000)

let currentTest

app.use(bodyParser.json())

app.post('/telemetry/proxy/api/v2/apmtelemetry', (req, res) => {
  res.status(200).send()

  const logPayload = req.body.payload.logs[0]
  const tags = logPayload.tags ? logPayload.tags.split(',') : []

  // Only process crash reports (not pings)
  if (!logPayload.is_crash) {
    return
  }

  if (!currentTest) {
    throw new Error('Received unexpected crash report with no active test.')
  }

  currentTest(logPayload, tags)
})

let PORT

function runApp (script) {
  return new Promise((resolve) => {
    exec(`node ${script}`, {
      ...opts,
      env: { ...process.env, PORT },
    })

    currentTest = (logPayload, tags) => {
      currentTest = undefined
      resolve({ logPayload, tags })
    }
  })
}

async function testSegfault () {
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
  const { logPayload } = await runApp(script)
  const crashReport = JSON.parse(logPayload.message)

  assert(crashReport.error.message.includes(expectedFallbackType), `[${label}] Expected fallback type "${expectedFallbackType}" not found in message.`)
  assert(crashReport.error.message.includes(expectedValue), `[${label}] Expected stringified value "${expectedValue}" not found in message.`)
  assert.strictEqual(crashReport.error.stack.frames.length, 0, `[${label}] Expected empty stack trace but got ${crashReport.error.stack.frames.length} frames.`)
}

const server = app.listen(async () => {
  PORT = server.address().port

  await testSegfault()
  await testUnhandledError('uncaught-exception', 'app-uncaught-exception', {
    expectedType: 'TypeError',
    expectedMessage: 'something went wrong',
    expectedFrame: 'myFaultyFunction',
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
