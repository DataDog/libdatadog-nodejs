'use strict'

const libdatadog = require('../..')
const crashtracker = libdatadog.load('crashtracker')
const { initTestCrashtracker } = require('./test-utils')

initTestCrashtracker()
crashtracker.beginProfilerSerializing()
require('@datadog/segfaultify').segfaultify()
