'use strict'

const libdatadog = require('../..')
const crashtracker = libdatadog.load('crashtracker')
const { initTestCrashtracker } = require('./test_utils')

initTestCrashtracker()
crashtracker.beginProfilerSerializing()

process.on('unhandledRejection', (reason) => {
  crashtracker.reportUnhandledRejection(reason)
})

async function myAsyncFaultyFunction () {
  throw new Error('async went wrong')
}

myAsyncFaultyFunction()
