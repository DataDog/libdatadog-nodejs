'use strict'

const path = require('node:path')
const { execFileSync } = require('node:child_process')

const repositoryRoot = path.join(__dirname, '..')
const trees = [
  { package: 'libdatadog-wasm', target: 'wasm32-unknown-unknown' },
  { package: 'remote-config', target: 'wasm32-unknown-unknown' },
]
// libdd-tuf 0.3.1 uses older dependency majors. Exact sets keep unrelated duplicates failing validation.
const remoteConfigDuplicatePackages = new Map([
  ['http', new Set(['0.2.12', '1.5.0'])],
  ['itoa', new Set(['0.4.8', '1.0.18'])],
  ['syn', new Set(['2.0.119', '3.0.4'])],
  ['thiserror', new Set(['1.0.69', '2.0.20'])],
  ['thiserror-impl', new Set(['1.0.69', '2.0.20'])],
  ['untrusted', new Set(['0.7.1', '0.9.0'])],
])
const remoteConfigTokioPackages = new Set(['tokio', 'tokio-macros', 'tokio-util'])

/**
 * @param {Set<string>} actual
 * @param {Set<string>} expected
 */
function setsEqual (actual, expected) {
  if (actual.size !== expected.size) return false

  for (const value of actual) {
    if (!expected.has(value)) return false
  }
  return true
}

function parseCargoTree (output) {
  const paths = []
  const stack = []

  for (const line of output.split('\n')) {
    const match = line.match(/^(\d+)(\S+) v(\S+)/)
    if (!match) continue

    const [, depthValue, name, version] = match
    const depth = Number(depthValue)
    stack.length = depth
    stack[depth] = name
    paths.push({ depth, name, path: [...stack], version })
  }

  return paths
}

/**
 * @param {{ name: string, version: string }[]} dependencies
 * @param {{ package?: string }} [tree]
 */
function findDuplicateVersions (dependencies, tree = {}) {
  const versionsByPackage = new Map()
  const failures = []

  for (const { name, version } of dependencies) {
    const versions = versionsByPackage.get(name) ?? new Set()
    versions.add(version)
    versionsByPackage.set(name, versions)
  }

  for (const [name, versions] of versionsByPackage) {
    const allowedVersions = remoteConfigDuplicatePackages.get(name)
    const allowedRemoteConfigDuplicate = tree.package === 'remote-config'
      && allowedVersions !== undefined
      && setsEqual(versions, allowedVersions)
    if (versions.size > 1 && !allowedRemoteConfigDuplicate) {
      failures.push({ name, versions: [...versions] })
    }
  }
  return failures
}

/**
 * @template {{ name: string }} Dependency
 * @param {Dependency[]} dependencies
 * @param {{ package?: string }} [tree]
 * @returns {Dependency[]}
 */
function findForbiddenDependencies (dependencies, tree = {}) {
  const failures = []

  for (const dependency of dependencies) {
    const isTokio = dependency.name === 'tokio'
    const isTokioCompanion = dependency.name.startsWith('tokio-')
    if (!isTokio && !isTokioCompanion) continue

    const allowedRemoteConfigRuntime = tree.package === 'remote-config'
      && remoteConfigTokioPackages.has(dependency.name)
      && dependency.path.includes('libdd-remote-config')
    if (!allowedRemoteConfigRuntime) failures.push(dependency)
  }

  return failures
}

function checkTrees () {
  const duplicateFailures = []
  const forbiddenFailures = []

  for (const tree of trees) {
    const output = execFileSync('cargo', [
      'tree',
      '--locked',
      '--package', tree.package,
      '--target', tree.target,
      '--edges', 'normal,build',
      '--prefix', 'depth',
      '--format', '{p}',
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
    const dependencies = parseCargoTree(output)

    for (const failure of findDuplicateVersions(dependencies, tree)) {
      duplicateFailures.push({ ...failure, ...tree })
    }
    for (const failure of findForbiddenDependencies(dependencies, tree)) {
      forbiddenFailures.push({ ...failure, ...tree })
    }
  }

  if (duplicateFailures.length > 0) {
    console.error('Dependencies with multiple versions found:')
    for (const failure of duplicateFailures) {
      console.error(
        `- ${failure.package} (${failure.target}): `
        + `${failure.name} ${failure.versions.join(', ')}`,
      )
    }
  } else {
    console.log(`No dependency version duplicates found in ${trees.length} artifact trees.`)
  }

  if (forbiddenFailures.length > 0) {
    console.error('Forbidden Tokio dependencies found:')
    for (const failure of forbiddenFailures) {
      console.error(
        `- ${failure.package} (${failure.target}): `
        + `${failure.name} through ${failure.path.join(' -> ')}`,
      )
    }
  } else {
    console.log('Tokio is limited to the dedicated remote config artifact.')
  }

  if (duplicateFailures.length > 0 || forbiddenFailures.length > 0) {
    process.exitCode = 1
  }
}

if (require.main === module) checkTrees()

module.exports = {
  findDuplicateVersions,
  findForbiddenDependencies,
  parseCargoTree,
}
