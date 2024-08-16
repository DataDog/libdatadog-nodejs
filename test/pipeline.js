'use strict'

const { pipeline } = require('..')

if (pipeline) {
  pipeline.init_trace_exporter("127.0.0.1", 8126, 10000, "1.0", "nodejs", "18.0", "v8")

  let ret = pipeline.send_traces(Buffer.alloc(1), 1)
  console.log(ret)
}
