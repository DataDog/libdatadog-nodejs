// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm implementations of capability traits from `libdd-capabilities`.

pub mod http;

pub use http::WasmHttpClient;
