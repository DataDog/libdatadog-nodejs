const path = require('path');
const fs = require('fs');
const loader = require('../../load.js');

const libconfig = loader.maybeLoadWASM('library_config');

const rawConfig = fs.readFileSync(path.join(__dirname, 'config.yaml'));
let configurator = new libconfig.JsConfigurator();

configurator.set_envp(Object.entries(process.env).map(([key, value]) => `${key}=${value}`))
configurator.set_args(process.argv)

// Apply each configuration as an environment variable
console.log("Configuration:")
configurator.get_configuration(rawConfig.toString()).forEach((value, key, map) => {
    console.log(` - ${key}: ${value}`)
});
