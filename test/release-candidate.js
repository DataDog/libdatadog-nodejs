'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const {
  main,
  resolveCandidate,
} = require('../scripts/release-candidate')

const repository = 'DataDog/libdatadog-nodejs'
const releaseSha = 'release-sha'
const releaseTree = 'release-tree'
const headSha = 'head-sha'
const artifactName = `release-candidate-${releaseTree}`

test('selects the newest successful candidate for the merged release tree', async () => {
  const requests = []
  const candidate = await resolveCandidate({
    repository,
    releaseSha,
    releaseTree,
    request: createRequest({
      artifacts: {
        30: [
          createArtifact({ expired: true }),
          createArtifact({ name: 'release-candidate-stale-tree' }),
        ],
        20: [createArtifact()],
      },
      pulls: [createPull()],
      requests,
      runs: [
        createRun({ id: 10, path: '.github/workflows/other.yml' }),
        createRun({ id: 20 }),
        createRun({ id: 30 }),
      ],
    }),
  })

  assert.deepStrictEqual(candidate, {
    artifactName,
    runId: '20',
  })
  assert.deepStrictEqual(requests, [
    `/repos/${repository}/commits/${releaseSha}/pulls`,
    `/repos/${repository}/actions/workflows/build.yml/runs?event=pull_request&head_sha=${headSha}&per_page=100&status=success`,
    `/repos/${repository}/actions/runs/30/artifacts?per_page=100`,
    `/repos/${repository}/actions/runs/20/artifacts?per_page=100`,
  ])
})

test('requires one merged pull request from the release branch and repository', async (context) => {
  const cases = [
    ['no associated pull request', []],
    ['a malformed pull request', [undefined]],
    ['a pull request without refs', [{}]],
    ['a pull request without a head repository', [{ base: {}, head: {} }]],
    ['multiple associated pull requests', [createPull(), createPull()]],
    ['an open pull request', [createPull({ state: 'open' })]],
    ['a pull request for another branch', [createPull({ baseRef: 'main' })]],
    ['a pull request from another repository', [createPull({ headRepository: 'example/fork' })]],
    ['a pull request for another merge commit', [createPull({ mergeSha: 'other-sha' })]],
  ]

  for (const [name, pulls] of cases) {
    await context.test(name, async () => {
      await assert.rejects(resolveCandidate({
        repository,
        releaseSha,
        releaseTree,
        request: createRequest({ pulls }),
      }), {
        message: `Expected one merged v0.x pull request for ${releaseSha}`,
      })
    })
  }
})

test('rejects unsuccessful, unrelated, expired, and stale-tree artifacts', async () => {
  const invalidRuns = [
    undefined,
    {},
    { head_repository: undefined },
    createRun({ id: 1, event: 'push' }),
    createRun({ id: 2, status: 'in_progress' }),
    createRun({ conclusion: 'failure', id: 3 }),
    createRun({ head: 'other-head', id: 4 }),
    createRun({ headRepository: 'example/fork', id: 5 }),
    createRun({ id: 6, path: '.github/workflows/release.yml' }),
  ]
  const request = createRequest({
    artifacts: {
      7: [
        undefined,
        {},
        { workflow_run: undefined },
        createArtifact({ expired: true }),
        createArtifact({ head: 'other-head' }),
        createArtifact({ name: 'release-candidate-stale-tree' }),
      ],
    },
    pulls: [createPull()],
    runs: [...invalidRuns, createRun({ id: 7 })],
  })

  await assert.rejects(resolveCandidate({
    repository,
    releaseSha,
    releaseTree,
    request,
  }), {
    message: `No successful ${artifactName} artifact found for pull request 236`,
  })
})

test('rejects ambiguous artifacts from one workflow run', async () => {
  const request = createRequest({
    artifacts: {
      20: [createArtifact(), createArtifact()],
    },
    pulls: [createPull()],
    runs: [createRun({ id: 20 })],
  })

  await assert.rejects(resolveCandidate({
    repository,
    releaseSha,
    releaseTree,
    request,
  }), {
    message: `Run 20 has multiple ${artifactName} artifacts`,
  })
})

