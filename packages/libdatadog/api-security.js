'use strict'

const binding = require('@datadog/libdatadog-wasm/api-security')

/**
 * Extract a structural schema from JSON, without retaining scalar values.
 *
 * @param {string} input JSON text; the caller owns sampling and input conversion.
 * @returns {string} Compact schema JSON.
 */
function extractSchemaJson (input) {
  if (typeof input !== 'string') {
    throw new TypeError('API Security input must be a JSON string')
  }
  return binding.extractSchemaJson(input)
}

/**
 * Extract from visited JavaScript values with bounded schema selection.
 * Ignored tails are not read or validated; visited application errors propagate.
 *
 * @param {unknown} input
 * @returns {unknown[]} Structural schema with native-appsec's JavaScript number and array length semantics.
 */
function extractSchema (input) {
  return orderVariants(JSON.parse(binding.extractSchema(input)))
}

/** @param {unknown[]} schema */
function orderVariants (schema) {
  const value = schema[0]
  if (Array.isArray(value)) {
    for (const child of value) orderVariants(child)
    // Rust already normalizes numbers/lengths and deduplicates. Only the
    // existing JS wire ordering needs preserving for heterogeneous arrays.
    if (value.length > 1) {
      const variants = value.map(child => [JSON.stringify(child), child])
      // Support Node.js 18 and preserve exact UTF-16 ordering.

      variants.sort(([left], [right]) => left < right ? -1 : (left > right ? 1 : 0))
      schema[0] = variants.map(([, child]) => child)
    }
  } else if (typeof value === 'object') {
    for (const child of Object.values(value)) orderVariants(child)
  }
  return schema
}

/**
 * Extract a compact JSON schema from selected JavaScript values.
 * This avoids creating a JavaScript schema tree when the caller needs JSON.
 * Object fields and array variants may have a different order from extractSchema.
 *
 * @param {unknown} input
 * @returns {string} Schema JSON, with the same selection and number/length semantics as extractSchema.
 */
function extractSchemaSerialized (input) {
  return binding.extractSchema(input)
}

module.exports = { extractSchemaJson, extractSchema, extractSchemaSerialized }
