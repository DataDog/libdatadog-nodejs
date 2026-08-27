'use strict'

const path = require('node:path')
const { execFileSync } = require('node:child_process')

const repositoryRoot = path.join(__dirname, '..')
const packageJson = require('../packages/libdatadog/package.json')
const trees = [
  ...packageJson.napi.targets.map(target => ({ package: 'libdatadog', target })),
  { package: 'libdatadog', target: 'wasm32-unknown-unknown' },
]
// TODO: Remove these exceptions after porting the Datadog TUF changes onto
// modern upstream TUF and aligning the remaining remote config dependencies.
const remoteConfigDuplicatePackages = new Set([
  'getrandom',
  'hashbrown',
  'http',
  'itoa',
  'syn',
  'thiserror',
  'thiserror-impl',
  'untrusted',
])
// libdd-remote-config exposes a single-client API but still compiles its Tokio
// scheduler modules. The symbolized WASM report separately prevents Tokio code
// from reaching the shipped fallback.
const remoteConfigTokioPackages = new Set(['tokio', 'tokio-macros', 'tokio-util'])
// The existing agentless feature enables libdd-common/https across the native
// feature graph. LTO removes its unused implementation from the shipped addon.
const remoteConfigNativeFeatureUnion = new Set([
  ...remoteConfigTokioPackages,
  'tokio-rustls',
])

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
    if (versions.size > 1 && !isRemoteConfigDuplicate(dependencies, name)) {
      failures.push({ name, versions: [...versions] })
    }
  }
  return failures
}

function isRemoteConfigDuplicate (dependencies, name) {
  return remoteConfigDuplicatePackages.has(name)
    && dependencies.some(({ path }) => path.includes('libdd-remote-config'))
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
    const allowedRemoteConfigRuntime = remoteConfigTokioPackages.has(dependency.name)
      && dependency.path.includes('libdd-remote-config')
    const allowedNativeFeatureUnion = tree.target !== 'wasm32-unknown-unknown'
      && remoteConfigNativeFeatureUnion.has(dependency.name)
      && dependencies.some(({ name }) => name === 'libdd-remote-config')
    if (!allowedNapiBridge && !allowedRemoteConfigRuntime && !allowedNativeFeatureUnion) {
      failures.push(dependency)
    }
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
    console.log('Tokio is limited to the NAPI bridge and remote config runtime.')
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
