// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm capability implementations for libdatadog-nodejs.
//!
//! `WasmCapabilities` is the bundle struct that implements all capability
//! traits using wasm_bindgen + JS transports. The wasm binding crate pins
//! this type as the generic parameter for libdatadog structs.

pub mod http;

pub use http::DefaultHttpClient;

/// Bundle struct for wasm platform capabilities.
///
/// Currently delegates to `DefaultHttpClient` for HTTP. As more capability
/// traits are added (spawn, sleep, etc.), this type will implement all of them.
pub type WasmCapabilities = DefaultHttpClient;
