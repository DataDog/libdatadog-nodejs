const path = require('path');
const fs = require('fs');
const loader = require('../../../load.js');
const assert = require('assert');

const libconfig = loader.load('library_config');
assert(libconfig !== undefined);

const rawConfig = fs.readFileSync(path.join(__dirname, 'config.yaml'));
let configurator = new libconfig.JsConfigurator();

configurator.set_envp(Object.entries(process.env).map(([key, value]) => `${key}=${value}`))
configurator.set_args(process.argv)

// Apply each configuration as an environment variable
let values = {}
configurator.get_configuration(rawConfig.toString()).forEach((value, key, map) => {
    values[key] = value
    console.log(`Got ${key}=${value}`)
});

assert.strictEqual(values['DD_SERVICE'], 'my-service')
