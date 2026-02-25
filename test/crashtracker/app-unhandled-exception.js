'use strict'

const libdatadog = require('../..')
const crashtracker = libdatadog.load('crashtracker')
const { initTestCrashtracker } = require('./test_utils')

initTestCrashtracker()
function myFaultyFunction () {
  throw new TypeError('something went wrong')
}

crashtracker.beginProfilerSerializing()

process.on('uncaughtException', (e) => {
  crashtracker.reportUnhandledException(e)
})

myFaultyFunction()
