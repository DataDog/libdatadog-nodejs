'use strict'

const fs = require('fs')
const { execSync } = require('child_process')

fs.readdirSync('test')
  .filter(file => file.endsWith('.js') || !file.includes('.'))
  .forEach(file => {
    if (!file.includes('wasm')) {
      require('./test/' + file)
    }
  })
