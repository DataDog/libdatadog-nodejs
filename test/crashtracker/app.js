'use strict'

const os = require('os')
const libdatadog = require('../..')
const crashtracker = libdatadog.load('crashtracker')

crashtracker.initWithReceiver({
  additional_files: [],
  create_alt_stack: false,
  endpoint: {
    url: {
      scheme: 'http',
      authority: `127.0.0.1:${process.env.PORT || 8126}`,
      path_and_query: ''
    },
    timeout_ms: 3000
  },
  resolve_frames: 'EnabledWithInprocessSymbols',
  wait_for_receiver: true
}, {
  args: [],
  env: [],
  path_to_receiver_binary: libdatadog.find('crashtracker-receiver', true),
  stderr_filename: 'stderr.log',
  stdout_filename: 'stdout.log',
}, {
  library_name: 'dd-trace-js',
  library_version: '6.0.0-pre',
  family: 'nodejs',
  tags: ['foo:bar', 'baz:qux']
})

require('./index.node').boom()
