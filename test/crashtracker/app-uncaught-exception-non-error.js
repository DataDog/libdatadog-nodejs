'use strict'

const libdatadog = require('../..')
const crashtracker = libdatadog.load('crashtracker')
const { initTestCrashtracker } = require('./test_utils')

initTestCrashtracker()
crashtracker.beginProfilerSerializing()

process.on('uncaughtExceptionMonitor', (e) => {
  crashtracker.reportUncaughtException(e)
})

throw 'a plain string error'
