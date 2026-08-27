const { readdirSync } = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const testFiles = readdirSync(path.join(__dirname, '..', 'test'))
  .filter(file => file.endsWith('.test.js'))
  .map(file => path.join('test', file))
const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
