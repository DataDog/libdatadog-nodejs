import * as libconfig from '/Users/baptiste.foy/go/src/github.com/DataDog/libdatadog-nodejs/test/library-config/pkg/library_config.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const rawConfig = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.yaml'));
let configurator = new libconfig.JsConfigurator(false);

configurator.set_envp(Object.entries(process.env).map(([key, value]) => `${key}=${value}`))
configurator.set_args(process.argv)

// Apply each configuration as an environment variable
console.log("Configuration:")
configurator.get_configuration(rawConfig.toString()).forEach((value, key, map) => {
    console.log(` - ${key}: ${value}`)
});
