'use strict'

module.exports.get = function (name) {
  return process.env[name]
}

module.exports.set = function (name, value) {
  process.env[name] = value
}

module.exports.unset = function (name) {
  delete process.env[name]
}
