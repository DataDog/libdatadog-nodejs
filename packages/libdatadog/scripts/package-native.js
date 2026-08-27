'use strict'

const fs = require('node:fs')
const path = require('node:path')

const packageJson = require('../package.json')
const root = path.join(__dirname, '..')
const artifacts = path.join(root, 'dist', 'native')
const output = path.join(root, 'dist', 'packages')
const targets = {
  'aarch64-apple-darwin': {
    packageTarget: 'darwin-arm64',
    cpu: ['arm64'],
    os: ['darwin'],
  },
  'x86_64-apple-darwin': {
    packageTarget: 'darwin-x64',
    cpu: ['x64'],
    os: ['darwin'],
  },
  'aarch64-unknown-linux-gnu': {
    packageTarget: 'linux-arm64-gnu',
    cpu: ['arm64'],
    libc: ['glibc'],
    os: ['linux'],
  },
  'aarch64-unknown-linux-musl': {
    packageTarget: 'linux-arm64-musl',
    cpu: ['arm64'],
    libc: ['musl'],
    os: ['linux'],
  },
  'x86_64-unknown-linux-gnu': {
    packageTarget: 'linux-x64-gnu',
    cpu: ['x64'],
    libc: ['glibc'],
    os: ['linux'],
  },
  'x86_64-unknown-linux-musl': {
    packageTarget: 'linux-x64-musl',
    cpu: ['x64'],
    libc: ['musl'],
    os: ['linux'],
  },
}

if (!fs.existsSync(artifacts)) throw new Error('native artifacts were not built')

const configuredTargets = packageJson.napi.targets.map((triple) => {
  const target = targets[triple]

  if (!target) throw new Error(`unsupported napi-rs target: ${triple}`)

  return { triple, ...target }
})
const targetsByPackage = new Map(
  configuredTargets.map(target => [target.packageTarget, target]),
)
const nativeArtifacts = fs.readdirSync(artifacts)
  .filter(artifact => /^libdatadog\..+\.node$/.test(artifact))

if (nativeArtifacts.length === 0) throw new Error('native artifacts were not built')

fs.rmSync(output, { force: true, recursive: true })

for (const artifact of nativeArtifacts) {
  const packageTarget = artifact.slice('libdatadog.'.length, -'.node'.length)
  const target = targetsByPackage.get(packageTarget)

  if (!target) throw new Error(`unsupported native artifact: ${artifact}`)

  const packageName = `${packageJson.name}-${packageTarget}`
  const packageDirectory = path.join(output, packageTarget)

  fs.mkdirSync(packageDirectory, { recursive: true })
  fs.copyFileSync(
    path.join(artifacts, artifact),
    path.join(packageDirectory, artifact),
  )
  fs.writeFileSync(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: packageName,
      version: packageJson.version,
      cpu: target.cpu,
      main: artifact,
      files: [artifact],
      description: packageJson.description,
      license: packageJson.license,
      engines: packageJson.engines,
      os: target.os,
      ...(target.libc ? { libc: target.libc } : {}),
    }, undefined, 2) + '\n',
  )
  fs.writeFileSync(
    path.join(packageDirectory, 'README.md'),
    `# \`${packageName}\`\n\nThis is the **${target.triple}** binary for \`${packageJson.name}\`\n`,
  )
}
