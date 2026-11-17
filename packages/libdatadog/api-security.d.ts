export { extractSchemaJson } from '@datadog/libdatadog-wasm/api-security'

/**
 * Extract from selected JavaScript values; ignored tails are not read or validated.
 * Visited getters/toJSON hooks may run and throw. Scalars are discarded.
 */
export function extractSchema(input: unknown): unknown[]

/**
 * Extract schema JSON from selected JavaScript values, without materializing a JS schema tree.
 * Uses the same bounded reads, errors and numeric/length semantics as extractSchema.
 * Object fields and array variants are semantically equivalent; ordering may differ.
 */
export function extractSchemaSerialized(input: unknown): string
