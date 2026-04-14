// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm capability implementations for libdatadog-nodejs.
//!
//! `WasmCapabilities` is the bundle struct that implements all capability
//! traits using wasm_bindgen + JS transports. The wasm binding crate pins
//! this type as the generic parameter for libdatadog structs.

pub mod http;
pub mod sleep;
pub mod spawn;

use core::future::Future;
use std::time::Duration;

use futures_util::future::RemoteHandle;

pub use http::WasmHttpClient;
use libdd_capabilities::http::{HttpClientCapability, HttpError};
use libdd_capabilities::sleep::SleepCapability;
use libdd_capabilities::spawn::SpawnCapability;
use libdd_capabilities::MaybeSend;
pub use sleep::WasmSleepCapability;
pub use spawn::WasmSpawnCapability;

/// Bundle struct for wasm platform capabilities.
///
/// Delegates to [`WasmHttpClient`] for HTTP, [`WasmSleepCapability`] for
/// sleep, and [`WasmSpawnCapability`] for task spawning.
#[derive(Clone, Debug)]
pub struct WasmCapabilities;

impl HttpClientCapability for WasmCapabilities {
    fn new_client() -> Self {
        Self
    }

    fn request(
        &self,
        req: ::http::Request<bytes::Bytes>,
    ) -> impl Future<Output = Result<::http::Response<bytes::Bytes>, HttpError>> + MaybeSend {
        WasmHttpClient.request(req)
    }
}

impl SleepCapability for WasmCapabilities {
    fn sleep(&self, duration: Duration) -> impl Future<Output = ()> + MaybeSend {
        WasmSleepCapability.sleep(duration)
    }
}

impl SpawnCapability for WasmCapabilities {
    type JoinHandle<T: MaybeSend + 'static> = RemoteHandle<T>;

    fn spawn<F, T>(&self, future: F) -> RemoteHandle<T>
    where
        F: Future<Output = T> + MaybeSend + 'static,
        T: MaybeSend + 'static,
    {
        WasmSpawnCapability.spawn(future)
    }
}
