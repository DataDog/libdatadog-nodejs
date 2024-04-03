const sender = require('./index.node')

sender.init("127.0.0.1", 8126, 10000, "1.0", "nodejs", "18.0", "v8")

let ret = sender.send(Buffer.alloc(1), 1)
console.log(ret)
