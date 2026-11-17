'use strict'

/* eslint-disable unicorn/no-array-sort -- Array#toSorted is unavailable on supported Node.js 18. */

// Only schema variants are unordered; metadata and key/type associations matter.
function canonicalSchema (schema) {
  const [value, ...rawMetadata] = schema
  const metadata = rawMetadata.map(entry => Object.fromEntries(
    Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)),
  ))
  if (Array.isArray(value)) {
    const variants = value.map(child => JSON.stringify(canonicalSchema(child)))
    variants.sort((left, right) => left.localeCompare(right))
    return [variants, ...metadata]
  }
  if (value !== null && typeof value === 'object') {
    return [Object.fromEntries(
      Object.keys(value).sort((left, right) => left.localeCompare(right)).map(key => [key, canonicalSchema(value[key])]),
    ), ...metadata]
  }
  return schema
}

module.exports = { canonicalSchema }
