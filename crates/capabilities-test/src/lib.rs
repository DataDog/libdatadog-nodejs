// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm test harness for `SpawnCapability` and `SleepCapability`.
//!
//! Each `#[wasm_bindgen]` function exercises a specific capability and returns
//! a value the JS test can assert on.

use std::time::Duration;

use libdd_capabilities::sleep::SleepCapability;
use libdd_capabilities::spawn::SpawnCapability;
use libdatadog_nodejs_capabilities::{WasmSleepCapability, WasmSpawnCapability};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn init() {
    console_error_panic_hook::set_once();
}

/// Spawn a task that returns a fixed value and await it.
#[wasm_bindgen]
pub async fn test_spawn_returns_value() -> u32 {
    let spawner = WasmSpawnCapability;
    let handle = spawner.spawn(async { 42u32 });
    handle.await
}

/// Sleep for `ms` milliseconds and return the actual elapsed time (ms).
/// The JS side can assert this is >= `ms`.
#[wasm_bindgen]
pub async fn test_sleep_duration_ms(ms: u32) -> f64 {
    let sleeper = WasmSleepCapability;
    let start = js_sys::Date::now();
    sleeper.sleep(Duration::from_millis(ms as u64)).await;
    js_sys::Date::now() - start
}

/// Spawn a task that sleeps then returns a greeting. Exercises both
/// capabilities together.
#[wasm_bindgen]
pub async fn test_spawn_with_sleep(ms: u32) -> String {
    let spawner = WasmSpawnCapability;
    let handle = spawner.spawn(async move {
        let sleeper = WasmSleepCapability;
        sleeper.sleep(Duration::from_millis(ms as u64)).await;
        format!("slept {}ms", ms)
    });
    handle.await
}

/// Spawn multiple concurrent tasks and collect all results.
#[wasm_bindgen]
pub async fn test_spawn_concurrent() -> JsValue {
    let spawner = WasmSpawnCapability;
    let h1 = spawner.spawn(async { 1u32 });
    let h2 = spawner.spawn(async { 2u32 });
    let h3 = spawner.spawn(async { 3u32 });
    let (r1, r2, r3) = futures_join(h1, h2, h3).await;
    JsValue::from(r1 + r2 + r3)
}

async fn futures_join<A, B, C>(
    a: impl core::future::Future<Output = A>,
    b: impl core::future::Future<Output = B>,
    c: impl core::future::Future<Output = C>,
) -> (A, B, C) {
    // Manual join: spawn b and c, await a inline, then collect.
    // We can't use tokio::join! here (no runtime), so we just await
    // sequentially -- the tasks are already running on the event loop via
    // spawn_local, so their futures resolve as soon as polled.
    let a = a.await;
    let b = b.await;
    let c = c.await;
    (a, b, c)
}

/// Spawn a task and drop the handle (cancel). Verify the main thread
/// is not blocked and we get back control immediately.
#[wasm_bindgen]
pub async fn test_spawn_cancel() -> bool {
    let spawner = WasmSpawnCapability;
    let handle = spawner.spawn(async {
        let sleeper = WasmSleepCapability;
        sleeper.sleep(Duration::from_secs(60)).await;
        panic!("should have been cancelled");
    });
    drop(handle);
    true
}
