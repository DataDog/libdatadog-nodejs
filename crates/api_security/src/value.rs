// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

use libdd_api_security::{ScalarType, SchemaSource, SourceKind};
use std::borrow::Cow;
use wasm_bindgen::prelude::*;

// These imports read managed handles. Application operations run inside the
// JS helpers' try/catch and return kind=0 error handles, so foreign exceptions
// do not unwind through Rust or leak partially constructed schemas.
#[wasm_bindgen(module = "/src/value.js")]
extern "C" {
    type Handle;
    #[wasm_bindgen(js_name = root)]
    fn read_root(value: &JsValue) -> Handle;
    #[wasm_bindgen(method, getter)]
    fn kind(this: &Handle) -> u8;
    #[wasm_bindgen(method, getter)]
    fn length(this: &Handle) -> u32;
    #[wasm_bindgen(method, getter)]
    fn error(this: &Handle) -> JsValue;
    fn element(source: &Handle, index: usize) -> Handle;
    fn key(source: &Handle, index: usize) -> String;
    fn field(source: &Handle, index: usize) -> JsValue;
}

pub struct Source {
    handle: Handle,
    kind: u8,
}

impl Source {
    fn checked(handle: Handle) -> Result<Self, JsValue> {
        let kind = handle.kind();
        if kind == 0 {
            Err(handle.error())
        } else {
            Ok(Self { handle, kind })
        }
    }
}

pub fn root(value: &JsValue) -> Result<Source, JsValue> {
    Source::checked(read_root(value))
}

impl SchemaSource<'static> for Source {
    type Error = JsValue;

    fn kind(&self) -> SourceKind {
        match self.kind {
            // u32 fits usize on the supported wasm32 and native test targets.
            32 => SourceKind::Array(self.handle.length() as usize),
            64 => SourceKind::Record(self.handle.length() as usize),
            2 => SourceKind::Scalar(ScalarType::Boolean),
            8 => SourceKind::Scalar(ScalarType::String),
            16 => SourceKind::Scalar(ScalarType::Float),
            _ => SourceKind::Scalar(ScalarType::Null),
        }
    }

    fn element(&self, index: usize) -> Result<Self, Self::Error> {
        Self::checked(element(&self.handle, index))
    }

    fn entry(&self, index: usize) -> Result<(Cow<'static, str>, Option<Self>), Self::Error> {
        let name = key(&self.handle, index);
        let value = if name.is_empty() {
            None
        } else {
            let value = field(&self.handle, index);
            if value.is_undefined() {
                None
            } else {
                Some(Self::checked(value.unchecked_into())?)
            }
        };
        Ok((Cow::Owned(name), value))
    }
}
