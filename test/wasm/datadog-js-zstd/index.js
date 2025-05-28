const loader = require('../../../load.js');
const assert = require('assert');

const zstd = loader.load('datadog-js-zstd');
assert(zstd !== undefined);

// Create some compressible data
const SAMPLE_SIZE = 512;
const SAMPLE_COUNT = 1024;
const DATA_SIZE = SAMPLE_COUNT * 4 * SAMPLE_SIZE;

const samples = []
for (let i = 0; i < SAMPLE_COUNT; i++) {
    const sample = new Array(SAMPLE_SIZE);
    for (let j = 0; j < SAMPLE_SIZE; j++) {
        sample[j] = (Math.random() * 256) | 0;
    }
    samples.push(sample);
}
const data = new Array(DATA_SIZE);
for (let i = 0; i < DATA_SIZE; i+= SAMPLE_SIZE) {
    data.push(...samples[Math.random() * SAMPLE_COUNT | 0]);
}
// Introduce some irregularities
for (let i = 0; i < SAMPLE_COUNT; i++) {
    data[Math.random() * DATA_SIZE | 0] = 0;
}
const dataArr = new Uint8Array(data);
const compressed3 = zstd.zstd_compress(dataArr, 3)
ensureCompressed(compressed3);

// Test that 0 means default compression level
const compressed0 = zstd.zstd_compress(dataArr, 0)
ensureCompressed(compressed3);
assert(compressed0.length == compressed3.length);

// Test that compression levels are correctly passed on.
// Level 18 should produce a smaller output than level 3.
// We can go all the way up to 22, but it is significantly slower.
const compressed18 = zstd.zstd_compress(dataArr, 18)
ensureCompressed(compressed18);
assert(compressed18.length < compressed3.length);

function ensureCompressed(compressed) {
    assert(compressed.length > 4);
    assert.equal(compressed[0], 0x28);
    assert.equal(compressed[1], 0xb5);
    assert.equal(compressed[2], 0x2f);
    assert.equal(compressed[3], 0xfd);
}
