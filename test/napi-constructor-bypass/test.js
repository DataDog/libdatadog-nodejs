'use strict'

const assert = require('assert')
const binding = require('./test-binding.node')


console.log('1. using constructor directly (empty array)')
const result1 = binding.testWithConstructor([])
console.log('Expected: [1, 2, 3]')
console.log('Actual:', result1)
assert.deepStrictEqual(result1, [1, 2, 3], 'Constructor should apply defaults')

console.log('2. using NAPI serde deserialization (empty array)')
const result2 = binding.testWithSerde({ values: [] })
console.log('Expected: []')
console.log('Actual:', result2)
assert.deepStrictEqual(result2, [], 'Serde should bypass constructor')

console.log('3. using constructor directly (explicit values)')
const result3 = binding.testWithConstructor([4, 5, 6])
console.log('Expected: [4, 5, 6]')
console.log('Actual:', result3)
assert.deepStrictEqual(result3, [4, 5, 6], 'Constructor should use provided values')

console.log('4. using NAPI serde deserialization (explicit values)')
const result4 = binding.testWithSerde({ values: [7, 8, 9] })
console.log('Expected: [7, 8, 9]')
console.log('Actual:', result4)
assert.deepStrictEqual(result4, [7, 8, 9], 'Serde should use provided values')
