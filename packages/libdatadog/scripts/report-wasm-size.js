'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { brotliDecompressSync } = require('node:zlib')

const binaryenEscapeSequence = /^[0-9A-Fa-f]{2}$/
const crateDisambiguator = /\[[0-9A-Fa-f]+\](?=::)/g
const sectionNames = [
  'custom',
  'type',
  'import',
  'function',
  'table',
  'memory',
  'global',
  'export',
  'start',
  'element',
  'code',
  'data',
  'data count',
  'tag',
]

const forbiddenWasmCode = [
  {
    dependency: 'regex',
    owners: new Set(['aho-corasick', 'regex', 'regex-automata', 'regex-syntax']),
  },
  {
    dependency: 'zstd',
    owners: new Set(['zstd', 'zstd-safe']),
  },
  {
    dependency: 'zstd-sys',
    owners: new Set(['zstd-sys', 'zstd-sys (C)']),
  },
]

const artifacts = [
  {
    comparisonGluePath: 'packages/libdatadog/wasm/dist/libdatadog_wasm.js',
    gluePath: path.join(__dirname, '..', 'wasm', 'dist', 'libdatadog_wasm.js'),
    name: 'libdatadog',
    maximumInlineBytes: 210 * 1024,
    profilePath: 'target/size/libdatadog-wasm/libdatadog_wasm_bg.wasm',
  },
  {
    comparisonGluePath: 'packages/libdatadog/wasm/dist/remote-config/remote_config.js',
    gluePath: path.join(__dirname, '..', 'wasm', 'dist', 'remote-config', 'remote_config.js'),
    name: 'remote config',
    maximumInlineBytes: 330 * 1024,
    profilePath: 'target/size/remote-config/remote_config_bg.wasm',
  },
]

function readUnsignedLeb128 (bytes, start) {
  let offset = start
  let multiplier = 1
  let value = 0

  while (offset < bytes.length) {
    const byte = bytes[offset++]
    value += (byte & 0x7F) * multiplier
    if ((byte & 0x80) === 0) return { offset, value }
    multiplier *= 128
  }

  throw new Error('WASM contains an unterminated section length')
}

function validateWasm (wasm) {
  const expectedHeader = Buffer.from([
    0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00,
  ])
  if (wasm.length < expectedHeader.length || !wasm.subarray(0, 8).equals(expectedHeader)) {
    throw new Error('inline payload is not a WebAssembly 1 binary')
  }
}

function readSectionRecords (wasm) {
  validateWasm(wasm)

  const sections = []
  let offset = 8

  while (offset < wasm.length) {
    const sectionStart = offset
    const id = wasm[offset++]
    const length = readUnsignedLeb128(wasm, offset)
    const payloadStart = length.offset
    const payloadEnd = payloadStart + length.value
    if (payloadEnd > wasm.length) throw new Error('WASM section extends past the binary')
    sections.push({
      bytes: payloadEnd - sectionStart,
      id,
      payloadEnd,
      payloadStart,
    })
    offset = payloadEnd
  }

  return sections
}

function readSections (wasm) {
  const sections = [{ name: 'header', bytes: 8 }]

  for (const record of readSectionRecords(wasm)) {
    const { bytes, id } = record
    const name = sectionNames[id] || `unknown (${id})`
    const existing = sections.find(section => section.name === name)
    if (existing) existing.bytes += bytes
    else sections.push({ name, bytes })
  }

  return sections
}

function readWasmString (wasm, start) {
  const length = readUnsignedLeb128(wasm, start)
  const end = length.offset + length.value
  if (end > wasm.length) throw new Error('WASM string extends past the binary')
  return {
    offset: end,
    value: wasm.toString('utf8', length.offset, end),
  }
}

function skipLimits (wasm, start) {
  const flags = readUnsignedLeb128(wasm, start)
  const minimum = readUnsignedLeb128(wasm, flags.offset)
  if ((flags.value & 1) === 0) return minimum.offset
  return readUnsignedLeb128(wasm, minimum.offset).offset
}

