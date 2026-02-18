// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm implementation of [`HttpClientTrait`] backed by Node.js `http.request`.
//!
//! The JS transport is imported via `wasm_bindgen(module = ...)` from
//! `http_transport.js`, which ships alongside the wasm output.

use std::collections::HashMap;
use std::future::Future;

use js_sys;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use libdd_capabilities::http::{HttpClientTrait, HttpError, HttpRequest, HttpResponse};
use libdd_capabilities::maybe_send::MaybeSend;

#[wasm_bindgen(module = "/src/http_transport.js")]
extern "C" {
    #[wasm_bindgen(js_name = "httpRequest")]
    fn http_request(
        method: &str,
        url: &str,
        headers_json: &str,
        body: &[u8],
    ) -> js_sys::Promise;
}

/// Wasm [`HttpClientTrait`] implementation that delegates to Node.js HTTP.
///
/// Named `DefaultHttpClient` to match the native version's public API.
pub struct DefaultHttpClient;

impl HttpClientTrait for DefaultHttpClient {
    #[allow(clippy::manual_async_fn)]
    fn request(
        req: HttpRequest,
    ) -> impl Future<Output = Result<HttpResponse, HttpError>> + MaybeSend {
        async move {
            let method = req.method_str();
            let url = req.url().to_owned();
            let headers_json = serialize_headers(req.headers())?;
            let body = req.into_body();

            let result = JsFuture::from(http_request(method, &url, &headers_json, &body))
                .await
                .map_err(|e| HttpError::Network(format!("{:?}", e)))?;

            let status = js_sys::Reflect::get(&result, &JsValue::from_str("status"))
                .map_err(|_| HttpError::Other("missing status in response".into()))?
                .as_f64()
                .ok_or_else(|| HttpError::Other("status is not a number".into()))?
                as u16;

            let headers = parse_response_headers(&result)?;

            let body_js = js_sys::Reflect::get(&result, &JsValue::from_str("body"))
                .map_err(|_| HttpError::Other("missing body in response".into()))?;

            let body = if body_js.is_undefined() || body_js.is_null() {
                Vec::new()
            } else {
                js_sys::Uint8Array::new(&body_js).to_vec()
            };

            Ok(HttpResponse { status, headers, body })
        }
    }
}

/// Parse response headers from a JS object `{ "header-name": "value", ... }`.
///
/// Node.js `res.headers` returns lowercased header names with string values.
fn parse_response_headers(result: &JsValue) -> Result<Vec<(String, String)>, HttpError> {
    let headers_js = js_sys::Reflect::get(result, &JsValue::from_str("headers"))
        .map_err(|_| HttpError::Other("missing headers in response".into()))?;

    if headers_js.is_undefined() || headers_js.is_null() {
        return Ok(Vec::new());
    }

    let entries = js_sys::Object::entries(&js_sys::Object::unchecked_from_js(headers_js));
    let mut headers = Vec::with_capacity(entries.length() as usize);
    for i in 0..entries.length() {
        let entry = js_sys::Array::from(&entries.get(i));
        if let (Some(key), Some(value)) = (entry.get(0).as_string(), entry.get(1).as_string()) {
            headers.push((key, value));
        }
    }
    Ok(headers)
}

fn serialize_headers(headers: &[(String, String)]) -> Result<String, HttpError> {
    let map: HashMap<&str, &str> = headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    serde_json::to_string(&map)
        .map_err(|e| HttpError::InvalidRequest(format!("failed to serialize headers: {}", e)))
}
