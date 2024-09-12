'use strict'

const { execSync } = require('child_process')
const os = require('os')

const cwd = __dirname
const stdio = ['inherit', 'inherit', 'inherit']

if (process.env.CI) {
  execSync(`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --verbose`, { cwd, stdio })
  process.env.PATH = `:${os.homedir()}/.cargo/bin:${process.env.PATH}"`
}

execSync('npm install --silent', { cwd, stdio })
execSync('npm run --silent build', { cwd, stdio })

const express = require('express')
const bodyParser = require('body-parser')

const app = express()

let timeout = setTimeout(() => {
  execSync('cat stdout.log', { cwd, stdio })
  execSync('cat stderr.log', { cwd, stdio })

  throw new Error('No crash report received before timing out.')
}, 10000) // TODO: reduce this when the receiver no longer locks up

app.use(bodyParser.json())

app.post('/telemetry/proxy/api/v2/apmtelemetry', (req, res) => {
  clearTimeout(timeout)

  res.status(200).send()

  server.close(() => {
    const stackTrace = JSON.parse(req.body.payload[0].stack_trace)
    const boomFrame = stackTrace.find(frame => frame.names[0]?.name.includes('boom'))

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
      stdio,
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
