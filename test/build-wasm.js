'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { test } = require('node:test')

const buildScript = path.join(__dirname, '..', 'scripts', 'build-wasm.js')

test('cleans WASM output relative to each crate', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'build-wasm-'))
  const projectRoot = path.join(temporaryRoot, 'nested', 'repository')
  const binaryDirectory = path.join(temporaryRoot, 'bin')
  const homebrewDirectory = path.join(temporaryRoot, 'homebrew')
  const llvmDirectory = path.join(homebrewDirectory, 'opt', 'llvm', 'bin')

  try {
    fs.mkdirSync(projectRoot, { recursive: true })
    fs.mkdirSync(binaryDirectory)
    fs.mkdirSync(llvmDirectory, { recursive: true })
    writeExecutable(path.join(llvmDirectory, 'llvm-config'), 'process.exit(0)')
    writeExecutable(path.join(binaryDirectory, 'wasm-pack'), `
      const fs = require('node:fs')
      const path = require('node:path')
      const outputIndex = process.argv.indexOf('--out-dir') + 1
      const outputDirectory = process.argv[outputIndex]
      fs.mkdirSync(outputDirectory, { recursive: true })
      fs.writeFileSync(path.join(outputDirectory, '.gitignore'), '')
      fs.writeFileSync(path.join(outputDirectory, 'built'), '')
    `)

    for (const library of ['library_config', 'pipeline']) {
      const crateDirectory = path.join(projectRoot, 'crates', library)
      const outputDirectory = path.join(projectRoot, 'prebuilds', library)
      const unrelatedDirectory = path.resolve(
        projectRoot,
        '..',
        '..',
        'prebuilds',
        library,
      )

      fs.mkdirSync(crateDirectory, { recursive: true })
      fs.mkdirSync(outputDirectory, { recursive: true })
      fs.mkdirSync(unrelatedDirectory, { recursive: true })
      fs.writeFileSync(path.join(outputDirectory, 'stale'), '')
      fs.writeFileSync(path.join(unrelatedDirectory, 'keep'), '')
    }

    execFileSync(process.execPath, [buildScript], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOMEBREW_DIR: homebrewDirectory,
        PATH: `${binaryDirectory}${path.delimiter}${process.env.PATH}`,
      },
      stdio: 'pipe',
    })

    for (const library of ['library_config', 'pipeline']) {
      const outputDirectory = path.join(projectRoot, 'prebuilds', library)
      const unrelatedDirectory = path.resolve(
        projectRoot,
        '..',
        '..',
        'prebuilds',
        library,
      )

      assert(!fs.existsSync(path.join(outputDirectory, 'stale')))
      assert(fs.existsSync(path.join(outputDirectory, 'built')))
      assert(!fs.existsSync(path.join(outputDirectory, '.gitignore')))
      assert(fs.existsSync(path.join(unrelatedDirectory, 'keep')))
    }
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true })
  }
})

function writeExecutable (file, body) {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`)
  fs.chmodSync(file, 0o755)
}
