'use strict'

const eslintPluginImportX = require('eslint-plugin-import-x')
const eslintPluginJs = require('@eslint/js')
const eslintPluginN = require('eslint-plugin-n')
const eslintPluginStylistic = require('@stylistic/eslint-plugin')
const eslintPluginUnicorn = require('eslint-plugin-unicorn').default
const globals = require('globals')

module.exports = [
  eslintPluginJs.configs.recommended,
  eslintPluginImportX.flatConfigs.recommended,
  eslintPluginN.configs['flat/recommended-script'],
  eslintPluginStylistic.configs.recommended,
  eslintPluginUnicorn.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.es2022,
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
      'import-x/extensions': ['error', 'never', { json: 'always' }],
      'import-x/no-absolute-path': 'error',
      'import-x/no-webpack-loader-syntax': 'error',
      'import-x/order': ['error', {
        'newlines-between': 'always',
      }],
      'n/no-process-exit': 'off', // Duplicate of unicorn/no-process-exit
      'prefer-const': 'error',
      'unicorn/prefer-module': 'off', // We use CJS
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
    // This script runs inside the prebuildify Docker container which uses Node.js 12
    files: ['scripts/copy-artifacts.js'],
    languageOptions: {
      ecmaVersion: 2019,
    },
    settings: {
      // Used by `eslint-plugin-n` to determine the minimum version of Node.js to support.
      node: { version: '>=12.0.0' },
    },
    rules: {
      'unicorn/prefer-node-protocol': 'off',
    },
  },
  {
    ignores: ['build/', 'target/', 'prebuilds/'],
  },
]
