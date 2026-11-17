'use strict'

// Local-only tarballs: the unpublished WASM dependency must also resolve inside tracer test sandboxes.
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const destination = path.resolve(process.argv[2])
const source = path.resolve(__dirname, '../packages/libdatadog')
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'libdatadog-api-security-'))
fs.mkdirSync(destination, { recursive: true })

function npmPack (directory, options = []) {
  const output = execFileSync('npm', ['pack', '--json', '--ignore-scripts', ...options], {
    cwd: directory,
    encoding: 'utf8',
  })
  return JSON.parse(output)[0]
}

function pack (directory) {
  const result = npmPack(directory, ['--pack-destination', destination])
  const archive = path.join(destination, result.filename)
  const hash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex').slice(0, 12)
  const pinned = archive.slice(0, -4) + '-' + hash + '.tgz'
  fs.renameSync(archive, pinned)
  return 'file:' + pinned
}

try {
  const wasm = pack(path.join(source, 'wasm'))
  for (const { path: name } of npmPack(source, ['--dry-run']).files) {
    const target = path.join(staging, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(source, name), target)
  }
  const manifest = path.join(staging, 'package.json')
  const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  metadata.dependencies['@datadog/libdatadog-wasm'] = wasm
  delete metadata.workspaces
  fs.writeFileSync(manifest, JSON.stringify(metadata, undefined, 2) + '\n')
  console.log(JSON.stringify({ libdatadog: pack(staging), wasm }, undefined, 2))
} finally {
  fs.rmSync(staging, { recursive: true, force: true })
}
