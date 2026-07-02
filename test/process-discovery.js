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

// Same shape, plus a thread-local metadata block (OTEP-4947). libdatadog
// implicitly prepends `datadog.local_root_span_id` at wire index 0 in the
// attribute key map; entries here start at wire index 1. `schemaVersion` and
// `extraAttributes` describe the on-the-wire record schema for readers.
const metadata_with_threadlocal = new process_discovery.TracerMetadata(
  '7938685c-19dd-490f-b9b3-8aae4c22f898',
  '1.0.0',
  'my_hostname',
  'my_svc',
  'my_env',
  'my_version',
  undefined,
  undefined,
  {
    attributeKeys: ['endpoint', 'http.status'],
    schemaVersion: 'nodejs_v1_dev',
    extraAttributes: [
      { key: 'threadlocal.wrapped_object_offset', intValue: 24 },
      { key: 'threadlocal.tagged_size', intValue: 8 },
      { key: 'threadlocal.runtime.name', stringValue: 'nodejs' },
    ],
  },
)
assert.deepStrictEqual(
  metadata_with_threadlocal.threadlocalMetadata.attributeKeys,
  ['endpoint', 'http.status'],
)
assert.strictEqual(
  metadata_with_threadlocal.threadlocalMetadata.schemaVersion,
  'nodejs_v1_dev',
)
assert.strictEqual(
  metadata_with_threadlocal.threadlocalMetadata.extraAttributes.length,
  3,
)
const cfg_handle_threadlocal = process_discovery.storeMetadata(metadata_with_threadlocal)
assert(cfg_handle_threadlocal !== undefined)

// An ExtraAttribute with neither stringValue nor intValue set is a caller
// error — one of them has to be picked.
const bad_metadata_neither = new process_discovery.TracerMetadata(
  '7938685c-19dd-490f-b9b3-8aae4c22f899',
  '1.0.0',
  'my_hostname',
  undefined, undefined, undefined, undefined, undefined,
  {
    attributeKeys: [],
    schemaVersion: undefined,
    extraAttributes: [{ key: 'threadlocal.bogus' }],
  },
)
assert.throws(
  () => process_discovery.storeMetadata(bad_metadata_neither),
  /neither is/,
)

// Setting both stringValue and intValue is also a caller error — the intent
// is ambiguous, so reject.
const bad_metadata_both = new process_discovery.TracerMetadata(
  '7938685c-19dd-490f-b9b3-8aae4c22f89a',
  '1.0.0',
  'my_hostname',
  undefined, undefined, undefined, undefined, undefined,
  {
    attributeKeys: [],
    schemaVersion: undefined,
    extraAttributes: [{ key: 'threadlocal.bogus', stringValue: 's', intValue: 1 }],
  },
)
assert.throws(
  () => process_discovery.storeMetadata(bad_metadata_both),
  /both are/,
)

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
