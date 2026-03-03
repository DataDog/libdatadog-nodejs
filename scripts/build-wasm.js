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
const childProcess = require('node:child_process')

const isMacOS = os.platform() === 'darwin'
const noWasmOpt = isMacOS ? '--no-opt' : ''
const library = process.argv[2]

const env = {
  ...process.env,
}

if (isMacOS) {
  const homebrewDir = env.HOMEBREW_DIR ?? '/opt/homebrew'
  const llvmDir = `${homebrewDir}/opt/llvm/`
  const llvmBinDir = `${llvmDir}/bin`

  try {
    childProcess.execSync(`${llvmBinDir}/llvm-config --version`)
  } catch {
    console.error(`‼️ LLVM not found in ${llvmDir}.\n‼️ Please install LLVM using Homebrew:\n📝   brew install llvm`)
    process.exit(1) // eslint-disable-line unicorn/no-process-exit
  }

  if (!env.PATH.includes(llvmBinDir)) {
    // Add LLVM to PATH if not already included
    env.PATH = `${llvmBinDir}:${env.PATH}`
  }

  // Force C/C++ code (e.g. zstd-sys) to use Homebrew's clang for wasm32. Otherwise a global
  // CC (e.g. ccache cc) can point at Apple Clang, which does not support wasm32-unknown-unknown.
  env.CC_wasm32_unknown_unknown = `${llvmBinDir}/clang`
  env.CXX_wasm32_unknown_unknown = `${llvmBinDir}/clang++`
}

childProcess.execSync(
  `wasm-pack build ${noWasmOpt} --target nodejs ./crates/${library} --out-dir ../../prebuilds/${library}`, {
    env,
  },
)
