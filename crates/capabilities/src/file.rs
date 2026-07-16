// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Wasm implementation of [`FileCapability`] backed by Node.js `fs`.
//!
//! The JS transport is imported via `wasm_bindgen(module = ...)` from
//! `file_transport.js`, which ships alongside the wasm output.

use std::future::Future;

use bytes::Bytes;
use js_sys::{self, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use libdd_capabilities::file::{FileCapability, FileError, FileMetadata};
use libdd_capabilities::maybe_send::MaybeSend;

#[wasm_bindgen(module = "/src/file_transport.js")]
extern "C" {
    #[wasm_bindgen(js_name = "readFile", catch)]
    fn js_read_file(path: &str) -> Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(js_name = "writeFile", catch)]
    fn js_write_file(path: &str, data: &[u8]) -> Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(js_name = "metadata", catch)]
    fn js_metadata(path: &str) -> Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(js_name = "exists", catch)]
    fn js_exists(path: &str) -> Result<js_sys::Promise, JsValue>;
}

#[derive(Debug, Clone)]
pub struct WasmFileCapability;

impl FileCapability for WasmFileCapability {
    fn new() -> Self {
        Self
    }

    #[allow(clippy::manual_async_fn)]
    fn read(&self, path: &str) -> impl Future<Output = Result<Bytes, FileError>> + MaybeSend {
        let path = path.to_owned();
        async move {
            let promise =
                js_read_file(&path).map_err(|e| map_js_error(&e, &path))?;
            let value = JsFuture::from(promise)
                .await
                .map_err(|e| map_js_error(&e, &path))?;
            let array = Uint8Array::new(&value);
            Ok(Bytes::from(array.to_vec()))
        }
    }

    #[allow(clippy::manual_async_fn)]
    fn write(
        &self,
        path: &str,
        contents: Bytes,
    ) -> impl Future<Output = Result<(), FileError>> + MaybeSend {
        let path = path.to_owned();
        async move {
            let promise = js_write_file(&path, &contents)
                .map_err(|e| map_js_error(&e, &path))?;
            JsFuture::from(promise)
                .await
                .map_err(|e| map_js_error(&e, &path))?;
            Ok(())
        }
    }

    #[allow(clippy::manual_async_fn)]
    fn metadata(
        &self,
        path: &str,
    ) -> impl Future<Output = Result<FileMetadata, FileError>> + MaybeSend {
        let path = path.to_owned();
        async move {
            let promise =
                js_metadata(&path).map_err(|e| map_js_error(&e, &path))?;
            let value = JsFuture::from(promise)
                .await
                .map_err(|e| map_js_error(&e, &path))?;
            parse_metadata(&value, &path)
        }
    }

    #[allow(clippy::manual_async_fn)]
    fn exists(&self, path: &str) -> impl Future<Output = Result<bool, FileError>> + MaybeSend {
        let path = path.to_owned();
        async move {
            let promise = js_exists(&path).map_err(|e| map_js_error(&e, &path))?;
            let value = JsFuture::from(promise)
                .await
                .map_err(|e| map_js_error(&e, &path))?;
            value
                .as_bool()
                .ok_or_else(|| FileError::Io(anyhow::anyhow!("exists({path}) did not return a boolean")))
        }
    }
}

fn map_js_error(err: &JsValue, path: &str) -> FileError {
    let code = Reflect::get(err, &JsValue::from_str("code"))
        .ok()
        .and_then(|v| v.as_string());
    match code.as_deref() {
        Some("ENOENT") => FileError::NotFound(path.to_owned()),
        Some("EACCES") | Some("EPERM") => FileError::PermissionDenied(path.to_owned()),
        _ => {
            let message = Reflect::get(err, &JsValue::from_str("message"))
                .ok()
                .and_then(|v| v.as_string())
                .unwrap_or_else(|| format!("{err:?}"));
            FileError::Io(anyhow::anyhow!("{message} (path: {path})"))
        }
    }
}

fn parse_metadata(value: &JsValue, path: &str) -> Result<FileMetadata, FileError> {
    let size = read_bigint_u64(value, "size", path)?;
    // Node populates `stat().ino` on every platform, so `inode` is always Some.
    let inode = Some(read_bigint_u64(value, "inode", path)?);
    let is_file = read_bool(value, "is_file", path)?;
    let is_dir = read_bool(value, "is_dir", path)?;
    Ok(FileMetadata {
        size,
        inode,
        is_file,
        is_dir,
    })
}

fn read_bigint_u64(value: &JsValue, key: &str, path: &str) -> Result<u64, FileError> {
    let v = Reflect::get(value, &JsValue::from_str(key))
        .map_err(|_| FileError::Io(anyhow::anyhow!("metadata({path}) missing field `{key}`")))?;
    let bigint = js_sys::BigInt::try_from(v)
        .map_err(|_| FileError::Io(anyhow::anyhow!("metadata({path}) field `{key}` is not a BigInt")))?;
    u64::try_from(bigint)
        .map_err(|_| FileError::Io(anyhow::anyhow!("metadata({path}) field `{key}` overflows u64")))
}

fn read_bool(value: &JsValue, key: &str, path: &str) -> Result<bool, FileError> {
    Reflect::get(value, &JsValue::from_str(key))
        .ok()
        .and_then(|v| v.as_bool())
        .ok_or_else(|| {
            FileError::Io(anyhow::anyhow!(
                "metadata({path}) is missing boolean field `{key}`"
            ))
        })
}
