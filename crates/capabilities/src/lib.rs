// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm capability implementations for libdatadog-nodejs.
//!
//! [`WasmCapabilities`] is the bundle struct that implements every capability
//! trait `TraceExporter` requires (HTTP, sleep, log output) using wasm_bindgen
//! and JS transports. The wasm binding crate pins this type as the capability
//! generic for libdatadog's `TraceExporter`, mirroring libdatadog's native
//! `NativeCapabilities`.

use std::future::Future;
use std::time::Duration;

use libdd_capabilities::http::HttpError;
use libdd_capabilities::{HttpClientCapability, LogWriterCapability, MaybeSend, SleepCapability};

pub mod http;
pub mod sleep;

pub use http::WasmHttpClient;
pub use sleep::WasmSleepCapability;

/// Bundle of wasm platform capabilities for libdatadog's `TraceExporter`.
///
/// Mirrors libdatadog's native `NativeCapabilities`: delegates HTTP to
/// [`WasmHttpClient`] and sleep to [`WasmSleepCapability`]. Log output is a
/// no-op (see the [`LogWriterCapability`] impl). Per-function bounds stay
/// minimal in libdatadog (e.g. stats-only code uses [`WasmHttpClient`]
/// directly), so this bundle is only needed where the full `TraceExporter`
/// capability set is.
#[derive(Clone, Debug)]
pub struct WasmCapabilities {
    http: WasmHttpClient,
    sleep: WasmSleepCapability,
}

impl Default for WasmCapabilities {
    fn default() -> Self {
        Self::new()
    }
}

impl WasmCapabilities {
    pub fn new() -> Self {
        Self {
            http: WasmHttpClient::new_client(),
            sleep: WasmSleepCapability,
        }
    }
}

impl HttpClientCapability for WasmCapabilities {
    fn new_client() -> Self {
        Self {
            http: WasmHttpClient::new_client(),
            sleep: WasmSleepCapability,
        }
    }

    fn request(
        &self,
        req: ::http::Request<::bytes::Bytes>,
    ) -> impl Future<Output = Result<::http::Response<::bytes::Bytes>, HttpError>> + MaybeSend {
        self.http.request(req)
    }
}

impl SleepCapability for WasmCapabilities {
    fn new() -> Self {
        Self {
            http: WasmHttpClient::new_client(),
            sleep: WasmSleepCapability,
        }
    }

    fn sleep(&self, duration: Duration) -> impl Future<Output = ()> + MaybeSend {
        self.sleep.sleep(duration)
    }
}

impl LogWriterCapability for WasmCapabilities {
    fn write_log_output(&self, _bytes: &[u8]) -> std::io::Result<()> {
        // The wasm binding runs exclusively in trace-export mode; the
        // TraceExporter only invokes this in log-output mode, which this
        // binding never enables. Implemented as a no-op to satisfy the
        // capability bound. If log-output mode is added for wasm, route the
        // buffer to a JS sink (e.g. process.stderr) here.
        Ok(())
    }
}