function readImportedFunctionCount (wasm, sections) {
  const section = sections.find(section => section.id === 2)
  if (!section) return 0

  const cursor = readUnsignedLeb128(wasm, section.payloadStart)
  let offset = cursor.offset
  let functionCount = 0

  for (let index = 0; index < cursor.value; index++) {
    offset = readWasmString(wasm, offset).offset
    offset = readWasmString(wasm, offset).offset
    const kind = wasm[offset++]

    switch (kind) {
      case 0: {
        functionCount++
        offset = readUnsignedLeb128(wasm, offset).offset
        break
      }
      case 1: {
        offset++
        offset = skipLimits(wasm, offset)
        break
      }
      case 2: {
        offset = skipLimits(wasm, offset)
        break
      }
      case 3: {
        offset += 2
        break
      }
      case 4: {
        offset++
        offset = readUnsignedLeb128(wasm, offset).offset
        break
      }
      default: {
        throw new Error(`unsupported WASM import kind: ${kind}`)
      }
    }
  }

  return functionCount
}

function readFunctionNames (wasm, sections) {
  const names = new Map()

  for (const section of sections) {
    if (section.id !== 0) continue
    const customName = readWasmString(wasm, section.payloadStart)
    if (customName.value !== 'name') continue

    let offset = customName.offset
    while (offset < section.payloadEnd) {
      const subsectionId = wasm[offset++]
      const length = readUnsignedLeb128(wasm, offset)
      const subsectionEnd = length.offset + length.value
      offset = length.offset

      if (subsectionId === 1) {
        const count = readUnsignedLeb128(wasm, offset)
        offset = count.offset
        for (let index = 0; index < count.value; index++) {
          const functionIndex = readUnsignedLeb128(wasm, offset)
          const name = readWasmString(wasm, functionIndex.offset)
          names.set(functionIndex.value, name.value)
          offset = name.offset
        }
      }

      offset = subsectionEnd
    }
  }

  return names
}

/** @param {string} functionName */
function decodeBinaryenName (functionName) {
  let decodedName = ''

  for (let index = 0; index < functionName.length; index++) {
    const sequence = functionName.slice(index + 1, index + 3)
    if (functionName[index] === '\\' && binaryenEscapeSequence.test(sequence)) {
      decodedName += String.fromCodePoint(Number.parseInt(sequence, 16))
      index += 2
    } else {
      decodedName += functionName[index]
    }
  }

  return decodedName
}

