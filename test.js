'use strict'

const fs = require('fs')

fs.readdirSync('test').forEach(file => {
  require('./test/' + file)
})
