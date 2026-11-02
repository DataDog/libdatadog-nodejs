const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const loader = require('../../../load')

const libconfig = loader.load('library_config')
assert(libconfig !== undefined)

// Test 1: phase 1 (host selection)
function test_host_wide () {
  const rawConfigLocal = fs.readFileSync(path.join(__dirname, 'config_local_phase1.yaml'))
  const configurator = new libconfig.JsConfigurator()

  configurator.set_envp(Object.entries(process.env).map(([key, value]) => `${key}=${value}`))
  configurator.set_args(process.argv)

  const values = configurator.get_configuration(rawConfigLocal.toString(), '')
  for (const value of values) {
    console.log(`(phase 1) name: ${value.name}, value: ${value.value}, source: ${value.source}, config_id: ${value.config_id}`)
  }

  assert.strictEqual(values.length, 1)
  assert.strictEqual(values[0].name, 'DD_RUNTIME_METRICS_ENABLED')
  assert.strictEqual(values[0].value, 'true')
  assert.strictEqual(values[0].source, 'local_stable_config')
}

// Test 2: managed > local, phase 2 (service selection)
function test_service_selector () {
  const rawConfigLocal = fs.readFileSync(path.join(__dirname, 'config_local_phase2.yaml'))
  const rawConfigManaged = fs.readFileSync(path.join(__dirname, 'config_managed_phase2.yaml'))
  const configurator = new libconfig.JsConfigurator()

  configurator.set_envp(Object.entries(process.env).map(([key, value]) => `${key}=${value}`))
  configurator.set_args(process.argv)

  const values = configurator.get_configuration(rawConfigLocal.toString(), rawConfigManaged.toString())
  for (const value of values) {
    console.log(`(phase 2) name: ${value.name}, value: ${value.value}, source: ${value.source}, config_id: ${value.config_id}`)
  }

  assert.strictEqual(values.length, 2)
  // We can't rely on ordering, so sort it by name to make it deterministic
  values.sort((a, b) => a.name.localeCompare(b.name))
  assert.strictEqual(values[0].name, 'DD_RUNTIME_METRICS_ENABLED')
  assert.strictEqual(values[0].value, 'true')
  assert.strictEqual(values[0].source, 'local_stable_config')
  assert.strictEqual(values[1].name, 'DD_SERVICE')
  assert.strictEqual(values[1].value, 'my-service_butremote')
  assert.strictEqual(values[1].source, 'fleet_stable_config')

  if (process.platform == 'linux') {
    assert.strictEqual(configurator.get_config_local_path(process.platform), '/etc/datadog-agent/application_monitoring.yaml')
  } else if (process.platform == 'darwin') {
    assert.strictEqual(configurator.get_config_local_path(process.platform), '/opt/datadog-agent/etc/application_monitoring.yaml')
  } else if (process.platform == 'win32') {
    assert.strictEqual(configurator.get_config_local_path(process.platform), String.raw`C:\ProgramData\Datadog\application_monitoring.yaml`)
  }
}

test_host_wide()
test_service_selector()

function test_configuration_inputs () {
  const configurator = new libconfig.JsConfigurator()
  const local = 'config_id: local\napm_configuration_default:\n  DD_SERVICE: local-service'
  const managed = 'config_id: managed\napm_configuration_default:\n  DD_SERVICE: fleet-サービス'

  for (const [localInput, managedInput, expected] of [
    ['', '', []],
    [local, '', [['local-service', 'local_stable_config', 'local']]],
    ['', managed, [['fleet-サービス', 'fleet_stable_config', 'managed']]],
    [local, managed, [['fleet-サービス', 'fleet_stable_config', 'managed']]],
  ]) {
    const entries = configurator.get_configuration(localInput, managedInput)
    assert.strictEqual(entries.length, expected.length)
    for (const [i, entry] of entries.entries()) {
      assert.strictEqual(entry.name, 'DD_SERVICE')
      assert.strictEqual(entry.value, expected[i][0])
      assert.strictEqual(entry.source, expected[i][1])
      assert.strictEqual(entry.config_id, expected[i][2])
    }
  }

  for (const [localInput, managedInput] of [['[', ''], ['', '[']]) {
    assert.throws(
      () => configurator.get_configuration(localInput, managedInput),
      /Failed to get configuration:/,
    )
  }
}

test_configuration_inputs()
