'use strict'

const fs = require('fs')
const path = require('path')
const readline = require('readline')

const rootPath = path.resolve(path.join(__dirname, '..'))
const cratesPath = path.join(rootPath, 'crates')
const outPath = path.join(rootPath, 'target', 'out.ndjson')
const buildPath = path.join(rootPath, 'build', 'Release')

const lineReader = readline.createInterface({
  input: fs.createReadStream(outPath)
})

lineReader.on('line', function (line) {
  const { filenames, reason, target } = JSON.parse(line)

  if (reason !== 'compiler-artifact') return
  if (!target.src_path.startsWith(cratesPath)) return

  const filename = target.kind[0] === 'bin' ? target.name : `${target.name}.node`
  const filePath = path.join(buildPath, filename)

  fs.mkdirSync(buildPath, { recursive: true })
  fs.copyFileSync(filenames[0], filePath)
})
