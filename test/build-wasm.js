'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { test } = require('node:test')

const buildScript = path.join(__dirname, '..', 'scripts', 'build-wasm.js')

test('configures and cleans WASM builds', () => {
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
      fs.writeFileSync(path.join(outputDirectory, 'environment'), JSON.stringify({
        debug: process.env.CARGO_PROFILE_RELEASE_DEBUG,
        strip: process.env.CARGO_PROFILE_RELEASE_STRIP,
      }))
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

    const env = { ...process.env }
    delete env.CARGO_PROFILE_RELEASE_DEBUG
    delete env.CARGO_PROFILE_RELEASE_STRIP

    execFileSync(process.execPath, [buildScript], {
      cwd: projectRoot,
      env: {
        ...env,
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
      const environmentFile = fs.readFileSync(path.join(outputDirectory, 'environment'), 'utf8')
      const environment = JSON.parse(environmentFile)
      assert.deepStrictEqual(environment, os.platform() === 'darwin'
        ? {}
        : { debug: 'true', strip: 'false' })
    }

    const profilingCrate = path.join(projectRoot, 'crates', 'profiling')
    const profilingOutput = path.join(projectRoot, 'profile')
    fs.mkdirSync(profilingCrate)
    execFileSync(process.execPath, [buildScript, profilingCrate, profilingOutput, '--profiling'], {
      env: {
        ...env,
        HOMEBREW_DIR: homebrewDirectory,
        PATH: `${binaryDirectory}${path.delimiter}${process.env.PATH}`,
      },
      stdio: 'pipe',
    })
    const profilingEnvironmentFile = fs.readFileSync(path.join(profilingOutput, 'environment'), 'utf8')
    const profilingEnvironment = JSON.parse(profilingEnvironmentFile)
    assert.deepStrictEqual(profilingEnvironment, {
      debug: 'true',
      strip: 'false',
    })
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true })
  }
})

function writeExecutable (file, body) {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`)
  fs.chmodSync(file, 0o755)
}
