'use strict'

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

/**
 * @param {TypeError} target
 * @param {string | symbol} property
 */
function getErrorProperty (target, property) {
  return Reflect.get(target, property, target)
}

function customerProxyHandler () {
  const error = new TypeError('proxied failure')
  throw new Proxy(error, { get: getErrorProperty })
}

process.on('uncaughtExceptionMonitor', reportUncaughtException)

customerProxyHandler()
