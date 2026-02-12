const path = require('path');
const fs = require('fs');
const loader = require('../../../load.js');
const assert = require('assert');

const libconfig = loader.load('library_config');
assert(libconfig !== undefined);

// Test 1: phase 1 (host selection)
function test_host_wide() {
  const rawConfigLocal = fs.readFileSync(path.join(__dirname, 'config_local_phase1.yaml'));
  let configurator = new libconfig.JsConfigurator();

  configurator.set_envp(Object.entries(process.env).map(([key, value]) => `${key}=${value}`))
  configurator.set_args(process.argv)

  let values = configurator.get_configuration(rawConfigLocal.toString(), "")
  values.forEach((value, key, map) => {
    console.log(`(phase 1) name: ${value.name}, value: ${value.value}, source: ${value.source}, config_id: ${value.config_id}`)
  });

  assert.strictEqual(values.length, 1)
  assert.strictEqual(values[0].name, 'DD_RUNTIME_METRICS_ENABLED')
  assert.strictEqual(values[0].value, 'true')
  assert.strictEqual(values[0].source, 'local_stable_config')
}

// Test 2: managed > local, phase 2 (service selection)
function test_service_selector() {
  const rawConfigLocal = fs.readFileSync(path.join(__dirname, 'config_local_phase2.yaml'));
  const rawConfigManaged = fs.readFileSync(path.join(__dirname, 'config_managed_phase2.yaml'));
  let configurator = new libconfig.JsConfigurator();

  configurator.set_envp(Object.entries(process.env).map(([key, value]) => `${key}=${value}`))
  configurator.set_args(process.argv)

  values = configurator.get_configuration(rawConfigLocal.toString(), rawConfigManaged.toString())
  values.forEach((value, key, map) => {
    console.log(`(phase 2) name: ${value.name}, value: ${value.value}, source: ${value.source}, config_id: ${value.config_id}`)
  });

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
    assert.strictEqual(configurator.get_config_local_path(process.platform), "/etc/datadog-agent/application_monitoring.yaml");
  } else if (process.platform == 'darwin') {
    assert.strictEqual(configurator.get_config_local_path(process.platform), "/opt/datadog-agent/etc/application_monitoring.yaml");
  } else if (process.platform == 'win32') {
    assert.strictEqual(configurator.get_config_local_path(process.platform), "C:\\ProgramData\\Datadog\\application_monitoring.yaml");
  }
}

test_host_wide();
test_service_selector();
