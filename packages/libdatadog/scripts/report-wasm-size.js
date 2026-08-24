'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { brotliDecompressSync } = require('node:zlib')

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

function inferCrate (functionName) {
  if (/^(COVER|FASTCOVER|FSE|HIST|HUF|POOL|XXH|ZSTD|ZSTDMT)_/.test(functionName)) {
    return 'zstd-sys (C)'
  }
  if (/^__(externref|wbindgen|wbg)/.test(functionName)) return 'wasm-bindgen runtime'
  if (/^(__rust|__rg_|dlmalloc::)/.test(functionName)) return 'Rust runtime'

  const match = functionName.match(/(?:^|[< &(,])(?:mut )?([A-Za-z][A-Za-z0-9_]*)::/)
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

function layerRow (name, bytes, emphasis = false) {
  const formattedBytes = formatBytes(bytes)
  const kibibytes = formatKibibytes(bytes)
  if (emphasis) return `| **${name}** | **${formattedBytes}** | **${kibibytes}** |`
  return `| ${name} | ${formattedBytes} | ${kibibytes} |`
}

function appendCrateReport (lines, profilePath) {
  const profileWasm = fs.readFileSync(profilePath)
  const { entries, totalBytes } = readCrateSizes(profileWasm)
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

function createReport (gluePath, profilePath) {
  const glue = fs.readFileSync(gluePath, 'utf8')
  const match = glue.match(/Buffer\.from\('([A-Za-z0-9+/=]+)', 'base64'\)/)
  if (!match) throw new Error('could not find the inline base64 WASM payload')

  const base64Bytes = Buffer.byteLength(match[1])
  const compressed = Buffer.from(match[1], 'base64')
  const wasm = brotliDecompressSync(compressed)
  const glueBytes = Buffer.byteLength(glue) - base64Bytes
  const inlineBytes = Buffer.byteLength(glue)
  const base64Overhead = base64Bytes - compressed.length
  const sections = readSections(wasm)
  const lines = [
    '## libdatadog WASM size',
    '',
    '| Inline artifact layer | Bytes | KiB |',
    '| --- | ---: | ---: |',
    layerRow('Raw WASM (before Brotli)', wasm.length),
    layerRow('Brotli-compressed WASM', compressed.length),
    layerRow('Base64 encoding overhead', base64Overhead),
    layerRow('JavaScript glue/loader', glueBytes),
    layerRow('Final inlined JavaScript', inlineBytes, true),
    '',
    '### Raw WebAssembly sections',
    '',
    '| Section | Bytes | KiB | Share |',
    '| --- | ---: | ---: | ---: |',
  ]

  for (const section of sections) {
    const share = `${(section.bytes / wasm.length * 100).toFixed(1)}%`
    lines.push(
      `| ${section.name} | ${formatBytes(section.bytes)} | `
      + `${formatKibibytes(section.bytes)} | ${share} |`,
    )
  }

  if (profilePath) appendCrateReport(lines, profilePath)

  lines.push('', `Generated from \`${path.relative(process.cwd(), gluePath)}\`.`)
  return lines.join('\n')
}

if (require.main === module) {
  const gluePath = path.join(__dirname, '..', 'dist', 'wasm', 'libdatadog_wasm.js')
  const profilePath = process.argv[2] && path.resolve(process.argv[2])
  const report = createReport(gluePath, profilePath)
  console.log(report)

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)
  }

  if (profilePath) {
    const profileWasm = fs.readFileSync(profilePath)
    const failures = findForbiddenWasmCode(readCrateSizes(profileWasm).entries)
    if (failures.length > 0) {
      console.error('Forbidden code found in the symbolized WASM binary:')
      for (const failure of failures) {
        console.error(
          `- ${failure.dependency} via ${failure.name}: ${formatBytes(failure.bytes)} bytes`,
        )
      }
      process.exitCode = 1
    }
  }
}

module.exports = {
  createReport,
  findForbiddenWasmCode,
  inferCrate,
  readCrateSizes,
  readSections,
}