test('resolves a candidate through the GitHub API command path', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-candidate-'))
  const outputFile = path.join(directory, 'github-output')
  const originalEnvironment = { ...process.env }
  const originalFetch = globalThis.fetch

  delete process.env.GITHUB_API_URL
  process.env.GITHUB_OUTPUT = outputFile
  process.env.GITHUB_REPOSITORY = repository
  process.env.GITHUB_SHA = releaseSha
  process.env.GITHUB_TOKEN = 'token'
  process.env.RELEASE_TREE = releaseTree
  globalThis.fetch = async function fetch (url) {
    const { pathname } = new URL(url)

    if (pathname.endsWith('/pulls')) {
      return Response.json([createPull()])
    }
    if (pathname.includes('/actions/workflows/')) {
      return Response.json({ workflow_runs: [createRun()] })
    }
    if (pathname.includes('/artifacts')) {
      return Response.json({ artifacts: [createArtifact()] })
    }

    return new Response('not found', { status: 404 })
  }

  try {
    await main()

    assert.strictEqual(
      fs.readFileSync(outputFile, 'utf8'),
      `artifact-name=${artifactName}\nrun-id=20\n`,
    )
  } finally {
    process.env = originalEnvironment
    globalThis.fetch = originalFetch
    fs.rmSync(directory, { force: true, recursive: true })
  }
})

test('runs the resolver through the process entry point', () => {
  const result = spawnSync(process.execPath, [require.resolve('../scripts/release-candidate')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REPOSITORY: repository,
      GITHUB_SHA: releaseSha,
      GITHUB_TOKEN: '',
      RELEASE_TREE: releaseTree,
    },
  })

  assert.strictEqual(result.status, 1)
  assert.match(result.stderr, /GITHUB_TOKEN is required/)
})

test('reports GitHub API failures through the command path', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-candidate-'))
  const originalEnvironment = { ...process.env }
  const originalFetch = globalThis.fetch

  process.env.GITHUB_API_URL = 'https://api.github.test'
  process.env.GITHUB_OUTPUT = path.join(directory, 'github-output')
  process.env.GITHUB_REPOSITORY = repository
  process.env.GITHUB_SHA = releaseSha
  process.env.GITHUB_TOKEN = 'token'
  process.env.RELEASE_TREE = releaseTree
  globalThis.fetch = async function fetch () {
    return new Response('failure', { status: 500 })
  }

  try {
    await assert.rejects(main(), {
      message: `GitHub API returned 500 for /repos/${repository}/commits/${releaseSha}/pulls: failure`,
    })
  } finally {
    process.env = originalEnvironment
    globalThis.fetch = originalFetch
    fs.rmSync(directory, { force: true, recursive: true })
  }
})

/**
 * @param {object} [overrides]
 * @param {string} [overrides.baseRef]
 * @param {string} [overrides.headRepository]
 * @param {string} [overrides.mergeSha]
 * @param {string} [overrides.state]
 * @returns {object}
 */
function createPull ({
  baseRef = 'v0.x',
  headRepository = repository,
  mergeSha = releaseSha,
  state = 'closed',
} = {}) {
  return {
    base: { ref: baseRef },
    head: {
      repo: { full_name: headRepository },
      sha: headSha,
    },
    merge_commit_sha: mergeSha,
    merged_at: '2026-09-01T17:48:44Z',
    number: 236,
    state,
  }
}

/**
 * @param {object} [overrides]
 * @param {string} [overrides.conclusion]
 * @param {string} [overrides.event]
 * @param {string} [overrides.head]
 * @param {string} [overrides.headRepository]
 * @param {number} [overrides.id]
 * @param {string} [overrides.path]
 * @param {string} [overrides.status]
 * @returns {object}
 */
function createRun ({
  conclusion = 'success',
  event = 'pull_request',
  head = headSha,
  headRepository = repository,
  id = 20,
  path = '.github/workflows/build.yml',
  status = 'completed',
} = {}) {
  return {
    conclusion,
    event,
    head_repository: { full_name: headRepository },
    head_sha: head,
    id,
    path,
    status,
  }
}

/**
 * @param {object} [overrides]
 * @param {boolean} [overrides.expired]
 * @param {string} [overrides.head]
 * @param {string} [overrides.name]
 * @returns {object}
 */
function createArtifact ({
  expired = false,
  head = headSha,
  name = artifactName,
} = {}) {
  return {
    expired,
    name,
    workflow_run: { head_sha: head },
  }
}

/**
 * @param {object} options
 * @param {Record<number, object[]>} [options.artifacts]
 * @param {object[]} [options.pulls]
 * @param {string[]} [options.requests]
 * @param {object[]} [options.runs]
 * @returns {(pathname: string) => Promise<unknown>}
 */
function createRequest ({
  artifacts = {},
  pulls = [],
  requests = [],
  runs = [],
}) {
  /**
   * @param {string} pathname
   * @returns {Promise<unknown>}
   */
  async function request (pathname) {
    requests.push(pathname)

    if (pathname.endsWith('/pulls')) return pulls
    if (pathname.includes('/actions/workflows/')) return { workflow_runs: runs }

    const match = pathname.match(/\/actions\/runs\/(\d+)\/artifacts/)
    if (match !== null) return { artifacts: artifacts[Number(match[1])] ?? [] }

    throw new Error(`Unexpected request: ${pathname}`)
  }

  return request
}
