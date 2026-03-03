'use strict'

const libdatadog = require('../..')

const { initTestCrashtracker } = require('./test-utils')

const crashtracker = libdatadog.load('crashtracker')

initTestCrashtracker()
crashtracker.beginProfilerSerializing()

process.on('uncaughtExceptionMonitor', (e, origin) => {
  crashtracker.reportUncaughtExceptionMonitor(e, origin)
})

function myFaultyFunction () {
  throw new TypeError('something went wrong')
}

myFaultyFunction()
