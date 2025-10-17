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
execSync('touch stdout.log', opts)
execSync('touch stderr.log', opts)

let timeout = setTimeout(() => {
  console.log('===== stdout')
  execSync('cat stdout.log', opts)
  console.log('===== stderr')
  execSync('cat stderr.log', opts)
  console.log('=====')

  throw new Error('No crash report received before timing out.')
}, 10000) // TODO: reduce this when the receiver no longer locks up

app.use(bodyParser.json())

let pingReceived = false

app.post('/telemetry/proxy/api/v2/apmtelemetry', (req, res) => {
  clearTimeout(timeout)

  res.status(200).send()

  console.log(req.body)

  if (req.body.payload[0].tags.indexOf('is_crash_ping:true') !== -1) {
    pingReceived = true
    return
  }

  server.close(() => {
    if (!pingReceived) {
      throw new Error('Ping was not received before another message')
    }

    const stackTrace = JSON.parse(req.body.payload[0].message).error.stack.frames
    const boomFrame = stackTrace.find(frame => frame.function?.toLowerCase().includes('segfaultify'))

    console.log(inspect(stackTrace, true, 5, true))

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
