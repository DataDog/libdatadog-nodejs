'use strict'

// The shim is plain CommonJS, so drive it directly.

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const filesystem = require('../crates/capabilities/src/filesystem')

describe('filesystem', () => {
  let tmp
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libdd-file-'))
  })
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('writes and reads a file round-trip', async () => {
    const p = path.join(tmp, 'hello.bin')
    await filesystem.writeFile(p, Buffer.from('hello'))
    const got = await filesystem.readFile(p)
    assert.strictEqual(Buffer.from(got).toString('utf8'), 'hello')
  })

  it('readFile on a missing path rejects with ENOENT', async () => {
    const p = path.join(tmp, 'does-not-exist')
    await assert.rejects(filesystem.readFile(p), error => error && error.code === 'ENOENT')
  })

  it('metadata reports size, kind, and a positive inode', async () => {
    const p = path.join(tmp, 'meta.bin')
    fs.writeFileSync(p, '0123456789')
    const m = await filesystem.metadata(p)
    assert.strictEqual(m.size, 10n)
    assert.strictEqual(m.is_file, true)
    assert.strictEqual(m.is_dir, false)
    assert.ok(m.inode > 0n, `expected positive inode, got ${m.inode}`)
  })

  it('exists returns true for a present path and false for a missing one', async () => {
    const present = path.join(tmp, 'here')
    fs.writeFileSync(present, '')
    const absent = path.join(tmp, 'gone')
    assert.strictEqual(await filesystem.exists(present), true)
    assert.strictEqual(await filesystem.exists(absent), false)
  })
})
