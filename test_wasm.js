'use strict'

const fs = require('fs')

const crateTestsDir = `./test/wasm/${process.argv[2]}`
fs.readdirSync(crateTestsDir)
  .filter(file => file.endsWith('.js') || !file.includes('.'))
  .forEach(file => {
      require(`${crateTestsDir}/${file}`)
  })
