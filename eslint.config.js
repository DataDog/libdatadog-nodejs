'use strict'

const eslintPluginJs = require('@eslint/js')
const eslintPluginStylistic = require('@stylistic/eslint-plugin')
const globals = require('globals')

module.exports = [
  eslintPluginJs.configs.recommended,
  eslintPluginStylistic.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@stylistic/brace-style': ['error', '1tbs'],
      '@stylistic/space-before-function-paren': ['error', 'always'],
      'no-unused-vars': ['error', {
        args: 'none',
        caughtErrors: 'none',
      }],
    },
  },
  {
    files: ['load.js'],
    languageOptions: {
      globals: {
        __webpack_require__: 'readonly',
        __non_webpack_require__: 'readonly',
      },
    },
  },
  {
    ignores: ['build/', 'target/', 'prebuilds/'],
  },
]
