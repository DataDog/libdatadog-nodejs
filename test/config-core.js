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
      report_sources: true,
      layers: [{
        origin: 'fleet_stable_config',
        entries: [{ name: 'DD_MODE', value: 'debug', config_id: 'fleet-1' }],
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
      origin: 'fleet_stable_config',
      input_name: 'DD_MODE',
      config_id: 'fleet-1',
    },
  }])
  const fleet = snapshot.sources.find(entry => entry.origin === 'fleet_stable_config')
  assert.strictEqual(fleet.config_id, 'fleet-1')

  const resolve = Buffer.from(JSON.stringify({ version: 1, operation: 'resolve', inputs: {} }))
  const defaults = JSON.parse(resolver.request(resolve))
  assert.strictEqual(defaults.status, 'complete')
  assert.deepStrictEqual(defaults.settings[0].resolved, {
    value: { kind: 'string', value: 'info' },
    origin: 'default',
  })
  const oneShot = new JsConfigResolver()
  const oneShotRequest = Buffer.from(JSON.stringify({
    ...request,
    operation: 'resolve_once',
    inputs: { ...request.inputs, skip_defaults: true },
  }))
  assert.deepStrictEqual(JSON.parse(oneShot.request(oneShotRequest)).settings, snapshot.settings)
  assert.strictEqual(JSON.parse(oneShot.request(resolve)).status, 'error')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
