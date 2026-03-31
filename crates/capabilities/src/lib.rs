// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm capability implementations for libdatadog-nodejs.
//!
//! `WasmCapabilities` is the bundle struct that implements all capability
//! traits using wasm_bindgen + JS transports. The wasm binding crate pins
//! this type as the generic parameter for libdatadog structs.

pub mod http;

use core::future::Future;

pub use http::DefaultHttpClient;
use libdd_capabilities::http::{HttpClientTrait, HttpError};
use libdd_capabilities::MaybeSend;

/// Bundle struct for wasm platform capabilities.
///
/// Delegates to [`DefaultHttpClient`] for HTTP. As more capability traits are
/// added (spawn, sleep, etc.), additional fields and impls are added here
/// without changing the type identity — consumers see the same
/// `WasmCapabilities` throughout.
#[derive(Clone, Debug)]
pub struct WasmCapabilities;

impl HttpClientTrait for WasmCapabilities {
    fn new_client() -> Self {
        Self
    }

    fn request(
        &self,
        req: ::http::Request<bytes::Bytes>,
    ) -> impl Future<Output = Result<::http::Response<bytes::Bytes>, HttpError>> + MaybeSend {
        DefaultHttpClient.request(req)
    }
}
