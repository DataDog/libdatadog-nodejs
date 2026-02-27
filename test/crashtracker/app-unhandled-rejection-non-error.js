'use strict'

const libdatadog = require('../..')
const crashtracker = libdatadog.load('crashtracker')
const { initTestCrashtracker } = require('./test_utils')

initTestCrashtracker()
crashtracker.beginProfilerSerializing()

process.on('unhandledRejection', (reason) => {
  crashtracker.reportUnhandledRejection(reason)
})

Promise.reject('a plain string rejection')
