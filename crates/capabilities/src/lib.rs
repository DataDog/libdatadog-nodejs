// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm capability implementations.
//!
//! This crate has the same package name (`libdd-capabilities-impl`) and
//! public API as the native version in libdatadog. Cargo `[patch]` in
//! `libdatadog-nodejs/Cargo.toml` swaps this in when building for wasm.

pub mod http;

pub use http::DefaultHttpClient;
