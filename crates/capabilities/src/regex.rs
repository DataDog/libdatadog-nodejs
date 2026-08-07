// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm implementation of [`RegexCapability`] backed by Node.js's native
//! `RegExp`.
//!
//! The compiled `RegExp` object is returned to Rust as a `js_sys::RegExp`
//! (a `JsValue` newtype).
//!
//! The JS side (`regex.js`) is responsible for translating JS `RegExp.exec`
//! results (UTF-16 code-unit indices) to UTF-8 byte offsets before returning
//! them.

use js_sys::{self, Int32Array};
use wasm_bindgen::prelude::*;

use libdd_capabilities::regex::{Captures, Match, RegexCapability, RegexError};

#[wasm_bindgen(module = "/src/regex.js")]
extern "C" {
    #[wasm_bindgen(js_name = "compile", catch)]
    fn js_compile(pattern: &str) -> Result<js_sys::RegExp, JsValue>;

    #[wasm_bindgen(js_name = "isMatch")]
    fn js_is_match(re: &js_sys::RegExp, haystack: &str) -> bool;

    #[wasm_bindgen(js_name = "findFirst")]
    fn js_find_first(re: &js_sys::RegExp, haystack: &str) -> Int32Array;

    #[wasm_bindgen(js_name = "findAll")]
    fn js_find_all(re: &js_sys::RegExp, haystack: &str) -> Int32Array;

    #[wasm_bindgen(js_name = "capturesAll")]
    fn js_captures_all(re: &js_sys::RegExp, haystack: &str) -> Int32Array;
}

// Pattern-string-preserving wrapper. `js_sys::RegExp::source` returns the
// pattern as a JS string, but the trait's `pattern()` returns `&str` borrowed
// from the handle, so we keep an owned copy on the Rust side.
#[derive(Clone, Debug)]
pub struct WasmRegexHandle {
    re: js_sys::RegExp,
    pattern: String,
}

#[derive(Clone, Debug)]
pub struct WasmRegexCapability;

impl RegexCapability for WasmRegexCapability {
    type Handle = WasmRegexHandle;

    fn compile(pattern: &str) -> Result<Self::Handle, RegexError> {
        js_compile(pattern)
            .map(|re| WasmRegexHandle {
                re,
                pattern: pattern.to_owned(),
            })
            .map_err(|e| RegexError::InvalidPattern {
                pattern: pattern.to_owned(),
                message: js_error_message(&e),
            })
    }

    fn is_match(handle: &Self::Handle, haystack: &str) -> bool {
        js_is_match(&handle.re, haystack)
    }

    fn find(handle: &Self::Handle, haystack: &str) -> Option<Match> {
        let arr = js_find_first(&handle.re, haystack);
        if arr.length() < 2 {
            return None;
        }
        let mut buf = [0i32; 2];
        arr.copy_to(&mut buf);
        Some(Match {
            start: buf[0] as usize,
            end: buf[1] as usize,
        })
    }

    fn find_all(handle: &Self::Handle, haystack: &str) -> Vec<Match> {
        let arr = js_find_all(&handle.re, haystack);
        let len = arr.length() as usize;
        debug_assert!(len.is_multiple_of(2), "findAll returned odd-length array");
        let mut buf = vec![0i32; len];
        arr.copy_to(&mut buf);
        buf.chunks_exact(2)
            .map(|c| Match {
                start: c[0] as usize,
                end: c[1] as usize,
            })
            .collect()
    }

    fn captures(handle: &Self::Handle, haystack: &str) -> Option<Captures> {
        decode_captures(js_captures_all(&handle.re, haystack))
            .1
            .into_iter()
            .next()
    }

    fn captures_all(handle: &Self::Handle, haystack: &str) -> Vec<Captures> {
        decode_captures(js_captures_all(&handle.re, haystack)).1
    }

    fn pattern(handle: &Self::Handle) -> &str {
        &handle.pattern
    }
}

// Decode the [groupCount, matchCount, s0_0, e0_0, ...] flat layout produced by
// `capturesAll`. `-1` sentinels become `None` groups. Returns (group_count,
// matches).
fn decode_captures(arr: Int32Array) -> (usize, Vec<Captures>) {
    let len = arr.length() as usize;
    if len < 2 {
        return (0, Vec::new());
    }
    let mut buf = vec![0i32; len];
    arr.copy_to(&mut buf);
    let group_count = buf[0] as usize;
    let match_count = buf[1] as usize;
    if group_count == 0 || match_count == 0 {
        return (group_count, Vec::new());
    }
    let mut out = Vec::with_capacity(match_count);
    let stride = group_count * 2;
    for m in 0..match_count {
        let base = 2 + m * stride;
        let mut groups = Vec::with_capacity(group_count);
        for g in 0..group_count {
            let s = buf[base + g * 2];
            let e = buf[base + g * 2 + 1];
            groups.push(if s < 0 {
                None
            } else {
                Some(Match {
                    start: s as usize,
                    end: e as usize,
                })
            });
        }
        out.push(Captures { groups });
    }
    (group_count, out)
}

fn js_error_message(err: &JsValue) -> String {
    js_sys::Reflect::get(err, &JsValue::from_str("message"))
        .ok()
        .and_then(|v| v.as_string())
        .unwrap_or_else(|| format!("{err:?}"))
}
