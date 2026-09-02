'use strict'

const path = require('node:path')
const { execFileSync } = require('node:child_process')

const repositoryRoot = path.join(__dirname, '..')
const packageJson = require('../packages/libdatadog/package.json')
const trees = [
  ...packageJson.napi.targets.map(target => ({ package: 'libdatadog', target })),
  { package: 'libdatadog-wasm', target: 'wasm32-unknown-unknown' },
]

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

function findDuplicateVersions (dependencies) {
  const versionsByPackage = new Map()
  const failures = []

  for (const { name, version } of dependencies) {
    const versions = versionsByPackage.get(name) ?? new Set()
    versions.add(version)
    versionsByPackage.set(name, versions)
  }

  for (const [name, versions] of versionsByPackage) {
    if (versions.size > 1) {
      failures.push({ name, versions: [...versions] })
    }
  }
  return failures
}

function findForbiddenDependencies (dependencies, tree) {
  const failures = []

  for (const dependency of dependencies) {
    const isTokio = dependency.name === 'tokio'
    const isTokioCompanion = dependency.name.startsWith('tokio-')
    if (!isTokio && !isTokioCompanion) continue

    const parent = dependency.path.at(-2)
    const allowedNapiBridge = tree.package === 'libdatadog'
      && isTokio
      && parent === 'napi'
    if (!allowedNapiBridge) failures.push(dependency)
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

    for (const failure of findDuplicateVersions(dependencies)) {
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
    console.log('Tokio is limited to the NAPI async bridge and absent from WASM.')
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
