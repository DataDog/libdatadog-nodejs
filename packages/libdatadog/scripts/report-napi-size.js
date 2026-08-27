'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function formatBytes (bytes) {
  return bytes.toLocaleString('en-US')
}

function formatKibibytes (bytes) {
  return (bytes / 1024).toFixed(1)
}

function findArtifact () {
  const directory = path.join(__dirname, '..', 'dist', 'native')
  const artifacts = fs.readdirSync(directory)
    .filter(file => /^libdatadog\..+\.node$/.test(file))

  if (artifacts.length !== 1) {
    throw new Error(`expected one native artifact in ${directory}, found ${artifacts.length}`)
  }

  return path.join(directory, artifacts[0])
}

function runCommand (command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(`${command} failed: ${detail}`)
  }

  return result.stdout
}

function parseDarwinSections (output) {
  const sections = []

  for (const line of output.split('\n')) {
    const match = line.match(/^Segment (\S+):\s+(\d+)$/)
    if (match) sections.push({ name: match[1], bytes: Number(match[2]) })
  }

  return sections
}

function parseElfSections (output) {
  const sections = []

  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\S+)\s+(\d+)\s+[0-9a-fA-Fx]+$/)
    if (match && match[1] !== 'section') {
      sections.push({ name: match[1], bytes: Number(match[2]) })
    }
  }

  return sections
}

function readSections (artifactPath, platform = process.platform) {
  const sections = platform === 'darwin'
    ? parseDarwinSections(runCommand('size', ['-m', artifactPath]))
    : parseElfSections(runCommand('size', ['-A', artifactPath]))

  if (sections.length === 0) throw new Error('could not read native binary sections')
  return sections
}

function readCrateSizes () {
  const output = runCommand('cargo', [
    'bloat',
    '--release',
    '--crates',
    '-n',
    '0',
    '--message-format',
    'json',
    '-p',
    'libdatadog',
    '--lib',
  ])

  return JSON.parse(output)
}

function appendCrateReport (lines, profile) {
  const crates = profile.crates
    .map(crate => ({ ...crate, name: crate.name.replaceAll('_', '-') }))
  const attributedBytes = crates.reduce((total, crate) => total + crate.size, 0)
  const overheadBytes = profile['text-section-size'] - attributedBytes
  if (overheadBytes > 0) {
    crates.push({ name: 'unattributed .text overhead', size: overheadBytes })
    crates.sort((left, right) => right.size - left.size)
  }
  const visible = crates.filter(crate => crate.size >= 2048)
  const otherBytes = crates
    .filter(crate => crate.size < 2048)
    .reduce((total, crate) => total + crate.size, 0)

  if (otherBytes > 0) {
    visible.push({ name: 'other crates (<2 KiB each)', size: otherBytes })
  }

  lines.push(
    '',
    '### Code by Rust crate',
    '',
    '| Crate | Bytes | KiB | Share of native code |',
    '| --- | ---: | ---: | ---: |',
  )

  for (const crate of visible) {
    const share = `${(crate.size / profile['text-section-size'] * 100).toFixed(1)}%`
    lines.push(
      `| ${crate.name} | ${formatBytes(crate.size)} | `
      + `${formatKibibytes(crate.size)} | ${share} |`,
    )
  }

  lines.push(
    '',
    `.text section: ${formatBytes(profile['text-section-size'])} bytes `
    + `(${formatKibibytes(profile['text-section-size'])} KiB).`,
    '',
    'Crate ownership comes from cargo-bloat using a separate symbol-preserving release build. '
    + 'It attributes native code only; data, unwind information, symbols, and file alignment '
    + 'remain in the section and artifact totals above.',
  )
}

function createReport (artifactPath, profile) {
  const artifactBytes = fs.statSync(artifactPath).size
  const sections = readSections(artifactPath)
  const totalSectionBytes = sections.reduce((total, section) => total + section.bytes, 0)
  const lines = [
    '## libdatadog N-API size',
    '',
    '| Native artifact | Bytes | KiB |',
    '| --- | ---: | ---: |',
    `| **Shipped .node file** | **${formatBytes(artifactBytes)}** | `
    + `**${formatKibibytes(artifactBytes)}** |`,
    '',
    '### Native binary sections',
    '',
    '| Section/segment | Bytes | KiB | Share |',
    '| --- | ---: | ---: | ---: |',
  ]

  for (const section of sections) {
    const share = `${(section.bytes / totalSectionBytes * 100).toFixed(1)}%`
    lines.push(
      `| ${section.name} | ${formatBytes(section.bytes)} | `
      + `${formatKibibytes(section.bytes)} | ${share} |`,
    )
  }

  if (profile) appendCrateReport(lines, profile)

  lines.push('', `Generated from \`${path.relative(process.cwd(), artifactPath)}\`.`)
  return lines.join('\n')
}

if (require.main === module) {
  const artifactPath = process.argv[2] ? path.resolve(process.argv[2]) : findArtifact()
  const report = createReport(artifactPath, readCrateSizes())
  console.log(report)

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)
  }
}

module.exports = {
  createReport,
  parseDarwinSections,
  parseElfSections,
}
