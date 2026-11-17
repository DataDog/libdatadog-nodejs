/* eslint-disable unicorn/filename-case -- This snippet follows its existing Rust crate's directory name. */
// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0
'use strict'

/* eslint-disable unicorn/no-null -- Null is a JSON scalar and the end of the ancestor chain. */

const { types } = require('node:util')

// Source handles keep JavaScript values in JavaScript. Rust requests only
// selected children; scalar string contents never cross the WASM boundary.

/** @param {unknown} value @param {string} key @param {object|null} parent */
function prepare (value, key, parent) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function' || typeof value === 'bigint')) {
    const toJSON = value.toJSON
    if (typeof toJSON === 'function') value = toJSON.call(value, key)
  }
  if (value !== null && typeof value === 'object' && types.isBoxedPrimitive(value)) {
    if (types.isNumberObject(value)) value = Number(value)
    else if (types.isStringObject(value)) value = String(value)
    else if (types.isBooleanObject(value)) value = Boolean.prototype.valueOf.call(value)
    else if (types.isBigIntObject(value)) throw new TypeError('Cannot collect a BigInt schema')
  }

  let kind
  if (value === null) kind = 1
  else if (typeof value === 'boolean') kind = 2
  else if (typeof value === 'number') kind = Number.isFinite(value) ? 16 : 1
  else if (typeof value === 'string') kind = 8
  else if (typeof value === 'bigint') throw new TypeError('Cannot collect a BigInt schema')
  else if (typeof value === 'object') {
    kind = Array.isArray(value) ? 32 : 64
  } else {
    return
  }

  if (kind >= 32) {
    for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.value === value) throw new TypeError('Cannot collect a circular schema')
    }
  }
  const keys = kind === 64 ? Object.keys(value) : null
  return { kind, value, keys, parent, length: kind === 32 ? value.length : (keys?.length ?? 0) }
}

// Capture application exceptions here, using stable functions. wasm-bindgen's
// catch imports create a fresh callback per access, triggering repeated V8
// optimization. Error handles let Rust return normally and drop partial schemas.

/** @param {unknown} value */
exports.root = function root (value) {
  try {
    const source = prepare(value, '', null)
    if (source === undefined) throw new TypeError('API Security input must be a JSON value')
    return source
  } catch (error) {
    return { kind: 0, error }
  }
}

/** @param {object} source @param {number} index */
exports.element = function element (source, index) {
  try {
    return prepare(source.value[index], String(index), source) ?? prepare(null, '', null)
  } catch (error) {
    return { kind: 0, error }
  }
}

/** @param {object} source @param {number} index */
exports.key = function key (source, index) {
  // This reads an internal key snapshot, never an application object.
  return source.keys[index]
}

/** @param {object} source @param {number} index */
exports.field = function field (source, index) {
  try {
    const key = source.keys[index]
    // Rust strings cannot preserve an unpaired UTF-16 surrogate in a key.
    if (/[\uD800-\uDFFF]/u.test(key)) throw new TypeError('Invalid Unicode property name')
    return prepare(source.value[key], key, source)
  } catch (error) {
    return { kind: 0, error }
  }
}
