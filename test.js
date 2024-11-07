'use strict'

const fs = require('fs')

fs.readdirSync('test')
  .filter(file => file.endsWith('.js') || !file.includes('.'))
  .forEach(file => {
    require('./test/' + file)
  })
