// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm implementation of [`HttpClientCapability`] backed by Node.js `http.request`.
//!
//! The JS transport is imported via `wasm_bindgen(module = ...)` from
//! `http_transport.js`, which ships alongside the wasm output.

use std::future::Future;
use std::io::Write as _;
use std::sync::LazyLock;

use bytes::Bytes;
use http::{HeaderMap, HeaderName, HeaderValue};
use js_sys::{self, Array, JsString, Number, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use libdd_capabilities::http::{HttpClientCapability, HttpError};
use libdd_capabilities::maybe_send::MaybeSend;

// A `static` requires `Sync`, and `LazyLock<JsValue>: Sync` needs `JsValue:
// Sync` — which holds only because on wasm32 (single-threaded) wasm-bindgen
// implements `Send`/`Sync` for `JsValue`. This crate is wasm32-only, so it's sound.
static WASM_MEMORY: LazyLock<JsValue> = LazyLock::new(wasm_bindgen::memory);

#[wasm_bindgen(module = "/src/http_transport.js")]
extern "C" {
    #[wasm_bindgen(js_name = "httpRequest")]
    fn http_request(
        host: &str,
        port: u16,
        is_https: bool,
        socket_path: &str,
        head_ptr: *const u8,
        head_len: u32,
        body_ptr: *const u8,
        body_len: u32,
        wasm_memory: &JsValue,
    ) -> js_sys::Promise;

    #[wasm_bindgen(js_name = "setStorage")]
    pub fn set_storage(new_storage: &JsValue);

    #[wasm_bindgen(js_name = "setResponseHeaderObserver")]
    pub fn set_response_header_observer(observer: &JsValue);
}

/// Wasm [`HttpClientCapability`] that delegates HTTP to Node.js `http.request`.
///
/// The wasm analogue of libdatadog's native `NativeHttpClient`. Bundled into
/// [`crate::WasmCapabilities`] alongside the sleep and log-output capabilities
/// that `TraceExporter` requires.
#[derive(Debug, Clone)]
pub struct WasmHttpClient;

impl HttpClientCapability for WasmHttpClient {
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

            // Unix domain socket / Windows named pipe: ddcommon's `parse_uri`
            // hex-encodes the socket path into the URI authority (there is no
            // standard URL form for socket paths). On wasm the request bypasses
            // ddcommon's native (hyper) connector and reaches us directly, so we
            // decode the path here and route over the socket instead of TCP.
            let (host, port, is_https, socket_path) = if scheme == "unix" || scheme == "windows" {
                (String::new(), 0u16, false, decode_socket_path(req.uri())?)
            } else {
                let is_https = scheme == "https";
                let host = req.uri().host().ok_or_else(|| {
                    HttpError::InvalidRequest(anyhow::anyhow!("missing host in URI"))
                })?;
                let port = req
                    .uri()
                    .port_u16()
                    .unwrap_or(if is_https { 443 } else { 80 });
                (host.to_owned(), port, is_https, String::new())
            };

            // For a socket request there is no meaningful network host; HTTP/1.1
            // still requires a Host header, so send a stable placeholder (the
            // agent does not validate Host over a socket).
            let head = if socket_path.is_empty() {
                serialize_request_head(&req, &host, port, is_https, false)?
            } else {
                serialize_request_head(&req, "localhost", port, is_https, true)?
            };
            let body = req.into_body();

            let result = JsFuture::from(http_request(
                &host,
                port,
                is_https,
                &socket_path,
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
            // `headers_mut()` is `None` only when the builder already holds an
            // error (e.g. an out-of-range status from the agent). Don't unwrap:
            // skip the headers and let `body()` below surface that error.
            if let Some(builder_headers) = builder.headers_mut() {
                *builder_headers = headers;
            }
            builder.body(body).map_err(|e| HttpError::Other(e.into()))
        }
    }
}

/// Parse response headers from Node's flat `[name, value, name, value, ...]`
/// array (`res.rawHeaders`): even indices are (lowercased) header names, odd
/// indices their string values.
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

/// Decode the socket path that ddcommon's `parse_uri` hex-encoded into the URI
/// authority for `unix://` / `windows:` agent URLs (see `encode_uri_path_in_authority`
/// in libdd-common). The authority is the lowercase hex of the raw path bytes.
fn decode_socket_path(uri: &http::Uri) -> Result<String, HttpError> {
    let authority = uri
        .authority()
        .ok_or_else(|| HttpError::InvalidRequest(anyhow::anyhow!("socket URI missing authority")))?
        .as_str();
    let bytes = hex_decode(authority).ok_or_else(|| {
        HttpError::InvalidRequest(anyhow::anyhow!("socket path authority is not valid hex"))
    })?;
    String::from_utf8(bytes)
        .map_err(|e| HttpError::InvalidRequest(anyhow::anyhow!("socket path is not utf-8: {e}")))
}

/// Minimal hex decoder for the socket-path authority. Returns `None` on any
/// malformed input (odd length or non-hex digit) rather than panicking.
fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let bytes = s.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}

/// Serialize the full HTTP/1.1 request head (request line + Host + Content-Length
/// + user headers + terminating CRLF) into a contiguous byte buffer.
///
/// The buffer is handed to JS by pointer; JS assigns it to
/// `req._header`, bypassing Node's `_storeHeader` serialization.
///
/// `is_socket` requests (unix socket / named pipe) omit the `:port` suffix on
/// the Host header — there is no TCP port for a socket transport.
fn serialize_request_head(
    req: &http::Request<Bytes>,
    host: &str,
    port: u16,
    is_https: bool,
    is_socket: bool,
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
    if !is_socket {
        let default_port = if is_https { 443 } else { 80 };
        if port != default_port {
            write!(&mut buf, ":{port}").map_err(|e| HttpError::Other(e.into()))?;
        }
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
