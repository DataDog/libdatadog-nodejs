// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm spawn implementation backed by `wasm_bindgen_futures::spawn_local`
//! with `futures::FutureExt::remote_handle` for join/cancel semantics.

use core::future::Future;

use futures_util::future::{FutureExt, RemoteHandle};
use wasm_bindgen_futures::spawn_local;

use libdd_capabilities::maybe_send::MaybeSend;
use libdd_capabilities::spawn::SpawnCapability;

#[derive(Clone, Debug)]
pub struct WasmSpawnCapability;

impl SpawnCapability for WasmSpawnCapability {
    type JoinHandle<T: MaybeSend + 'static> = RemoteHandle<T>;

    fn spawn<F, T>(&self, future: F) -> RemoteHandle<T>
    where
        F: Future<Output = T> + MaybeSend + 'static,
        T: MaybeSend + 'static,
    {
        let (remote, handle) = future.remote_handle();
        spawn_local(remote);
        handle
    }
}
