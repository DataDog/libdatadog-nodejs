// Match offsets returned to Rust are UTF-8 byte offsets; JS `RegExp.exec`
// returns UTF-16 code-unit indices, so we translate here.

'use strict'

// UTF-8 encoding thresholds (max code point + 1 for each byte-length class).
const ONE_BYTE_MAX = 0x80 // U+0000..U+007F  → 1 byte
const TWO_BYTE_MAX = 0x8_00 // U+0080..U+07FF  → 2 bytes
// UTF-16 surrogate ranges. A high+low pair encodes one supplementary code
// point (U+10000..U+10FFFF) into 4 UTF-8 bytes.
const HIGH_SURROGATE_MIN = 0xD8_00
const HIGH_SURROGATE_MAX = 0xDB_FF
const LOW_SURROGATE_MIN = 0xDC_00
const LOW_SURROGATE_MAX = 0xDF_FF

// UTF-8 byte cost of the single code unit at `hay[i]`.
// A surrogate pair encodes as 4 UTF-8 bytes but spans two code-unit
// positions; we split those 4 bytes evenly (2 for the high half, 2 for the
// low half) so mid-pair positions get a distinct, monotonic byte offset.
// Lone surrogates count as 3 bytes (WTF-8 style, matching how Node's UTF-8
// encoder replaces unpaired surrogates with U+FFFD).
/* eslint-disable unicorn/prefer-code-point */
function cuBytes (hay, i, len) {
  const cu = hay.charCodeAt(i)
  if (cu < ONE_BYTE_MAX) return 1
  if (cu < TWO_BYTE_MAX) return 2
  if (cu >= HIGH_SURROGATE_MIN && cu <= HIGH_SURROGATE_MAX) {
    if (i + 1 < len) {
      const low = hay.charCodeAt(i + 1)
      if (low >= LOW_SURROGATE_MIN && low <= LOW_SURROGATE_MAX) return 2
    }
    return 3 // lone high surrogate
  }
  if (cu >= LOW_SURROGATE_MIN && cu <= LOW_SURROGATE_MAX) {
    if (i > 0) {
      const high = hay.charCodeAt(i - 1)
      if (high >= HIGH_SURROGATE_MIN && high <= HIGH_SURROGATE_MAX) return 2
    }
    return 3 // lone low surrogate
  }
  return 3 // BMP ≥ U+0800
}

// Advance the walker `state` (`i`: code-unit position, `byte`: UTF-8 byte
// offset at that position) forward one code unit at a time until `i` reaches
// `target`. Stepping CU-by-CU (rather than treating a surrogate pair as one
// atomic step) keeps state consistent when `target` lands mid-pair.
function walkTo (hay, state, target) {
  const len = hay.length
  let i = state.i
  let byte = state.byte
  while (i < target) {
    byte += cuBytes(hay, i, len)
    i += 1
  }
  state.i = i
  state.byte = byte
}

// `g` is required to iterate all matches with exec; `d` is required for the
// per-group indices used by `capturesAll`.
module.exports.compile = function (pattern) {
  return new RegExp(pattern, 'gd')
}

module.exports.isMatch = function (re, hay) {
  re.lastIndex = 0
  const m = re.exec(hay)
  re.lastIndex = 0
  return m !== null
}

module.exports.findFirst = function (re, hay) {
  re.lastIndex = 0
  const m = re.exec(hay)
  re.lastIndex = 0
  if (m === null) return new Int32Array(0)
  const state = { i: 0, byte: 0 }
  walkTo(hay, state, m.index)
  const byteStart = state.byte
  walkTo(hay, state, m.index + m[0].length)
  return Int32Array.of(byteStart, state.byte)
}

// Flat [s0, e0, s1, e1, ...] of UTF-8 byte offsets. One forward pass through
// the haystack, threading through all matches in order — no offset map.
module.exports.findAll = function (re, hay) {
  re.lastIndex = 0
  const out = []
  const state = { i: 0, byte: 0 }
  let m
  while ((m = re.exec(hay)) !== null) {
    walkTo(hay, state, m.index)
    const byteStart = state.byte
    walkTo(hay, state, m.index + m[0].length)
    out.push(byteStart, state.byte)
    if (m[0].length === 0) re.lastIndex++ // zero-width match: force progress
  }
  re.lastIndex = 0
  return Int32Array.from(out)
}

// Flat [groupCount, matchCount, s0_0, e0_0, ..., s0_g, e0_g, s1_0, e1_0, ...]
// with (-1, -1) for absent groups. `groupCount` is the total slots per match
// (1 + number of capture groups). Empty result encodes as [0, 0].
module.exports.capturesAll = function (re, hay) {
  re.lastIndex = 0
  const out = [0, 0] // header slots; filled in after the scan
  const state = { i: 0, byte: 0 }
  const len = hay.length
  let groupCount = 0
  let matchCount = 0
  let m
  while ((m = re.exec(hay)) !== null) {
    if (matchCount === 0) groupCount = m.length
    matchCount++
    const matchStart = m.index
    const matchEnd = matchStart + m[0].length
    walkTo(hay, state, matchStart)
    // Group endpoints within a match may be out of order (nested groups), so
    // resolve them via a small local map covering just this match's range.
    const local = new Uint32Array(matchEnd - matchStart + 1)
    let i = state.i
    let byte = state.byte
    while (i < matchEnd) {
      local[i - matchStart] = byte
      byte += cuBytes(hay, i, len)
      i += 1
    }
    local[matchEnd - matchStart] = byte
    state.i = i
    state.byte = byte
    for (let g = 0; g < groupCount; g++) {
      const idx = m.indices[g]
      if (idx === undefined) out.push(-1, -1)
      else out.push(local[idx[0] - matchStart], local[idx[1] - matchStart])
    }
    if (m[0].length === 0) re.lastIndex++
  }
  re.lastIndex = 0
  out[0] = groupCount
  out[1] = matchCount
  return Int32Array.from(out)
}
