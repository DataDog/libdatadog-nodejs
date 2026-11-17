// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Synchronous WASM adapter for the shared structural schema engine.

use wasm_bindgen::prelude::*;

/// Extract a structural schema from JSON and return compact schema JSON.
///
/// Property names, types, array lengths and truncation flags are retained.
/// Scalar values are discarded. Sampling and input collection belong to the caller.
/// Throws an Error if input parsing or output serialization fails.
#[wasm_bindgen(js_name = extractSchemaJson)]
pub fn extract_schema_json(input: &str) -> Result<String, JsError> {
    libdd_api_security::extract_schema_json(input).map_err(|error| JsError::new(&error.to_string()))
}

mod value;

/// Extract from JavaScript without serializing scalar values or ignored tails.
/// Application errors in visited values propagate to the caller.
#[wasm_bindgen(js_name = extractSchema)]
pub fn extract_schema(input: JsValue) -> Result<String, JsValue> {
    let schema = libdd_api_security::extract_schema_from_source(
        &value::root(&input)?,
        libdd_api_security::SchemaOptions {
            numbers_as_float: true,
            array_length_limit: Some(256),
        },
    )?;
    serde_json::to_string(&schema).map_err(|error| JsError::new(&error.to_string()).into())
}
