// This script builds a WebAssembly module using wasm-pack. It is essentially invoking
// wasm-pack build. All the special handling is for macOS, because Apple's Clang version suffers
// from some issues that prevent it from compiling at least the zstd crate.
// See https://github.com/gyscos/zstd-rs/issues/302
// This is solved by requiring the homebrew version of LLVM to be installed and available in the
// PATH. Unfortunately, this version then suffers from a different issue that requires wasm-opt to
// be disabled.
// See https://github.com/WebAssembly/wasi-sdk/issues/254
// See https://github.com/llvm/llvm-project/issues/64909
// Our releases are built on Linux, and fortunately no special handling is required there. This
// script only allows development to happen on macOS.

const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')

const isMacOS = os.platform() === 'darwin'
const wasmRustToolchain = fs.readFileSync(
  path.join(__dirname, '..', 'wasm-rust-toolchain'),
  'utf8',
).trim()
const libraries = [
  'library_config',
  'pipeline',
  'remote_config',
]

const env = {
  ...process.env,
}
const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
const rustFlagsKey = Object.keys(env).find(key => key.toUpperCase() === 'RUSTFLAGS') ?? 'RUSTFLAGS'
const rustupToolchainKey = Object.keys(env).find(key => key.toUpperCase() === 'RUSTUP_TOOLCHAIN') ?? 'RUSTUP_TOOLCHAIN'
const cargoPath = childProcess.execFileSync(
  'rustup',
  ['which', 'cargo', '--toolchain', wasmRustToolchain],
  { encoding: 'utf8' },
).trim()

env[pathKey] = `${path.dirname(cargoPath)}${path.delimiter}${env[pathKey]}`
env[rustFlagsKey] = [env[rustFlagsKey], '-Zunstable-options', '-Cpanic=immediate-abort']
  .filter(Boolean)
  .join(' ')
env[rustupToolchainKey] = wasmRustToolchain

// Keep the min-size profile while relaxing only LLVM's inlining cap for the compression hot path.
// Rebenchmark this LLVM-internal threshold when updating rust-toolchain.toml.
const compressionWasmRustFlags = '-C target-feature=+simd128 -C llvm-args=-inline-threshold=45'
const compressionWasmCrates = new Set(['libdatadog-wasm', 'libdatadog-wasm-zstd'])

if (isMacOS) {
  const homebrewDir = env.HOMEBREW_DIR ?? '/opt/homebrew'
  const llvmDir = `${homebrewDir}/opt/llvm/`
  const llvmBinDir = `${llvmDir}/bin`

  try {
    childProcess.execSync(`${llvmBinDir}/llvm-config --version`)
  } catch {
    console.error([
      `‼️ LLVM not found in ${llvmDir}.`,
      '‼️ Please install LLVM using Homebrew:',
      '📝   brew install llvm',
    ].join('\n'))
    process.exit(1) // eslint-disable-line unicorn/no-process-exit
  }

  if (!env[pathKey].includes(llvmBinDir)) {
    // Add LLVM to PATH if not already included
    env[pathKey] = `${llvmBinDir}${path.delimiter}${env[pathKey]}`
  }

  // Force C/C++ code (e.g. zstd-sys) to use Homebrew's clang for wasm32. Otherwise a global
  // CC (e.g. ccache cc) can point at Apple Clang, which does not support wasm32-unknown-unknown.
  env.CC_wasm32_unknown_unknown = `${llvmBinDir}/clang`
  env.CXX_wasm32_unknown_unknown = `${llvmBinDir}/clang++`
}

/**
 * Build one WASM crate with the platform-specific compiler configuration.
 *
 * @param {string} cratePath
 * @param {string} outputDirectory
 * @param {{ profiling?: boolean, skipOptimization?: boolean }} options
 * @returns {Promise<void>}
 */
async function buildWasm (cratePath, outputDirectory, options = {}) {
  const { profiling = false, skipOptimization = false } = options
  const resolvedOutputDirectory = path.resolve(cratePath, outputDirectory)
  const buildEnvironment = { ...env }
  if (compressionWasmCrates.has(path.basename(cratePath))) {
    if (buildEnvironment.CARGO_ENCODED_RUSTFLAGS === undefined) {
      const rustFlagsName = buildEnvironment.RUSTFLAGS === undefined
        ? 'CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS'
        : 'RUSTFLAGS'
      buildEnvironment[rustFlagsName] = [
        buildEnvironment[rustFlagsName],
        compressionWasmRustFlags,
      ].filter(Boolean).join(' ')
    } else {
      buildEnvironment.CARGO_ENCODED_RUSTFLAGS = [
        buildEnvironment.CARGO_ENCODED_RUSTFLAGS,
        ...compressionWasmRustFlags.split(' '),
      ].filter(Boolean).join('\x1F')
    }
  }
  fs.rmSync(resolvedOutputDirectory, { force: true, recursive: true })
  const args = ['build']
  if (profiling) args.push('--profiling')
  if (skipOptimization) args.push('--no-opt')
  args.push('--target', 'nodejs', cratePath, '--out-dir', resolvedOutputDirectory, '--', '-Z', 'build-std=std')
  await new Promise((resolve, reject) => {
    const wasmPack = childProcess.spawn('wasm-pack', args, {
      env: {
        ...buildEnvironment,
        // Keep optimized release and profiling builds on one Cargo artifact.
        // wasm-opt removes debug data from release output on supported platforms.
        ...((profiling || !skipOptimization) && {
          CARGO_PROFILE_RELEASE_DEBUG: 'true',
          CARGO_PROFILE_RELEASE_STRIP: 'false',
        }),
      },
      stdio: 'inherit',
    })
    wasmPack.once('error', reject)
    wasmPack.once('close', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      const status = signal === null ? `code ${code}` : `signal ${signal}`
      reject(new Error(`wasm-pack exited with ${status}`))
    })
  })
  // wasm-pack ignores its output by default. These outputs are package inputs,
  // so remove the nested ignore file and let each npm package's files allowlist
  // decide whether they are published.
  fs.rmSync(path.join(resolvedOutputDirectory, '.gitignore'), { force: true })
}

const [cratePath, outputDirectory, mode] = process.argv.slice(2)
async function main () {
  if (cratePath || outputDirectory) {
    if (!cratePath || !outputDirectory) {
      throw new Error('Both the WASM crate path and output directory are required')
    }
    if (mode && mode !== '--profiling') throw new Error(`Unknown build mode: ${mode}`)
    await buildWasm(path.resolve(cratePath), path.resolve(outputDirectory), {
      profiling: mode === '--profiling',
      skipOptimization: isMacOS,
    })
    return
  }

  await Promise.all(libraries.map(library => buildWasm(
    `./crates/${library}`,
    `../../prebuilds/${library}`,
    { skipOptimization: isMacOS },
  )))
}

module.exports = { buildWasm }

if (require.main === module) {
  // CommonJS does not support top-level await.
  // eslint-disable-next-line unicorn/prefer-top-level-await
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
