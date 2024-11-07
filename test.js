'use strict'

const fs = require('fs')

execSync('touch test/crashtracker/baz.txt')

fs.readdirSync('test')
  .filter(file => file.endsWith('.js') || !file.includes('.'))
  .forEach(file => {
    require('./test/' + file)
  })
