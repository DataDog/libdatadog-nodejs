'use strict'

const libdatadog = require('../..')

const { initTestCrashtracker } = require('./test-utils')

const crashtracker = libdatadog.load('crashtracker')

initTestCrashtracker()
crashtracker.beginProfilerSerializing()

process.on('uncaughtExceptionMonitor', (e, origin) => {
  crashtracker.reportUncaughtExceptionMonitor(e, origin)
})

Promise.reject('a plain string rejection')
