'use strict'

const { execSync, exec } = require('child_process')

const cwd = __dirname
const stdio = ['inherit', 'inherit', 'inherit']
const uid = process.getuid()
const gid = process.getgid()
const opts = { cwd, stdio, uid, gid }

execSync('yarn install', opts)

const express = require('express')
const bodyParser = require('body-parser')
const { existsSync, rmSync } = require('fs')
const path = require('path')

const app = express()

rmSync(path.join(cwd, 'stdout.log'), { force: true })
rmSync(path.join(cwd, 'stderr.log'), { force: true })

let timeout = setTimeout(() => {
  execSync('cat stdout.log', opts)
  execSync('cat stderr.log', opts)

  throw new Error('No crash report received before timing out.')
}, 10000)

let currentTest = null

app.use(bodyParser.json())

app.post('/telemetry/proxy/api/v2/apmtelemetry', (req, res) => {
  res.status(200).send()

  const logPayload = req.body.payload.logs[0]
  const tags = logPayload.tags ? logPayload.tags.split(',') : []

  // Only process crash reports (not pings)
  if (!logPayload.is_crash) {
    return
  }

  if (currentTest) {
    currentTest(logPayload, tags)
  }
})

let PORT

function runApp (script, { expectSignal } = {}) {
  return new Promise((resolve) => {
    exec(`node ${script}`, {
      ...opts,
      env: { ...process.env, PORT }
    }, e => {
      if (e) {
        if (expectSignal && (e.signal === expectSignal || e.code === 139 || e.status === 139)) {
          return
        }
      }
    })

    currentTest = (logPayload, tags) => {
      currentTest = null
      resolve({ logPayload, tags })
    }
  })
}

function assert (condition, label, message) {
  if (!condition) {
    throw new Error(`[${label}] ${message}`)
  }
  console.log(`[${label}] ${message}`)
}

async function testSegfault () {
  const { logPayload, tags } = await runApp('app-seg-fault', { expectSignal: 'SIGSEGV' })
  const stackTrace = JSON.parse(logPayload.message).error.stack.frames
  const boomFrame = stackTrace.find(frame => frame.function?.toLowerCase().includes('segfaultify'))

  if (existsSync('/etc/alpine-release')) {
    console.log('[segfault] Received crash report. Skipping stack trace test since it is currently unsupported for Alpine.')
  } else {
    assert(boomFrame, 'segfault', 'Stack frame for crashing function successfully received.')
  }

  assert(tags.includes('profiler_serializing:1'), 'segfault', 'Stack trace was marked as happened during profile serialization.')
}

async function testUnhandledError (label, script, { expectedType, expectedMessage, expectedFrame }) {
  const { logPayload } = await runApp(script)
  const crashReport = JSON.parse(logPayload.message)

  assert(crashReport.error.message.includes(expectedType), label, `Exception type "${expectedType}" captured in message.`)
  assert(crashReport.error.message.includes(expectedMessage), label, `Exception message "${expectedMessage}" captured.`)

  const frame = crashReport.error.stack.frames.find(f => f.function && f.function.includes(expectedFrame))
  assert(frame, label, `Stack frame for ${expectedFrame} successfully received.`)
}

async function testUnhandledNonError (label, script, { expectedFallbackType, expectedValue }) {
  const { logPayload } = await runApp(script)
  const crashReport = JSON.parse(logPayload.message)

  assert(crashReport.error.message.includes(expectedFallbackType), label, `Fallback type "${expectedFallbackType}" captured in message.`)
  assert(crashReport.error.message.includes(expectedValue), label, `Stringified value "${expectedValue}" captured in message.`)
  assert(crashReport.error.stack.frames.length === 0, label, 'Empty stack trace correctly reported.')
}

const server = app.listen(async () => {
  PORT = server.address().port

  try {
    await testSegfault()
    await testUnhandledError('uncaught-exception', 'app-uncaught-exception', {
      expectedType: 'TypeError',
      expectedMessage: 'something went wrong',
      expectedFrame: 'myFaultyFunction'
    })
    await testUnhandledNonError('uncaught-exception-non-error', 'app-uncaught-exception-non-error', {
      expectedFallbackType: 'uncaughtException',
      expectedValue: 'a plain string error'
    })
    await testUnhandledError('unhandled-rejection', 'app-unhandled-rejection', {
      expectedType: 'Error',
      expectedMessage: 'async went wrong',
      expectedFrame: 'myAsyncFaultyFunction'
    })
    await testUnhandledNonError('unhandled-rejection-non-error', 'app-unhandled-rejection-non-error', {
      expectedFallbackType: 'unhandledRejection',
      expectedValue: 'a plain string rejection'
    })
  } catch (e) {
    clearTimeout(timeout)
    server.close(() => { throw e })
    return
  }

  clearTimeout(timeout)
  server.close()
})
