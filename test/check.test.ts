import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { isBlocked, isError, isOk, blocked, error } from '../src/core/outcome.ts'
import type { GitRemote, GitRepositoryAdapter } from '../src/adapters/git-repository.ts'
import type { GitHubGatewayAdapter } from '../src/adapters/github-gateway.ts'
import type { ResolvedGitHubRepository } from '../src/adapters/github-gateway.ts'
import type { TaskMapLoader, TaskMapLoadOutcome } from '../src/map/loader.ts'
import type { LocalControlStore } from '../src/control/control-store.ts'
import { fsControlStore } from '../src/control/control-store.ts'
import { checkMap } from '../src/runner/check.ts'
import type { CheckMapFinding, CheckMapOutcome } from '../src/runner/check.ts'
import { HOST, MAP_URL, REPO, member, memberA, memberB, rawLoad, rawRef } from './helpers/map-fixtures.ts'

const MAP_URL_OTHER = 'https://github.com/acme/gadget/issues/7'

const REPOSITORY: ResolvedGitHubRepository = {
  githubHost: HOST,
  repositoryId: REPO,
  owner: 'acme',
  name: 'widget',
  defaultBranch: 'main',
}

const VALID_CONFIG = `${JSON.stringify(
  {
    schema: 'norn-run:v1',
    targetBranch: 'main',
    tests: [{ argv: ['npm', 'test'], timeoutMs: 60_000 }],
    worker: { model: 'provider-a/model-x', thinking: 'medium', timeoutMs: 1_000 },
    reviewer: { model: 'provider-b/model-y', thinking: 'high', timeoutMs: 1_000 },
    trustedEvidenceAuthorIds: ['MDQ6VXlcjIxMzY3'],
  },
  null,
  2,
)}\n`

function fakeGit(remotes: readonly GitRemote[] = [{ name: 'origin', url: 'https://github.com/acme/widget.git' }]) {
  const adapter: GitRepositoryAdapter = {
    async resolveRoot(cwd: string) {
      return { kind: 'ok' as const, value: cwd }
    },
    async listRemotes() {
      return { kind: 'ok' as const, value: remotes }
    },
  }
  return adapter
}

function failingGit(failure: { code: 'git-unavailable' | 'git-failed'; reason: string }) {
  const adapter: GitRepositoryAdapter = {
    async resolveRoot() {
      return error({ scope: 'operation', code: failure.code, reason: failure.reason })
    },
    async listRemotes() {
      throw new Error('must not be reached')
    },
  }
  return adapter
}

function fakeGateway(result: 'ok' | 'not-found' | 'unauthenticated' | 'unavailable') {
  return {
    calls: 0,
    async resolveRepository() {
      const gateway = this as { calls: number }
      gateway.calls += 1
      if (result === 'ok') return { kind: 'ok' as const, value: REPOSITORY }
      if (result === 'not-found') {
        return {
          kind: 'blocked' as const,
          scope: 'operation' as const,
          code: 'repository-not-found' as const,
          reason: 'not found',
          sharedWrite: 'none' as const,
          evidence: [],
        }
      }
      if (result === 'unauthenticated') {
        return {
          kind: 'blocked' as const,
          scope: 'operation' as const,
          code: 'github-unauthenticated' as const,
          reason: 'run gh auth login',
          sharedWrite: 'none' as const,
          evidence: [],
        }
      }
      return { kind: 'error' as const, code: 'github-unavailable' as const, reason: 'timeout' }
    },
    async authenticatedActor() {
      throw new Error('check does not resolve the actor')
    },
  } as GitHubGatewayAdapter & { calls: number }
}

function fakeLoader(script: readonly TaskMapLoadOutcome[]) {
  return {
    calls: 0,
    async loadTaskMap() {
      const loader = this as { calls: number }
      const outcome = script[loader.calls]
      loader.calls += 1
      if (outcome === undefined) throw new Error(`unexpected load #${loader.calls}`)
      return outcome
    },
  } as TaskMapLoader & { calls: number }
}

/** The control store, wrapped so any write attempt fails the test. */
function readOnlyStore(store: LocalControlStore): LocalControlStore & { writes: string[] } {
  const writes: string[] = []
  return {
    writes,
    repositoryHome: (identity) => store.repositoryHome(identity),
    async readMetadataText(home) {
      return store.readMetadataText(home)
    },
    async readConfigText(home) {
      return store.readConfigText(home)
    },
    async writeRepositorySetup() {
      writes.push('writeRepositorySetup')
      throw new Error('check must not write configuration')
    },
    async findActiveRuns(home) {
      return store.findActiveRuns(home)
    },
  }
}

type Harness = {
  cwd: string
  nornHome: string
  git: GitRepositoryAdapter
  gateway: GitHubGatewayAdapter & { calls: number }
  loader: TaskMapLoader & { calls: number }
  store: LocalControlStore & { writes: string[] }
  readonly filesBefore: readonly string[]
  cleanup: () => void
}

