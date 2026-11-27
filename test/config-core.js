'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const loader = require('..')

const { JsConfigResolver } = loader.load('config_core')
const resolver = new JsConfigResolver()
const directory = mkdtempSync(path.join(tmpdir(), 'config-core-'))
try {
  const manifest = path.join(directory, 'supported-configurations.json')
  writeFileSync(manifest, JSON.stringify({
    version: '2',
    supportedConfigurations: {
      DD_MODE: [{ type: 'string', default: 'info', allowed: 'info|debug' }],
    },
  }))
  const request = {
    version: 1,
    operation: 'initialize',
    manifest: { kind: 'path', value: manifest },
    inputs: {
      layers: [{
        origin: 'env_var',
        entries: [{ name: 'DD_MODE', value: 'debug' }],
      }],
    },
  }
  const response = resolver.request(Buffer.from(JSON.stringify(request)))
  assert.ok(Buffer.isBuffer(response))
  const snapshot = JSON.parse(response)
  assert.strictEqual(snapshot.status, 'complete')
  assert.deepStrictEqual(snapshot.settings, [{
    name: 'DD_MODE',
    property: 'DD_MODE',
    resolved: {
      value: { kind: 'string', value: 'debug' },
      origin: 'env_var',
      input_name: 'DD_MODE',
    },
  }])

  const resolve = Buffer.from(JSON.stringify({ version: 1, operation: 'resolve', inputs: {} }))
  const defaults = JSON.parse(resolver.request(resolve))
  assert.strictEqual(defaults.status, 'complete')
  assert.deepStrictEqual(defaults.settings[0].resolved, {
    value: { kind: 'string', value: 'info' },
    origin: 'default',
  })
  assert.strictEqual(JSON.parse(new JsConfigResolver().request(resolve)).status, 'error')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
