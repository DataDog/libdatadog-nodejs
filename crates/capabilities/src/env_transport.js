'use strict'

const { env } = process

module.exports.get = (name) => {
  return env[name]
}
