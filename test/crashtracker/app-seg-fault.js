'use strict'

const libdatadog = require('../..')

const { initTestCrashtracker } = require('./test-utils')

const crashtracker = libdatadog.load('crashtracker')

const receiverBinary = libdatadog.find('crashtracker-receiver', true)
console.log('[app-seg-fault] receiver binary:', receiverBinary)
console.log('[app-seg-fault] initializing crashtracker...')
initTestCrashtracker()
console.log('[app-seg-fault] crashtracker initialized, triggering segfault...')
crashtracker.beginProfilerSerializing()
require('@datadog/segfaultify').segfaultify()
