// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm sleep implementation backed by JS `setTimeout`.

use core::future::Future;
use std::time::Duration;

use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use libdd_capabilities::maybe_send::MaybeSend;
use libdd_capabilities::sleep::SleepCapability;

#[wasm_bindgen(module = "/src/sleep_transport.js")]
extern "C" {
    #[wasm_bindgen(js_name = "sleep")]
    fn js_sleep(ms: f64) -> js_sys::Promise;
}

#[derive(Clone, Debug)]
pub struct WasmSleepCapability;

impl SleepCapability for WasmSleepCapability {
    #[allow(clippy::manual_async_fn)]
    fn sleep(&self, duration: Duration) -> impl Future<Output = ()> + MaybeSend {
        async move {
            let ms = duration.as_millis() as f64;
            let _ = JsFuture::from(js_sleep(ms)).await;
        }
    }
}
