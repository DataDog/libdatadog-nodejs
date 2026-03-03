'use strict'

const eslintPluginJs = require('@eslint/js')
const globals = require('globals')

module.exports = [
  eslintPluginJs.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node
      }
    },
    rules: {
      'no-unused-vars': ['error', {
        args: 'none',
        caughtErrors: 'none'
      }]
    }
  },
  {
    files: ['load.js'],
    languageOptions: {
      globals: {
        __webpack_require__: 'readonly',
        __non_webpack_require__: 'readonly'
      }
    }
  },
  {
    ignores: ['build/', 'target/', 'prebuilds/']
  }
]
