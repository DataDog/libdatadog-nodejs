'use strict'

const fs = require('fs')
const { execSync } = require('child_process')

execSync('touch baz.txt')
execSync('touch scripts/baz.txt')
execSync('touch test/baz.txt')
execSync('touch test/empty/baz.txt')
execSync('touch test/crashtracker/baz.txt')

fs.readdirSync('test')
  .filter(file => file.endsWith('.js') || !file.includes('.'))
  .forEach(file => {
    require('./test/' + file)
  })
