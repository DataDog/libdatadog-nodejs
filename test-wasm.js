'use strict'

const fs = require('node:fs')

const crateTestsDir = `./test/wasm/${process.argv[2]}`
const files = fs.readdirSync(crateTestsDir).filter(file => file.endsWith('.js') || !file.includes('.'))

for (const file of files) {
  require(`${crateTestsDir}/${file}`)
}
