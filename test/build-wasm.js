'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { test } = require('node:test')

const buildScript = path.join(__dirname, '..', 'scripts', 'build-wasm.js')

test('builds WASM crates with scoped compiler flags and output paths', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'build-wasm-'))
  const projectRoot = path.join(temporaryRoot, 'nested', 'repository')
  const binaryDirectory = path.join(temporaryRoot, 'bin')
  const homebrewDirectory = path.join(temporaryRoot, 'homebrew')
  const llvmDirectory = path.join(homebrewDirectory, 'opt', 'llvm', 'bin')
  const existingRustFlags = '-C debuginfo=1'
  const libdatadogWasmRustFlags = '-C target-feature=+simd128 -C llvm-args=-inline-threshold=45'

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
      fs.writeFileSync(
        path.join(outputDirectory, 'rustflags'),
        process.env.CARGO_ENCODED_RUSTFLAGS ??
          process.env.RUSTFLAGS ??
          process.env.CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS ??
          '',
      )
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
        CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: existingRustFlags,
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
      assert.strictEqual(
        fs.readFileSync(path.join(outputDirectory, 'rustflags'), 'utf8'),
        existingRustFlags,
      )
    }

    const crateDirectory = path.join(projectRoot, 'crates', 'libdatadog-wasm')
    fs.mkdirSync(crateDirectory, { recursive: true })

    const encodedExistingRustFlags = existingRustFlags.replaceAll(' ', '\x1F')
    const encodedLibdatadogWasmRustFlags = libdatadogWasmRustFlags.replaceAll(' ', '\x1F')
    const rustFlagCases = [
      {
        environment: { CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: existingRustFlags },
        expected: `${existingRustFlags} ${libdatadogWasmRustFlags}`,
        name: 'target',
      },
      {
        environment: { RUSTFLAGS: existingRustFlags },
        expected: `${existingRustFlags} ${libdatadogWasmRustFlags}`,
        name: 'standard',
      },
      {
        environment: { CARGO_ENCODED_RUSTFLAGS: encodedExistingRustFlags },
        expected: `${encodedExistingRustFlags}\x1F${encodedLibdatadogWasmRustFlags}`,
        name: 'encoded',
      },
    ]

    for (const { environment, expected, name } of rustFlagCases) {
      const outputDirectory = path.join(projectRoot, 'prebuilds', `libdatadog-wasm-${name}`)
      execFileSync(process.execPath, [buildScript, crateDirectory, outputDirectory], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CARGO_ENCODED_RUSTFLAGS: undefined,
          CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: undefined,
          RUSTFLAGS: undefined,
          ...environment,
          HOMEBREW_DIR: homebrewDirectory,
          PATH: `${binaryDirectory}${path.delimiter}${process.env.PATH}`,
        },
        stdio: 'pipe',
      })

      assert.strictEqual(
        fs.readFileSync(path.join(outputDirectory, 'rustflags'), 'utf8'),
        expected,
      )
    }
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true })
  }
})

function writeExecutable (file, body) {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`)
  fs.chmodSync(file, 0o755)
}
