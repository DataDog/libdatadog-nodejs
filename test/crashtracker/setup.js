'use strict'

const { execSync } = require('child_process')

const cwd = __dirname

execSync('npm install --silent', { cwd })
execSync('npm run --silent build', { cwd })
