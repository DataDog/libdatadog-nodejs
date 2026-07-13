// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Seed libdatadog's entity-header store from Node.
//!
//! libdd-common's automatic detection reads `/proc/self/cgroup` and
//! `DD_EXTERNAL_ENV` directly; neither is reachable from the
//! `wasm32-unknown-unknown` sandbox. Node reads them itself and hands the raw
//! values through this module *at wasm-module startup*, before any HTTP
//! send. libdatadog then renders `datadog-container-id`, `datadog-entity-id`
//! and `datadog-external-env` as part of the normal request head — no more
//! post-render header rewrite in JS.

use js_sys::Reflect;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(module = "/src/http_transport.js")]
extern "C" {
    // Returns an object `{ cgroupContent?: string, cgroupInode?: number, externalEnv?: string }`.
    // Absent / null / undefined fields signal "not available" (not linux, not in a cgroup,
    // env var unset). `cgroupInode` is a JS number so an inode past 2^53 would lose
    // precision, but real inodes never approach that.
    #[wasm_bindgen(js_name = "getEntityInputs")]
    fn get_entity_inputs() -> JsValue;
}

/// Pull entity ingredients from Node and seed the libdd-common entity-header
/// store. Call once, before the first HTTP send — libdd-common caches
/// first-call-wins, so a later call (or a getter that latched to `None`
/// before this ran) is a permanent no-op.
pub fn init_from_js() {
    let inputs = get_entity_inputs();

    let cgroup_content = Reflect::get(&inputs, &JsValue::from_str("cgroupContent"))
        .ok()
        .and_then(|v| v.as_string());
    let cgroup_inode = Reflect::get(&inputs, &JsValue::from_str("cgroupInode"))
        .ok()
        .and_then(|v| v.as_f64())
        .map(|n| n as u64);
    let external_env = Reflect::get(&inputs, &JsValue::from_str("externalEnv"))
        .ok()
        .and_then(|v| v.as_string());

    libdd_common::entity_id::init_entity_inputs(
        cgroup_content.as_deref(),
        cgroup_inode,
        external_env.as_deref(),
    );
}
