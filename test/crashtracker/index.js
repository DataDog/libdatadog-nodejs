'use strict'

const { execSync } = require('child_process')
const express = require('express')
const bodyParser = require('body-parser')

const cwd = __dirname

execSync('npm install --silent', { cwd })
execSync('npm run --silent build', { cwd })

const app = express()

let timeout = setTimeout(() => {
  throw new Error('No crash report received before timing out.')
}, 5000)

app.use(bodyParser.json())

app.post('/telemetry/proxy/api/v2/apmtelemetry', (req, res) => {
  clearTimeout(timeout)

  res.status(200).send()

  server.close(() => {
    const stackTrace = JSON.parse(req.body.payload[0].stack_trace)
    const boomFrame = stackTrace.find(frame => frame.names[0].name.includes('boom'))

    if (!boomFrame) {
      throw new Error('Could not find a stack frame for the crashing function.')
    }
  })
})

const server = app.listen(() => {
  const PORT = server.address().port

  try {
    execSync('node app', {
      cwd,
      stdio: ['inherit', 'inherit', 'inherit'],
      env: {
        ...process.env,
        PORT
      }
    })
  } catch (e) {
    if (e.signal !== 'SIGSEGV') {
      throw e
    }
  }
})
