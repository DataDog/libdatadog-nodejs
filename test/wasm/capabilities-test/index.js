'use strict'

// Tests for WasmSpawnCapability and WasmSleepCapability.
//
// To run:
//   1. Build: wasm-pack build --target nodejs ./crates/capabilities-test --out-dir ../../prebuilds/capabilities-test
//   2. Run:   node test_wasm.js capabilities-test

const loader = require('../../../load.js')
const assert = require('assert')

const mod = loader.load('capabilities-test')
assert(mod !== undefined, 'capabilities-test wasm module loaded')

async function run () {
  // --- SpawnCapability ---

  // Spawn a task and await its return value
  const spawnResult = await mod.test_spawn_returns_value()
  assert.strictEqual(spawnResult, 42, `spawn should return 42, got ${spawnResult}`)
  console.log('PASS: test_spawn_returns_value')

  // Spawn multiple concurrent tasks and collect results
  const concurrentResult = await mod.test_spawn_concurrent()
  assert.strictEqual(concurrentResult, 6, `concurrent spawn should return 6, got ${concurrentResult}`)
  console.log('PASS: test_spawn_concurrent')

  // Drop a spawn handle to cancel
  const cancelResult = await mod.test_spawn_cancel()
  assert.strictEqual(cancelResult, true, 'cancel should return true')
  console.log('PASS: test_spawn_cancel')

  // --- SleepCapability ---

  const sleepMs = 50
  const elapsed = await mod.test_sleep_duration_ms(sleepMs)
  assert(elapsed >= sleepMs - 5, `sleep should take at least ~${sleepMs}ms, took ${elapsed}ms`)
  assert(elapsed < sleepMs + 200, `sleep took unexpectedly long: ${elapsed}ms`)
  console.log(`PASS: test_sleep_duration_ms (${elapsed.toFixed(1)}ms for ${sleepMs}ms sleep)`)

  // --- Spawn + Sleep together ---

  const greeting = await mod.test_spawn_with_sleep(30)
  assert.strictEqual(greeting, 'slept 30ms', `expected 'slept 30ms', got '${greeting}'`)
  console.log('PASS: test_spawn_with_sleep')

  console.log('\nAll capabilities tests passed.')
}

run().catch(err => {
  console.error('Test error:', err)
  process.exitCode = 1
})