async function setup(options: {
  config?: 'valid' | 'invalid' | 'none'
  remotes?: readonly GitRemote[]
  gateway?: 'ok' | 'not-found' | 'unauthenticated' | 'unavailable'
  git?: GitRepositoryAdapter
  loaderScript?: readonly TaskMapLoadOutcome[]
} = {}): Promise<Harness> {
  const nornHome = mkdtempSync(join(tmpdir(), 'norn-check-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'norn-check-cwd-'))
  const baseStore = fsControlStore(nornHome)
  const store = readOnlyStore(baseStore)
  if ((options.config ?? 'valid') !== 'none') {
    const home = baseStore.repositoryHome({ githubHost: HOST, repositoryId: REPO })
    const written = await baseStore.writeRepositorySetup(home, {
      metadataJson: `${JSON.stringify({ schema: 'norn-repository-metadata:v1' })}\n`,
      configJson: options.config === 'invalid' ? '{ not json' : VALID_CONFIG,
    })
    assert.ok(written.kind === 'ok')
  }
  const git = options.git ?? fakeGit(options.remotes)
  const gateway = fakeGateway(options.gateway ?? 'ok')
  const loader = fakeLoader(
    options.loaderScript ?? [
      { kind: 'ok', value: rawLoad([memberA(), memberB()]) },
      { kind: 'ok', value: rawLoad([memberA(), memberB()]) },
    ],
  )
  const filesBefore = listFiles(nornHome)
  return {
    cwd,
    nornHome,
    git,
    gateway,
    loader,
    store,
    filesBefore,
    cleanup: () => {
      rmSync(nornHome, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const files: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else files.push(path)
    }
  }
  walk(root)
  return files.sort()
}

function findingKinds(outcome: CheckMapOutcome): string[] {
  assert.ok(isBlocked(outcome))
  if (outcome.kind !== 'blocked') return []
  const report = outcome.evidence[0] as { findings?: CheckMapFinding[] }
  return (report.findings ?? []).map((finding) => finding.kind)
}

describe('checkMap — the repository/config identity and map-contract preflight', () => {
  it('passes a healthy repository and map, reporting the accepted snapshot', async () => {
    const harness = await setup()
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.ok(isOk(outcome))
      if (outcome.kind === 'ok') {
        assert.deepEqual(outcome.value.findings, [])
        assert.equal(outcome.value.mapUrl, MAP_URL)
        assert.deepEqual(outcome.value.repository, REPOSITORY)
        assert.equal(outcome.value.repositoryHome, harness.store.repositoryHome({ githubHost: HOST, repositoryId: REPO }))
        assert.equal(outcome.value.config?.config.targetBranch, 'main')
        assert.equal(outcome.value.snapshot?.ref.issueId, 'I_map')
        assert.equal(outcome.value.snapshot?.tickets.length, 2)
      }
      assert.equal(harness.loader.calls, 2) // stable read converged
      assert.deepEqual(harness.store.writes, [])
      // No run-owned resources: the Norn-home file set is exactly as init
      // left it — no maps/, runs/, or locks/ directories were created.
      assert.deepEqual(listFiles(harness.nornHome), [...harness.filesBefore])
      assert.equal(existsSync(join(harness.nornHome, 'repositories', HOST, REPO, 'maps')), false)
      assert.equal(existsSync(join(harness.nornHome, 'repositories', HOST, REPO, 'runs')), false)
      assert.equal(existsSync(join(harness.nornHome, 'repositories', HOST, REPO, 'locks')), false)
    } finally {
      harness.cleanup()
    }
  })

  it('creates no files and no run-owned resources even when findings exist', async () => {
    const harness = await setup({ config: 'none' })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.ok(isBlocked(outcome))
      assert.deepEqual(harness.store.writes, [])
      assert.deepEqual(listFiles(harness.nornHome), [...harness.filesBefore])
    } finally {
      harness.cleanup()
    }
  })

  it('rejects #123 shorthand with an invalid-map-url finding and no GitHub reads', async () => {
    const harness = await setup()
    try {
      const outcome = await checkMap(harness, '#123')
      assert.deepEqual(findingKinds(outcome), ['invalid-map-url'])
      assert.equal(harness.gateway.calls, 0)
      assert.equal(harness.loader.calls, 0)
    } finally {
      harness.cleanup()
    }
  })

  it('reports a missing repository-home configuration alongside a healthy map', async () => {
    const harness = await setup({ config: 'none' })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.deepEqual(findingKinds(outcome), ['no-config'])
    } finally {
      harness.cleanup()
    }
  })

  it('reports an invalid config.json with its violations', async () => {
    const harness = await setup({ config: 'invalid' })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.deepEqual(findingKinds(outcome), ['invalid-config'])
      if (outcome.kind === 'blocked') {
        const report = outcome.evidence[0] as { findings?: CheckMapFinding[] }
        const finding = report?.findings?.[0]
        assert.ok(finding?.kind === 'invalid-config')
        assert.ok(finding.violations.length > 0)
      }
    } finally {
      harness.cleanup()
    }
  })

  it('reports a map URL that addresses a different repository than the checkout', async () => {
    const harness = await setup()
    try {
      const outcome = await checkMap(harness, MAP_URL_OTHER)
      assert.deepEqual(findingKinds(outcome), ['map-repository-mismatch'])
    } finally {
      harness.cleanup()
    }
  })

  it('reports a gateway repository-not-found without reading the map', async () => {
    const harness = await setup({ gateway: 'not-found' })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.deepEqual(findingKinds(outcome), ['repository-not-found'])
      assert.equal(harness.loader.calls, 0)
    } finally {
      harness.cleanup()
    }
  })

  it('reports a missing GitHub authentication as a finding', async () => {
    const harness = await setup({ gateway: 'unauthenticated' })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.deepEqual(findingKinds(outcome), ['github-unauthenticated'])
    } finally {
      harness.cleanup()
    }
  })

  it('reports an unresolvable map issue from the loader as a finding', async () => {
    const harness = await setup({
      loaderScript: [
        {
          kind: 'blocked',
          scope: 'operation',
          code: 'issue-not-found',
          reason: 'no such issue',
          sharedWrite: 'none',
          evidence: [],
        },
      ],
    })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.deepEqual(findingKinds(outcome), ['issue-not-found'])
    } finally {
      harness.cleanup()
    }
  })

  it('reports topology violations with the complete finding set', async () => {
    const invalid = rawLoad([
      memberA(),
      member('I_B', 2, { blockers: [rawRef('I_outside', 9)] }),
    ])
    const harness = await setup({
      loaderScript: [
        { kind: 'ok', value: invalid },
        { kind: 'ok', value: invalid },
      ],
    })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.deepEqual(findingKinds(outcome), ['invalid-map'])
      if (outcome.kind === 'blocked') {
        const report = outcome.evidence[0] as { findings?: CheckMapFinding[] }
        const finding = report?.findings?.[0]
        assert.ok(finding?.kind === 'invalid-map')
        assert.deepEqual(
          finding.findings.map((entry) => entry.code),
          ['external-blocker'],
        )
      }
    } finally {
      harness.cleanup()
    }
  })

  it('reports changed-input when three loads never converge', async () => {
    const harness = await setup({
      loaderScript: [
        { kind: 'ok', value: rawLoad([memberA()]) },
        { kind: 'ok', value: rawLoad([memberA(), memberB()]) },
        { kind: 'ok', value: rawLoad([memberA(), memberB(), member('I_C', 3)]) },
      ],
    })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.deepEqual(findingKinds(outcome), ['changed-input'])
      assert.equal(harness.loader.calls, 3)
    } finally {
      harness.cleanup()
    }
  })

  it('reports a cwd outside any Git repository while still checking the map', async () => {
    const outsideGit: GitRepositoryAdapter = {
      async resolveRoot(cwd) {
        return error({
          scope: 'operation',
          code: 'not-a-repository',
          reason: `${cwd} is not inside a Git repository`,
        })
      },
      async listRemotes() {
        throw new Error('must not be reached')
      },
    }
    const harness = await setup({ git: outsideGit })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      // The URL, configuration, and map contract are independent of the local
      // repository fact: the map contract still ran and converged.
      assert.deepEqual(findingKinds(outcome), ['not-a-repository'])
      assert.equal(harness.loader.calls, 2)
    } finally {
      harness.cleanup()
    }
  })
})

describe('checkMap — infrastructure errors', () => {
  it('surfaces a git infrastructure failure as an error', async () => {
    const harness = await setup({ git: failingGit({ code: 'git-failed', reason: 'corrupt' }) })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.ok(isError(outcome))
      if (outcome.kind === 'error') assert.equal(outcome.code, 'git-failed')
    } finally {
      harness.cleanup()
    }
  })

  it('surfaces a gateway infrastructure failure as an error', async () => {
    const harness = await setup({ gateway: 'unavailable' })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.ok(isError(outcome))
      if (outcome.kind === 'error') assert.equal(outcome.code, 'github-unavailable')
    } finally {
      harness.cleanup()
    }
  })

  it('surfaces a loader infrastructure failure as an error', async () => {
    const harness = await setup({
      loaderScript: [
        { kind: 'error', scope: 'operation', code: 'github-unavailable', reason: 'mid-read failure', sharedWrite: 'none', evidence: [] },
      ],
    })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.ok(isError(outcome))
      if (outcome.kind === 'error') assert.equal(outcome.code, 'github-unavailable')
    } finally {
      harness.cleanup()
    }
  })
})
