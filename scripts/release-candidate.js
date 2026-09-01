'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const BUILD_WORKFLOW_PATH = '.github/workflows/build.yml'
const RELEASE_BRANCH = 'v0.x'

/**
 * @typedef {object} ResolveOptions
 * @property {string} repository
 * @property {string} releaseSha
 * @property {string} releaseTree
 * @property {(pathname: string) => Promise<unknown>} request
 */

/**
 * @typedef {object} ResolvedCandidate
 * @property {string} artifactName
 * @property {string} runId
 */

/**
 * @param {ResolveOptions} options
 * @returns {Promise<ResolvedCandidate>}
 */
async function resolveCandidate ({ repository, releaseSha, releaseTree, request }) {
  const pulls = await request(`/repos/${repository}/commits/${releaseSha}/pulls`)
  assert.ok(Array.isArray(pulls), 'GitHub returned an invalid pull request list')

  const releasePulls = []
  for (const pull of pulls) {
    if (isReleasePull(pull, repository, releaseSha)) {
      releasePulls.push(pull)
    }
  }

  if (releasePulls.length !== 1) {
    throw new Error(`Expected one merged ${RELEASE_BRANCH} pull request for ${releaseSha}`)
  }

  const releasePull = releasePulls[0]
  const headSha = releasePull.head.sha
  const query = new URLSearchParams({
    event: 'pull_request',
    head_sha: headSha,
    per_page: '100',
    status: 'success',
  })
  const runsResponse = await request(
    `/repos/${repository}/actions/workflows/build.yml/runs?${query}`,
  )
  assertRecord(runsResponse, 'workflow runs response')
  assert.ok(Array.isArray(runsResponse.workflow_runs), 'GitHub returned an invalid workflow run list')

  const runs = []
  for (const run of runsResponse.workflow_runs) {
    if (isCandidateRun(run, repository, headSha)) {
      runs.push(run)
    }
  }
  runs.sort((left, right) => right.id - left.id)

  const artifactName = `release-candidate-${releaseTree}`
  for (const run of runs) {
    const artifactsResponse = await request(
      `/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
    )
    assertRecord(artifactsResponse, 'workflow artifacts response')
    assert.ok(Array.isArray(artifactsResponse.artifacts), 'GitHub returned an invalid artifact list')

    const artifacts = []
    for (const artifact of artifactsResponse.artifacts) {
      if (isCandidateArtifact(artifact, artifactName, headSha)) {
        artifacts.push(artifact)
      }
    }

    assert.ok(artifacts.length < 2, `Run ${run.id} has multiple ${artifactName} artifacts`)
    if (artifacts.length === 1) {
      return {
        artifactName,
        runId: String(run.id),
      }
    }
  }

  throw new Error(`No successful ${artifactName} artifact found for pull request ${releasePull.number}`)
}

/**
 * @param {unknown} value
 * @param {string} repository
 * @param {string} releaseSha
 * @returns {boolean}
 */
function isReleasePull (value, repository, releaseSha) {
  if (!isRecord(value) || !isRecord(value.base) || !isRecord(value.head)) return false
  if (!isRecord(value.head.repo)) return false

  return value.state === 'closed'
    && typeof value.merged_at === 'string'
    && value.merge_commit_sha === releaseSha
    && value.base.ref === RELEASE_BRANCH
    && value.head.repo.full_name === repository
    && typeof value.head.sha === 'string'
    && typeof value.number === 'number'
}

/**
 * @param {unknown} value
 * @param {string} repository
 * @param {string} headSha
 * @returns {boolean}
 */
function isCandidateRun (value, repository, headSha) {
  if (!isRecord(value) || !isRecord(value.head_repository)) return false

  return value.event === 'pull_request'
    && value.status === 'completed'
    && value.conclusion === 'success'
    && value.head_sha === headSha
    && value.head_repository.full_name === repository
    && value.path === BUILD_WORKFLOW_PATH
    && typeof value.id === 'number'
}

/**
 * @param {unknown} value
 * @param {string} artifactName
 * @param {string} headSha
 * @returns {boolean}
 */
function isCandidateArtifact (value, artifactName, headSha) {
  if (!isRecord(value) || !isRecord(value.workflow_run)) return false

  return value.name === artifactName
    && value.expired === false
    && value.workflow_run.head_sha === headSha
}

/**
 * @param {string} token
 * @param {string} apiUrl
 * @param {string} pathname
 * @returns {Promise<unknown>}
 */
async function requestGithub (token, apiUrl, pathname) {
  // The release workflow runs this script on Node 24.
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  const response = await fetch(new URL(pathname, `${apiUrl.replace(/\/$/, '')}/`), {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub API returned ${response.status} for ${pathname}: ${body.slice(0, 200)}`)
  }

  return response.json()
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function assertRecord (value, name) {
  assert.ok(isRecord(value), `${name} is not an object`)
}

/**
 * @param {string} name
 * @returns {string}
 */
function environment (name) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

/**
 * @param {string} name
 * @param {string} value
 */
function writeOutput (name, value) {
  fs.appendFileSync(environment('GITHUB_OUTPUT'), `${name}=${value}\n`)
}

async function main () {
  const repository = environment('GITHUB_REPOSITORY')
  const candidate = await resolveCandidate({
    repository,
    releaseSha: environment('GITHUB_SHA'),
    releaseTree: environment('RELEASE_TREE'),
    request: requestGithub.bind(
      undefined,
      environment('GITHUB_TOKEN'),
      process.env.GITHUB_API_URL ?? 'https://api.github.com',
    ),
  })

  writeOutput('artifact-name', candidate.artifactName)
  writeOutput('run-id', candidate.runId)
}

if (require.main === module) {
  // CommonJS cannot use top-level await.
  // eslint-disable-next-line unicorn/prefer-top-level-await
  void main()
}

module.exports = {
  main,
  resolveCandidate,
}
