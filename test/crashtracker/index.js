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
const { existsSync } = require('fs')

const app = express()

let timeout = setTimeout(() => {
  execSync('cat stdout.log', opts)
  execSync('cat stderr.log', opts)

  throw new Error('No crash report received before timing out.')
}, 10000) // TODO: reduce this when the receiver no longer locks up

app.use(bodyParser.json())

app.post('/telemetry/proxy/api/v2/apmtelemetry', (req, res) => {
  clearTimeout(timeout)

  res.status(200).send()

  server.close(() => {
    const stackTrace = JSON.parse(req.body.payload[0].stack_trace)
    const boomFrame = stackTrace.find(frame => frame.names?.[0]?.name.toLowerCase().includes('segfaultify'))

    console.log(inspect(stackTrace, true, 5, true))

    if (existsSync('/etc/alpine-release')) {
      // TODO: Remove this when supported.
      console.log('Received crash report with empty stack trace which is expected for Alpine.')
    } else if (boomFrame) {
      console.log('Stack frame for crashing function successfully received by the mock agent.')
    } else {
      throw new Error('Could not find a stack frame for the crashing function.')
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
