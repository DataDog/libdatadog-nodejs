// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm implementation of [`HttpClientTrait`] backed by Node.js `http.request`.
//!
//! The JS transport is imported via `wasm_bindgen(module = ...)` from
//! `http_transport.js`, which ships alongside the wasm output.

use std::future::Future;
use std::io::Write as _;
use std::sync::LazyLock;
use std::time::Duration;

use bytes::Bytes;
use http::{HeaderMap, HeaderName, HeaderValue};
use js_sys::{self, Array, JsString, Number, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use libdd_capabilities::http::{HttpClientCapability, HttpError};
use libdd_capabilities::maybe_send::MaybeSend;
use libdd_capabilities::sleep::SleepCapability;

static WASM_MEMORY: LazyLock<JsValue> = LazyLock::new(|| wasm_bindgen::memory());

#[wasm_bindgen(module = "/src/http_transport.js")]
extern "C" {
    #[wasm_bindgen(js_name = "httpRequest")]
    fn http_request(
        host: &str,
        port: u16,
        is_https: bool,
        head_ptr: *const u8,
        head_len: u32,
        body_ptr: *const u8,
        body_len: u32,
        wasm_memory: &JsValue,
    ) -> js_sys::Promise;

    #[wasm_bindgen(js_name = "sleep")]
    fn js_sleep(ms: f64) -> js_sys::Promise;

    #[wasm_bindgen(js_name = "setStorage")]
    pub fn set_storage(new_storage: &JsValue);

    #[wasm_bindgen(js_name = "setResponseHeaderObserver")]
    pub fn set_response_header_observer(observer: &JsValue);
}

/// Wasm [`HttpClientTrait`] implementation that delegates to Node.js HTTP.
///
/// Named `DefaultHttpClient` to match the native version's public API.
#[derive(Debug, Clone)]
pub struct DefaultHttpClient;

impl HttpClientCapability for DefaultHttpClient {
    fn new_client() -> Self {
        Self
    }

    #[allow(clippy::manual_async_fn)]
    fn request(
        &self,
        req: http::Request<Bytes>,
    ) -> impl Future<Output = Result<http::Response<Bytes>, HttpError>> + MaybeSend {
        async move {
            let scheme = req.uri().scheme_str().unwrap_or("http");
            let is_https = scheme == "https";
            let host = req
                .uri()
                .host()
                .ok_or_else(|| HttpError::InvalidRequest(anyhow::anyhow!("missing host in URI")))?
                .to_owned();
            let port = req
                .uri()
                .port_u16()
                .unwrap_or(if is_https { 443 } else { 80 });

            let head = serialize_request_head(&req, &host, port, is_https)?;
            let body = req.into_body();

            let result = JsFuture::from(http_request(
                &host,
                port,
                is_https,
                head.as_ptr(),
                head.len() as u32,
                body.as_ptr(),
                body.len() as u32,
                WASM_MEMORY.as_ref(),
            ))
            .await
            .map_err(|e| HttpError::Network(anyhow::anyhow!("{:?}", e)))?;

            let result: js_sys::ArrayTuple<(Number, Array<JsString>, Uint8Array)> =
                js_sys::ArrayTuple::unchecked_from_js(result);

            let status = result
                .get0()
                .as_f64()
                .ok_or_else(|| HttpError::Other(anyhow::anyhow!("status is not a number")))?
                as u16;

            let headers = parse_response_headers(result.get1())?;

            let body = Bytes::from(result.get2().to_vec());

            let mut builder = http::Response::builder().status(status);
            *builder.headers_mut().unwrap() = headers;
            builder.body(body).map_err(|e| HttpError::Other(e.into()))
        }
    }
}

/// Wasm [`SleepCapability`] backed by JS `setTimeout`.
///
/// TraceExporter requires its capability bundle to implement `SleepCapability`
/// (used for retry backoff). Native code uses `tokio::time::sleep`; in wasm we
/// delegate to `setTimeout` via a JS-returned Promise.
impl SleepCapability for DefaultHttpClient {
    fn new() -> Self {
        Self
    }

    #[allow(clippy::manual_async_fn)]
    fn sleep(&self, duration: Duration) -> impl Future<Output = ()> + MaybeSend {
        async move {
            let ms = duration.as_millis() as f64;
            let _ = JsFuture::from(js_sleep(ms)).await;
        }
    }
}

/// Parse response headers from a JS object `{ "header-name": "value", ... }`.
///
/// Node.js `res.headers` returns lowercased header names with string values.
fn parse_response_headers(header_js: Array<JsString>) -> Result<HeaderMap, HttpError> {
    let len = header_js.length() as usize;
    let mut headers = HeaderMap::with_capacity(len / 2);
    for i in 0..(len / 2) {
        let key = header_js.get((i * 2) as u32).as_string();
        let val = header_js.get((i * 2 + 1) as u32).as_string();
        if let (Some(key), Some(val)) = (key, val) {
            // Response headers come from the agent (untrusted over plaintext
            // HTTP); skip any the http crate rejects rather than unwrapping
            // and trapping the whole wasm instance on one malformed header.
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(key.as_bytes()),
                HeaderValue::from_maybe_shared(Bytes::from(val)),
            ) {
                headers.insert(name, value);
            }
        }
    }
    Ok(headers)
}

/// Serialize the full HTTP/1.1 request head (request line + Host + Content-Length
/// + user headers + terminating CRLF) into a contiguous byte buffer.
///
/// The buffer is handed to JS by pointer; JS assigns it to
/// `req._header`, bypassing Node's `_storeHeader` serialization.
fn serialize_request_head(
    req: &http::Request<Bytes>,
    host: &str,
    port: u16,
    is_https: bool,
) -> Result<Vec<u8>, HttpError> {
    let method = req.method().as_str();
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let body_len = req.body().len();
    let headers = req.headers();

    let mut buf = Vec::with_capacity(256 + headers.len() * 64);

    buf.extend_from_slice(method.as_bytes());
    buf.push(b' ');
    buf.extend_from_slice(path_and_query.as_bytes());
    buf.extend_from_slice(b" HTTP/1.1\r\n");

    buf.extend_from_slice(b"Host: ");
    buf.extend_from_slice(host.as_bytes());
    let default_port = if is_https { 443 } else { 80 };
    if port != default_port {
        write!(&mut buf, ":{port}").map_err(|e| HttpError::Other(e.into()))?;
    }
    buf.extend_from_slice(b"\r\n");

    write!(&mut buf, "Content-Length: {body_len}\r\n").map_err(|e| HttpError::Other(e.into()))?;

    for (name, value) in headers.iter() {
        // The request-framing headers above (Host, Content-Length) are
        // authoritative. Skip any caller-supplied duplicates of them (and
        // Transfer-Encoding) so they can't be emitted twice — duplicate/
        // conflicting framing headers are a request-smuggling vector when the
        // agent URL is reached through a proxy.
        if matches!(
            name.as_str(),
            "host" | "content-length" | "transfer-encoding"
        ) {
            continue;
        }
        buf.extend_from_slice(name.as_str().as_bytes());
        buf.extend_from_slice(b": ");
        buf.extend_from_slice(value.as_bytes());
        buf.extend_from_slice(b"\r\n");
    }

    buf.extend_from_slice(b"\r\n");

    Ok(buf)
}
