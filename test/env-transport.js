'use strict'

// The transport shim is plain CommonJS, so drive it directly.

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')

const envTransport = require('../crates/capabilities/src/env_transport')

describe('env_transport', () => {
  const NAME = 'LIBDD_CAP_TEST_ENV_TRANSPORT'
  let savedValue

  before(() => {
    savedValue = process.env[NAME]
  })
  after(() => {
    if (savedValue === undefined) delete process.env[NAME]
    else process.env[NAME] = savedValue
  })

  it('returns undefined for an unset var', () => {
    delete process.env[NAME]
    assert.strictEqual(envTransport.get(NAME), undefined)
  })

  it('returns the value when the var is set', () => {
    process.env[NAME] = 'value1'
    assert.strictEqual(envTransport.get(NAME), 'value1')
  })
})
