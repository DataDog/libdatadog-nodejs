'use strict'

const { execSync } = require('child_process')
const express = require('express')
const bodyParser = require('body-parser')

const cwd = __dirname
const stdio = ['inherit', 'inherit', 'inherit']
const opts = { cwd, stdio }

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
    const killFrame = stackTrace.find(frame => frame.names[0]?.name.includes('_uv_kill'))

    for (const frame of stackTrace) {
      console.log(frame)
    }

    if (!killFrame) {
      throw new Error('Could not find a stack frame for the crashing function.')
    }
  })
})

const server = app.listen(() => {
  const PORT = server.address().port

  try {
    execSync('node app', {
      ...opts,
      env: {
        ...process.env,
        PORT
      }
    })
  } catch (e) {
    if (e.signal !== 'SIGSEGV' && e.status !== 139) {
      throw e
    }
  }
})
