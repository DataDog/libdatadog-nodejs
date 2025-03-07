'use strict'

const fs = require('fs')
const { execSync } = require('child_process')

fs.readdirSync('test/wasm')
  .filter(file => file.endsWith('.js') || !file.includes('.'))
  .forEach(file => {
      require('./test/wasm/' + file)
  })
