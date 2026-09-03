'use strict'

const vm = require('node:vm')

const libdatadog = require('../..')

const { initTestCrashtracker } = require('./test-utils')

const crashtracker = libdatadog.load('crashtracker')

initTestCrashtracker()
crashtracker.beginProfilerSerializing()

/**
 * @param {unknown} error
 * @param {string} origin
 */
function reportUncaughtException (error, origin) {
  crashtracker.reportUncaughtExceptionMonitor(error, origin)
}

function customerVmHandler () {
  vm.runInNewContext('throw new TypeError("cross-realm failure")')
}

process.on('uncaughtExceptionMonitor', reportUncaughtException)

customerVmHandler()
