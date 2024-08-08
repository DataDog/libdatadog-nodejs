const { existsSync } = require('fs')
const { crashtracker, pipeline } = require('.')

if (pipeline) {
  pipeline.init_trace_exporter("127.0.0.1", 8126, 10000, "1.0", "nodejs", "18.0", "v8")

  let ret = pipeline.send_traces(Buffer.alloc(1), 1)
  console.log(ret)
}

if (crashtracker) {
  const path_to_receiver_binary = [
    `${__dirname}/build/Release/crashtracker-receiver`,
    `${__dirname}/build/Debug/crashtracker-receiver`
  ].find(f => existsSync(f))

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
    path_to_receiver_binary,
    stderr_filename: null,
    stdout_filename: null,
  }, {
    library_name: "dd-trace-js",
    library_version: '0.0.0',
    family: 'nodejs',
    tags: []
  })
}
