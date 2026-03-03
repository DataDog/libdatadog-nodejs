'use strict'

const eslintPluginJs = require('@eslint/js')
const eslintPluginN = require('eslint-plugin-n')
const eslintPluginStylistic = require('@stylistic/eslint-plugin')
const eslintPluginUnicorn = require('eslint-plugin-unicorn').default
const globals = require('globals')

module.exports = [
  eslintPluginJs.configs.recommended,
  eslintPluginN.configs['flat/recommended-script'],
  eslintPluginStylistic.configs.recommended,
  eslintPluginUnicorn.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    settings: {
      // Used by `eslint-plugin-n` to determine the minimum version of Node.js to support.
      // Normally setting this in the `package.json` engines field is enough, but we can't use that as it will fail
      // when running `yarn copy-artifacts` inside the prebuildify Docker container which uses Node.js 12.
      node: { version: '>=18.0.0' },
    },
    rules: {
      '@stylistic/brace-style': ['error', '1tbs'],
      '@stylistic/space-before-function-paren': ['error', 'always'],
      'n/no-process-exit': 'off', // Duplicate of unicorn/no-process-exit
      'unicorn/filename-case': 'off',
      'unicorn/no-null': 'off',
      'unicorn/prefer-module': 'off', // We use CJS
      'unicorn/prefer-top-level-await': 'off',
      'unicorn/prevent-abbreviations': 'off',
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