/** @param {string} functionName */
function inferCrate (functionName) {
  const decodedName = decodeBinaryenName(functionName)
    .replaceAll(crateDisambiguator, '')

  if (/^(COVER|FASTCOVER|FSE|HIST|HUF|POOL|XXH|ZSTD|ZSTDMT)_/.test(decodedName)) {
    return 'zstd-sys (C)'
  }
  if (/^__(externref|wbindgen|wbg)/.test(decodedName)) return 'wasm-bindgen runtime'
  if (/^(__rust|__rg_|dlmalloc::)/.test(decodedName)) return 'Rust runtime'

  const match = decodedName.match(/(?:^|[< &(,])(?:mut )?([A-Za-z][A-Za-z0-9_]*)::/)
  if (!match) return 'bindings / unattributed'
  if (['alloc', 'core', 'std'].includes(match[1])) return 'Rust standard library'
  return match[1].replaceAll('_', '-')
}

function insertBySize (entries, entry) {
  const index = entries.findIndex(candidate => candidate.bytes < entry.bytes)
  if (index === -1) entries.push(entry)
  else entries.splice(index, 0, entry)
}

function readCrateSizes (wasm) {
  const sections = readSectionRecords(wasm)
  const code = sections.find(section => section.id === 10)
  if (!code) throw new Error('symbolized WASM does not contain a code section')
  const names = readFunctionNames(wasm, sections)
  if (names.size === 0) throw new Error('symbolized WASM does not contain function names')

  const importedFunctions = readImportedFunctionCount(wasm, sections)
  const sizes = new Map()
  const count = readUnsignedLeb128(wasm, code.payloadStart)
  let offset = count.offset
  let totalBytes = 0

  for (let index = 0; index < count.value; index++) {
    const bodyStart = offset
    const body = readUnsignedLeb128(wasm, bodyStart)
    offset = body.offset + body.value
    if (offset > code.payloadEnd) throw new Error('WASM function extends past the code section')

    const bytes = offset - bodyStart
    const name = names.get(importedFunctions + index) || ''
    const crate = inferCrate(name)
    sizes.set(crate, (sizes.get(crate) || 0) + bytes)
    totalBytes += bytes
  }

  const entries = []
  for (const [name, bytes] of sizes) insertBySize(entries, { bytes, name })
  if (!entries.some(entry => ![
    'bindings / unattributed',
    'Rust runtime',
    'Rust standard library',
    'wasm-bindgen runtime',
  ].includes(entry.name))) {
    throw new Error('symbolized WASM does not contain attributable Rust crate names')
  }
  return { entries, totalBytes }
}

function findForbiddenWasmCode (entries) {
  const failures = []

  for (const entry of entries) {
    const forbidden = forbiddenWasmCode.find(candidate => candidate.owners.has(entry.name))
    if (forbidden) failures.push({ ...entry, dependency: forbidden.dependency })
  }

  return failures
}

function formatBytes (bytes) {
  return bytes.toLocaleString('en-US')
}

function formatKibibytes (bytes) {
  return (bytes / 1024).toFixed(1)
}

/**
 * @param {string} name
 * @param {number} bytes
 * @param {boolean} [emphasis]
 * @returns {string}
 */
function layerRow (name, bytes, emphasis = false) {
  const formattedBytes = formatBytes(bytes)
  const kibibytes = formatKibibytes(bytes)
  if (emphasis) return `| **${name}** | **${formattedBytes}** | **${kibibytes}** |`
  return `| ${name} | ${formattedBytes} | ${kibibytes} |`
}

/**
 * @param {string[]} lines
 * @param {{ entries: Array<{ bytes: number, name: string }>, totalBytes: number }} crateSizes
 */
function appendCrateReport (lines, crateSizes) {
  const { entries, totalBytes } = crateSizes
  const visibleEntries = entries.filter(entry => entry.bytes >= 2048)
  const otherBytes = entries
    .filter(entry => entry.bytes < 2048)
    .reduce((total, entry) => total + entry.bytes, 0)
  if (otherBytes > 0) {
    visibleEntries.push({ bytes: otherBytes, name: 'other crates (<2 KiB each)' })
  }
  const attributionNote = [
    'Crate ownership comes from a separate symbol-preserving build with the same size settings.',
    'Debug-name bytes are excluded; generic functions are assigned to their symbol owner.',
  ].join(' ')

  lines.push(
    '',
    '### Code by Rust crate',
    '',
    '| Crate/function owner | Bytes | KiB | Share |',
    '| --- | ---: | ---: | ---: |',
  )

  for (const entry of visibleEntries) {
    const share = `${(entry.bytes / totalBytes * 100).toFixed(1)}%`
    lines.push(
      `| ${entry.name} | ${formatBytes(entry.bytes)} | `
      + `${formatKibibytes(entry.bytes)} | ${share} |`,
    )
  }

  lines.push('', attributionNote)
}

/**
 * @param {string} gluePath
 * @param {string | undefined} profilePath
 * @param {string} artifactName
 * @returns {{
 *   artifactName: string,
 *   crateSizes: { entries: Array<{ bytes: number, name: string }>, totalBytes: number } | undefined,
 *   gluePath: string,
 *   layers: Array<{ bytes: number, name: string }>,
 *   sections: Array<{ bytes: number, name: string }>
 * }}
 */
function readArtifactSizes (gluePath, profilePath, artifactName) {
  const glue = fs.readFileSync(gluePath, 'utf8')
  const match = glue.match(/Buffer\.from\('([A-Za-z0-9+/=]+)', 'base64'\)/)
  if (!match) throw new Error('could not find the inline base64 WASM payload')

  const base64Bytes = Buffer.byteLength(match[1])
  const compressed = Buffer.from(match[1], 'base64')
  const wasm = brotliDecompressSync(compressed)

  return {
    artifactName,
    crateSizes: profilePath ? readCrateSizes(fs.readFileSync(profilePath)) : undefined,
    gluePath,
    layers: [
      { bytes: wasm.length, name: 'Raw WASM (before Brotli)' },
      { bytes: compressed.length, name: 'Brotli-compressed WASM' },
      { bytes: base64Bytes - compressed.length, name: 'Base64 encoding overhead' },
      { bytes: Buffer.byteLength(glue) - base64Bytes, name: 'JavaScript glue/loader' },
      { bytes: Buffer.byteLength(glue), name: 'Final inlined JavaScript' },
    ],
    sections: readSections(wasm),
  }
}

/**
 * @param {Array<{ bytes: number, name: string }>} beforeEntries
 * @param {Array<{ bytes: number, name: string }>} afterEntries
 * @returns {Array<{ afterBytes: number, beforeBytes: number, name: string }>}
 */
function alignEntries (beforeEntries, afterEntries) {
  const beforeByName = new Map(beforeEntries.map(entry => [entry.name, entry.bytes]))
  const afterByName = new Map(afterEntries.map(entry => [entry.name, entry.bytes]))
  const names = afterEntries.map(entry => entry.name)

  for (const entry of beforeEntries) {
    if (!afterByName.has(entry.name)) names.push(entry.name)
  }

  return names.map(name => ({
    afterBytes: afterByName.get(name) ?? 0,
    beforeBytes: beforeByName.get(name) ?? 0,
    name,
  }))
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatMeasurement (bytes) {
  return `${formatBytes(bytes)} (${formatKibibytes(bytes)} KiB)`
}

/**
 * @param {number} beforeBytes
 * @param {number} afterBytes
 * @returns {string}
 */
function formatChange (beforeBytes, afterBytes) {
  const change = afterBytes - beforeBytes
  if (change === 0) return '0 (0.00%)'
  if (beforeBytes === 0) return `+${formatBytes(change)} (new)`
  if (afterBytes === 0) return `-${formatBytes(-change)} (removed)`

  const sign = change > 0 ? '+' : '-'
  const percentage = Math.abs(change / beforeBytes * 100).toFixed(2)
  return `${sign}${formatBytes(Math.abs(change))} (${sign}${percentage}%)`
}

/**
 * @param {Array<{ afterBytes: number, beforeBytes: number, name: string }>} entries
 * @returns {Array<{ afterBytes: number, beforeBytes: number, name: string }>}
 */
function orderChangedFirst (entries) {
  const changed = []
  const unchanged = []

  for (const entry of entries) {
    if (entry.afterBytes === entry.beforeBytes) unchanged.push(entry)
    else changed.push(entry)
  }

  return [...changed, ...unchanged]
}

/**
 * @param {string[]} lines
 * @param {string} firstColumn
 * @param {Array<{ afterBytes: number, beforeBytes: number, name: string }>} entries
 * @param {string} [emphasizedName]
 */
function appendComparisonTable (lines, firstColumn, entries, emphasizedName) {
  lines.push(
    `| ${firstColumn} | Before | After | Change |`,
    '| --- | ---: | ---: | ---: |',
  )

  for (const { afterBytes, beforeBytes, name } of entries) {
    const values = [
      name,
      formatMeasurement(beforeBytes),
      formatMeasurement(afterBytes),
      formatChange(beforeBytes, afterBytes),
    ]
    if (name === emphasizedName) {
      lines.push(`| ${values.map(value => `**${value}**`).join(' | ')} |`)
    } else {
      lines.push(`| ${values.join(' | ')} |`)
    }
  }
}

/**
 * @param {{ entries: Array<{ bytes: number, name: string }> }} beforeCrates
 * @param {{ entries: Array<{ bytes: number, name: string }> }} afterCrates
 * @returns {Array<{ afterBytes: number, beforeBytes: number, name: string }>}
 */
function alignCrates (beforeCrates, afterCrates) {
  const entries = []

  for (const entry of alignEntries(beforeCrates.entries, afterCrates.entries)) {
    const bytes = Math.max(entry.beforeBytes, entry.afterBytes)
    const index = entries.findIndex(candidate => Math.max(candidate.beforeBytes, candidate.afterBytes) < bytes)
    if (index === -1) entries.push(entry)
    else entries.splice(index, 0, entry)
  }

  const visibleEntries = entries.filter(entry => Math.max(entry.beforeBytes, entry.afterBytes) >= 2048)
  const hiddenEntries = entries.filter(entry => Math.max(entry.beforeBytes, entry.afterBytes) < 2048)
  const other = { afterBytes: 0, beforeBytes: 0, name: 'other crates (<2 KiB in both builds)' }

  for (const entry of hiddenEntries) {
    other.afterBytes += entry.afterBytes
    other.beforeBytes += entry.beforeBytes
  }

  if (other.afterBytes > 0 || other.beforeBytes > 0) visibleEntries.push(other)
  return visibleEntries
}

/**
 * @param {string} beforeRoot
 * @param {string} afterRoot
 * @param {{ comparisonGluePath: string, name: string, profilePath: string }} artifact
 * @returns {{ afterBytes: number, artifactName: string, beforeBytes: number, report: string }}
 */
function createComparisonReport (beforeRoot, afterRoot, artifact) {
  const before = readArtifactSizes(
    path.join(beforeRoot, artifact.comparisonGluePath),
    path.join(beforeRoot, artifact.profilePath),
    artifact.name,
  )
  const after = readArtifactSizes(
    path.join(afterRoot, artifact.comparisonGluePath),
    path.join(afterRoot, artifact.profilePath),
    artifact.name,
  )
  const layers = orderChangedFirst(alignEntries(before.layers, after.layers))
  const sections = orderChangedFirst(alignEntries(before.sections, after.sections))
  const crates = orderChangedFirst(alignCrates(before.crateSizes, after.crateSizes))
  const entries = [...layers, ...sections, ...crates]
  const changedCount = entries.filter(entry => entry.afterBytes !== entry.beforeBytes).length
  const finalArtifact = layers.find(entry => entry.name === 'Final inlined JavaScript')
  const lines = [
    '<details>',
    `<summary>${artifact.name}: ${changedCount} changed, ${entries.length - changedCount} unchanged</summary>`,
    '',
    '### Inline artifact layers',
    '',
  ]
  appendComparisonTable(
    lines,
    'Inline artifact layer',
    layers,
    'Final inlined JavaScript',
  )
  lines.push('', '### Raw WebAssembly sections', '')
  appendComparisonTable(lines, 'Section', sections)
  lines.push('', '### Code by Rust crate', '')
  appendComparisonTable(lines, 'Crate/function owner', crates)
  lines.push('', '</details>', '')
  return {
    afterBytes: finalArtifact.afterBytes,
    artifactName: artifact.name,
    beforeBytes: finalArtifact.beforeBytes,
    report: lines.join('\n'),
  }
}

/**
 * @param {Array<{ afterBytes: number, artifactName: string, beforeBytes: number }>} comparisons
 * @returns {string}
 */
function createComparisonSummary (comparisons) {
  const lines = [
    '## WASM size comparison',
    '',
  ]
  const beforeRef = process.env.WASM_SIZE_BEFORE_REF
  const afterRef = process.env.WASM_SIZE_AFTER_REF

  if (beforeRef && afterRef) {
    lines.push(`Compared \`${beforeRef.slice(0, 7)}\` (base) with \`${afterRef.slice(0, 7)}\` (PR merge).`, '')
  }
  lines.push(
    '| Artifact | Before | After | Change |',
    '| --- | ---: | ---: | ---: |',
  )
  for (const { afterBytes, artifactName, beforeBytes } of comparisons) {
    lines.push(
      `| ${artifactName} | ${formatMeasurement(beforeBytes)} | ${formatMeasurement(afterBytes)} | `
      + `${formatChange(beforeBytes, afterBytes)} |`,
    )
  }
  lines.push(
    '',
    'Negative changes reduce size.',
    'Crate sizes come from symbol-preserving builds with debug names excluded '
    + 'and generic functions assigned to their symbol owner.',
    '',
  )
  return lines.join('\n')
}

/**
 * @param {string} gluePath
 * @param {string | undefined} profilePath
 * @param {string} [artifactName]
 */
function createReport (gluePath, profilePath, artifactName = 'libdatadog') {
  const { crateSizes, layers, sections } = readArtifactSizes(gluePath, profilePath, artifactName)
  const lines = [
    `## ${artifactName} WASM size`,
    '',
    '| Inline artifact layer | Bytes | KiB |',
    '| --- | ---: | ---: |',
  ]
  for (const layer of layers) lines.push(layerRow(layer.name, layer.bytes, layer.name === 'Final inlined JavaScript'))
  lines.push('', '### Raw WebAssembly sections', '', '| Section | Bytes | KiB | Share |', '| --- | ---: | ---: | ---: |')

  for (const section of sections) {
    const share = `${(section.bytes / layers[0].bytes * 100).toFixed(1)}%`
    lines.push(
      `| ${section.name} | ${formatBytes(section.bytes)} | `
      + `${formatKibibytes(section.bytes)} | ${share} |`,
    )
  }

  if (crateSizes) appendCrateReport(lines, crateSizes)

  lines.push('', `Generated from \`${path.relative(process.cwd(), gluePath)}\`.`)
  return lines.join('\n')
}

/**
 * @param {string} artifactName
 * @param {number} inlineBytes
 * @param {number} maximumInlineBytes
 */
function getSizeBudgetFailure (artifactName, inlineBytes, maximumInlineBytes) {
  if (inlineBytes <= maximumInlineBytes) return
  return `${artifactName}: ${formatBytes(inlineBytes)} bytes exceeds ${formatBytes(maximumInlineBytes)} bytes`
}

/** @param {string[]} reports */
function writeReports (reports) {
  const report = reports.join('\n')
  console.log(report)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)
  if (process.env.WASM_SIZE_REPORT) fs.writeFileSync(process.env.WASM_SIZE_REPORT, `${report}\n`)
}

function main () {
  const args = process.argv.slice(2)
  if (args[0] === '--compare') {
    if (args.length !== 3) throw new Error('expected --compare <before-root> <after-root>')
    const beforeRoot = path.resolve(args[1])
    const afterRoot = path.resolve(args[2])
    const comparisons = artifacts.map(artifact => createComparisonReport(beforeRoot, afterRoot, artifact))
    writeReports([createComparisonSummary(comparisons), ...comparisons.map(comparison => comparison.report)])
    return
  }

  const profilePaths = args
  if (profilePaths.length > 0 && profilePaths.length !== artifacts.length) {
    throw new Error(`expected ${artifacts.length} symbolized WASM paths, received ${profilePaths.length}`)
  }
  const failures = []
  const reports = []

  for (const [index, artifact] of artifacts.entries()) {
    const { gluePath, maximumInlineBytes, name } = artifact
    const profilePath = profilePaths[index] && path.resolve(profilePaths[index])
    const report = createReport(gluePath, profilePath, name)
    reports.push(report)

    const inlineBytes = fs.statSync(gluePath).size
    const budgetFailure = getSizeBudgetFailure(name, inlineBytes, maximumInlineBytes)
    if (budgetFailure) failures.push(budgetFailure)
    if (!profilePath) continue

    const profileWasm = fs.readFileSync(profilePath)
    for (const failure of findForbiddenWasmCode(readCrateSizes(profileWasm).entries)) {
      failures.push(`${failure.dependency} via ${failure.name}: ${formatBytes(failure.bytes)} bytes`)
    }
  }
  writeReports(reports)

  if (failures.length > 0) {
    console.error('WASM size validation failed:')
    for (const failure of failures) console.error(`- ${failure}`)
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = {
  createReport,
  findForbiddenWasmCode,
  inferCrate,
  readCrateSizes,
  readSections,
}
