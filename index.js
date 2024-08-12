'use strict'

const load = require('./load')

module.exports = {
  get collector () { return load('collector') },
  get pipeline () { return load('pipeline')}
}
