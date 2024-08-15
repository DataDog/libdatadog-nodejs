'use strict'

const path = require('path')
const { crashtracker } = require('..')

const releaseFolder = path.normalize(path.join(__dirname, '..', 'build', 'Release'))

crashtracker.start({
  additional_files: [],
  create_alt_stack: false,
  endpoint: {
    url: {
      scheme: 'http',
      authority: 'localhost:8126',
      path_and_query: ''
    },
    timeout_ms: 3000
  },
  resolve_frames: 'Disabled',
  wait_for_receiver: false
}, {
  args: [],
  env: [],
  path_to_receiver_binary: path.join(releaseFolder, 'crashtracker-receiver'),
  stderr_filename: null,
  stdout_filename: null,
}, {
  library_name: "dd-trace-js",
  library_version: '0.0.0',
  family: 'nodejs',
  tags: []
})
