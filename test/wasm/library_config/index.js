const path = require('path');
const fs = require('fs');
const loader = require('../../../load.js');
const assert = require('assert');

const libconfig = loader.load('library_config');
assert(libconfig !== undefined);

const rawConfigLocal = fs.readFileSync(path.join(__dirname, 'config_local.yaml'));
const rawConfigManaged = fs.readFileSync(path.join(__dirname, 'config_managed.yaml'));
let configurator = new libconfig.JsConfigurator();

configurator.set_envp(Object.entries(process.env).map(([key, value]) => `${key}=${value}`))
configurator.set_args(process.argv)

// Apply each configuration as an environment variable
let values = configurator.get_configuration(rawConfigLocal.toString(), rawConfigManaged.toString())
values.forEach((value, key, map) => {
  console.log(`name: ${value.name}, value: ${value.value}, source: ${value.source}, config_id: ${value.config_id}`)
});

assert.strictEqual(values.length, 1)
assert.strictEqual(values[0].name, 'DD_SERVICE')
assert.strictEqual(values[0].value, 'my-service_butremote')
assert.strictEqual(values[0].source, 'fleet_stable_config')
assert.strictEqual(values[0].config_id, 'abc')

if (process.platform == 'linux') {
  assert.strictEqual(configurator.get_config_local_path(process.platform), "/etc/datadog-agent/application_monitoring.yaml");
} else if (process.platform == 'darwin') {
  assert.strictEqual(configurator.get_config_local_path(process.platform), "/opt/datadog-agent/etc/application_monitoring.yaml");
} else if (process.platform == 'win32') {
  assert.strictEqual(configurator.get_config_local_path(process.platform), "C:\\ProgramData\\Datadog\\application_monitoring.yaml");
}
