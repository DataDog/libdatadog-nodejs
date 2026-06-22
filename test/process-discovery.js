'use strict'

const assert = require('node:assert')
const fs = require('node:fs')
const process = require('node:process')

const libdatadog = require('..')
const process_discovery = libdatadog.load('process-discovery')
assert(process_discovery !== undefined)

const metadata = new process_discovery.TracerMetadata(
  '7938685c-19dd-490f-b9b3-8aae4c22f897',
  '1.0.0',
  'my_hostname',
  'my_svc',
  'my_env',
  'my_version',
  'entrypoint.name:server,svc.auto:my_svc',
  'abc123def456abc123def456abc123def456abc123def456abc123def456abc123',
)

const cfg_handle = process_discovery.storeMetadata(metadata)
assert(cfg_handle !== undefined)

// Same shape, plus a thread-local attribute key map (OTEP-4947). libdatadog
// implicitly prepends `datadog.local_root_span_id` at wire index 0; entries
// here start at wire index 1.
const metadata_with_threadlocal = new process_discovery.TracerMetadata(
  '7938685c-19dd-490f-b9b3-8aae4c22f898',
  '1.0.0',
  'my_hostname',
  'my_svc',
  'my_env',
  'my_version',
  undefined,
  undefined,
  ['endpoint', 'http.status'],
)
assert.deepStrictEqual(
  metadata_with_threadlocal.threadlocalAttributeKeys,
  ['endpoint', 'http.status'],
)
const cfg_handle_threadlocal = process_discovery.storeMetadata(metadata_with_threadlocal)
assert(cfg_handle_threadlocal !== undefined)

if (process.platform === 'linux') {
  const contains_datadog_memfd = (fds) => {
    for (const fd in fds) {
      try {
        const fd_name = fs.readlinkSync(`/proc/${process.pid}/fd/${fd}`)
        if (fd_name.includes('datadog-tracer-info-')) {
          return true
        }
      } catch {
        continue
      }
    }
    return false
  }

  const fds = fs.readdirSync(`/proc/${process.pid}/fd`)
  assert(contains_datadog_memfd(fds))
}
