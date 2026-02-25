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

function runSegfaultTest (PORT) {
  return new Promise((resolve, reject) => {
    currentTest = (logPayload, tags) => {
      currentTest = null
      const stackTrace = JSON.parse(logPayload.message).error.stack.frames

      const boomFrame = stackTrace.find(frame => frame.function?.toLowerCase().includes('segfaultify'))

      if (existsSync('/etc/alpine-release')) {
        // TODO: Remove this when supported.
        console.log('Received crash report. Skipping stack trace test since it is currently unsupported for Alpine.')
      } else if (boomFrame) {
        console.log('Stack frame for crashing function successfully received by the mock agent.')
      } else {
        return reject(new Error('Could not find a stack frame for the crashing function.'))
      }

      if (tags.includes('profiler_serializing:1')) {
        console.log('Stack trace was marked as happened during profile serialization.')
      } else {
        return reject(new Error('Stack trace was not marked as happening during profile serialization.'))
      }

      resolve()
    }

    exec('node app-seg-fault', {
      ...opts,
      env: { ...process.env, PORT }
    }, e => {
      if (e && e.signal !== 'SIGSEGV' && e.code !== 139 && e.status !== 139) {
        reject(e)
      }
    })
  })
}

function runUnhandledExceptionTest (PORT) {
  return new Promise((resolve, reject) => {
    rmSync(path.join(cwd, 'stdout.log'), { force: true })
    rmSync(path.join(cwd, 'stderr.log'), { force: true })

    currentTest = (logPayload) => {
      currentTest = null
      const crashReport = JSON.parse(logPayload.message)
      const stackTrace = crashReport.error.stack.frames
      const errorMessage = crashReport.error.message
      const errorKind = crashReport.error.kind

      if (errorKind === 'UnhandledException') {
        console.log('Error kind correctly reported as UnhandledException.')
      } else {
        return reject(new Error(`Expected error kind "UnhandledException" but got "${errorKind}".`))
      }

      if (errorMessage.includes('TypeError') && errorMessage.includes('something went wrong')) {
        console.log('Exception type and message correctly captured.')
      } else {
        return reject(new Error(`Error message did not contain expected content: "${errorMessage}".`))
      }

      const faultyFrame = stackTrace.find(frame =>
        frame.function && frame.function.includes('myFaultyFunction')
      )

      if (faultyFrame) {
        console.log('Stack frame for myFaultyFunction successfully received by the mock agent.')
      } else {
        return reject(new Error('Could not find a stack frame for myFaultyFunction.'))
      }

      resolve()
    }

    exec('node app-unhandled-exception', {
      ...opts,
      env: { ...process.env, PORT }
    }, e => {
      if (e) {
        // tolerate non-zero exit since reportUnhandledException disables the crash handler
      }
    })
  })
}

const server = app.listen(async () => {
  const PORT = server.address().port

  try {
    await runSegfaultTest(PORT)
    await runUnhandledExceptionTest(PORT)
  } catch (e) {
    clearTimeout(timeout)
    server.close(() => { throw e })
    return
  }

  clearTimeout(timeout)
  server.close()
})
