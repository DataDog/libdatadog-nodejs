'use strict'

const assert = require('assert');
const fs = require('fs');
const process = require('process');

const libdatadog = require('..')
const process_discovery = libdatadog.load('process-discovery')
assert(process_discovery !== undefined)

const metadata = new process_discovery.TracerMetadata(
    "7938685c-19dd-490f-b9b3-8aae4c22f897",
    "1.0.0",
    "my_hostname",
    "my_svc",
    "my_env",
    "my_version"
  )

const cfg_handle = process_discovery.storeMetadata(metadata)
assert(cfg_handle !== undefined)

if (process.platform === "linux") {
  const contains_datadog_memfd = (fds) => {
    for (const fd in fds) {
      try {
        const fd_name = fs.readlinkSync(`/proc/${process.pid}/fd/${fd}`);
        if (fd_name.indexOf("datadog-tracer-info-") !== -1) {
            return true;
        }
      } catch {
        continue;
      }
    }
    return false
  };

  const fds = fs.readdirSync(`/proc/${process.pid}/fd`)
  assert(contains_datadog_memfd(fds))
}
