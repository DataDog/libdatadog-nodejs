'use strict'

const fs = require('node:fs')
const path = require('node:path')

const output = path.join(__dirname, '..', 'dist', 'native')
fs.rmSync(output, { force: true, recursive: true })
