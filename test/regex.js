'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')

const regex = require('../crates/capabilities/src/regex')

const utf8Len = s => Buffer.byteLength(s, 'utf8')

describe('regex', () => {
  it('findFirst — pure ASCII', () => {
    assert.deepStrictEqual([...regex.findFirst(regex.compile(String.raw`\d+`), 'abc123def')], [3, 6])
  })

  it('findFirst — no match returns empty', () => {
    assert.strictEqual(regex.findFirst(regex.compile('z'), 'abc').length, 0)
  })

  it('findFirst — 2-byte UTF-8 (é) precedes the match', () => {
    const hay = 'café☕end'
    const [s, e] = regex.findFirst(regex.compile('end'), hay)
    assert.strictEqual(s, utf8Len('café☕'))
    assert.strictEqual(e, utf8Len('café☕end'))
  })

  it('findFirst — 3-byte CJK haystack', () => {
    const hay = 'hello 你好 world'
    assert.deepStrictEqual([...regex.findFirst(regex.compile('你好'), hay)],
      [utf8Len('hello '), utf8Len('hello 你好')])
  })

  it('findFirst — match spans a surrogate pair (4-byte UTF-8)', () => {
    // 😀 = U+1F600, 4 UTF-8 bytes.
    const hay = 'abc😀def'
    assert.deepStrictEqual([...regex.findFirst(regex.compile('😀'), hay)],
      [3, 3 + 4])
  })

  it('findFirst — ZWJ family emoji (mixed surrogate pairs + 3-byte ZWJ)', () => {
    // 👨‍👩‍👧 = 👨 (4B) + ZWJ (3B) + 👩 (4B) + ZWJ (3B) + 👧 (4B) = 18 UTF-8 bytes.
    const family = '👨‍👩‍👧'
    const hay = 'hi ' + family + ' bye'
    assert.strictEqual(utf8Len(family), 18)
    assert.deepStrictEqual([...regex.findFirst(regex.compile('bye'), hay)],
      [3 + 18 + 1, 3 + 18 + 1 + 3])
  })

  it('findFirst — haystack starts with non-ASCII (empty ASCII prefix)', () => {
    const hay = '🌸🌸abc'
    assert.deepStrictEqual([...regex.findFirst(regex.compile('abc'), hay)],
      [8, 11])
  })

  it('findFirst — combining mark does not confuse offsets', () => {
    // "e" + U+0301 (combining acute) = 3 UTF-8 bytes.
    const hay = 'e\u0301xt'
    assert.deepStrictEqual([...regex.findFirst(regex.compile('xt'), hay)],
      [3, 5])
  })

  it('findAll — multiple matches interleaved with multi-byte chars', () => {
    // 你 is 3 bytes.
    const hay = 'a你b你c'
    assert.deepStrictEqual([...regex.findAll(regex.compile('[abc]'), hay)],
      [0, 1, 4, 5, 8, 9])
  })

  it('findAll — zero-width lookahead produces empty matches', () => {
    assert.deepStrictEqual([...regex.findAll(regex.compile('(?=a)'), 'aaa')],
      [0, 0, 1, 1, 2, 2])
  })

  it('findAll — no matches on non-ASCII input', () => {
    assert.strictEqual(regex.findAll(regex.compile('z'), '你好世界').length, 0)
  })

  it('findAll — zero-width matches across a surrogate pair do not collapse', () => {
    // "a😀b": 'a'=byte 0, 😀=bytes 1-4, 'b'=byte 5.
    // (?=) fires at every code-unit boundary (5 positions in JS).
    // The mid-surrogate position must not collapse onto the byte offset of 'b'.
    const hay = 'a😀b'
    const out = [...regex.findAll(regex.compile('(?=)'), hay)]
    assert.strictEqual(out.length, 10, 'expected 5 zero-width matches')
    assert.deepStrictEqual(out.slice(0, 4), [0, 0, 1, 1], 'positions 0 and 1')
    assert.deepStrictEqual(out.slice(6), [5, 5, 6, 6], 'positions 3 and 4')
    assert.notStrictEqual(out[4], out[6],
      `mid-pair position 2 (byte=${out[4]}) collapsed onto position 3 (byte=${out[6]})`)
  })

  it('isMatch — true and false', () => {
    assert.strictEqual(regex.isMatch(regex.compile('好'), '你好'), true)
    assert.strictEqual(regex.isMatch(regex.compile('z'), '你好'), false)
  })

  it('capturesAll — nested groups with non-monotonic endpoints', () => {
    // "(a(b))(c)" on "abc": g0=[0,3], g1=[0,2], g2=[1,2], g3=[2,3].
    assert.deepStrictEqual([...regex.capturesAll(regex.compile('(a(b))(c)'), 'abc')],
      [4, 1, 0, 3, 0, 2, 1, 2, 2, 3])
  })

  it('capturesAll — absent group under alternation encodes as (-1, -1)', () => {
    assert.deepStrictEqual([...regex.capturesAll(regex.compile('(a)|(b)'), 'ab')],
      [3, 2, 0, 1, 0, 1, -1, -1, 1, 2, -1, -1, 1, 2])
  })

  it('capturesAll — group spanning multi-byte content', () => {
    const hay = 'prefix日本postfix'
    const bStart = utf8Len('prefix')
    const bEnd = utf8Len('prefix日本')
    assert.deepStrictEqual([...regex.capturesAll(regex.compile('(日本)'), hay)],
      [2, 1, bStart, bEnd, bStart, bEnd])
  })

  it('capturesAll — no matches encodes as [0, 0]', () => {
    assert.deepStrictEqual([...regex.capturesAll(regex.compile('z'), 'abc')],
      [0, 0])
  })
})
