'use strict'

module.exports.get = function (name) {
  return process.env[name]
}
