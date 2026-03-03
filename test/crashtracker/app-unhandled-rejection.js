'use strict'

const libdatadog = require('../..')
const crashtracker = libdatadog.load('crashtracker')
const { initTestCrashtracker } = require('./test-utils')

initTestCrashtracker()
crashtracker.beginProfilerSerializing()

process.on('uncaughtExceptionMonitor', (e, origin) => {
  crashtracker.reportUncaughtExceptionMonitor(e, origin)
})

async function myAsyncFaultyFunction () {
  throw new Error('async went wrong')
}

myAsyncFaultyFunction() // eslint-disable-line unicorn/prefer-top-level-await
