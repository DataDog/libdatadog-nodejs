'use strict'

const { execSync, exec } = require('child_process')
const { inspect } = require('util')

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
}, 10000) // TODO: reduce this when the receiver no longer locks up

app.use(bodyParser.json())

let requestCount = 0

app.post('/telemetry/proxy/api/v2/apmtelemetry', (req, res) => {
  requestCount++
  res.status(200).send()

  // First request is ping, second is the crash report
  if (requestCount < 2) return

  clearTimeout(timeout)

  server.close(() => {
    console.log('Payload:', inspect(req.body.payload[0], true, 10, true))
    const stackTrace = JSON.parse(req.body.payload[0].message).error.stack.frames

    const boomFrame = stackTrace.find(frame => frame.function?.toLowerCase().includes('segfaultify'))

    if (existsSync('/etc/alpine-release')) {
      // TODO: Remove this when supported.
      console.log('Received crash report. Skipping stack trace test since it is currently unsupported for Alpine.')
    } else if (boomFrame) {
      console.log('Stack frame for crashing function successfully received by the mock agent.')
    } else {
      throw new Error('Could not find a stack frame for the crashing function.')
    }

    const tags = req.body.payload[0].tags.split(',')
    if (tags.includes('profiler_serializing:1')) {
      console.log('Stack trace was marked as happened during profile serialization.')
    } else {
      throw new Error('Stack trace was not marked as happening during profile serialization.')
    }
  })
})

const server = app.listen(() => {
  const PORT = server.address().port

  exec('node app', {
    ...opts,
    env: {
      ...process.env,
      PORT
    }
  }, e => {
    if (e.signal !== 'SIGSEGV' && e.code !== 139 && e.status !== 139) {
      throw e
    }
  })
})
