import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { canonicalJsonDigest } from '../src/core/digest.ts'
import type { Sha256Digest } from '../src/core/digest.ts'
import { computeMapRevision, computeTicketRevision } from '../src/core/revision.ts'
import { isBlocked, isError, isOk, error } from '../src/core/outcome.ts'
import type { GitRemote, GitRepositoryAdapter, GitDeliveryFactsAdapter } from '../src/adapters/git-repository.ts'
import type { GitHubGatewayAdapter, ResolvedGitHubRepository } from '../src/adapters/github-gateway.ts'
import type { ModelCatalogAdapter } from '../src/adapters/model-catalog.ts'
import type { IssueEvidenceReader, IssueEvidenceReadOutcome } from '../src/evidence/read.ts'
import type { TaskMapLoader, TaskMapLoadOutcome } from '../src/map/loader.ts'
import type { LocalControlStore } from '../src/control/control-store.ts'
import { fsControlStore } from '../src/control/control-store.ts'
import { resolveRunConfigText } from '../src/config/run-config.ts'
import { saveRunState } from '../src/runstate/run-state-store.ts'
import type { RunState } from '../src/runstate/types.ts'
import { NORN_VERSION } from '../src/version.ts'
import { checkMap } from '../src/runner/check.ts'
import type { CheckMapFinding, CheckMapOutcome } from '../src/runner/check.ts'
import { encodePathSegment } from '../src/config/paths.ts'
import { HOST, MAP_URL, REPO, memberA, memberB, rawLoad } from './helpers/map-fixtures.ts'
import {
  ACTOR_ID,
  BASE_SHA,
  BASE_TREE,
  DELIVERED_TREE,
  INTEGRATED_SHA,
  TIP_SHA,
  evidenceRead,
  fixtureTimeline,
  makeDeliveryRecord,
  recordComment,
} from './helpers/delivery-fixtures.ts'

const MEMBER_A_URL = `https://${HOST}/acme/widget/issues/1`
const MEMBER_B_URL = `https://${HOST}/acme/widget/issues/2`

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
    trustedEvidenceAuthorIds: [ACTOR_ID],
  },
  null,
  2,
)}\n`

const CONFIG_REVISION = resolveConfigRevision()

function resolveConfigRevision() {
  const resolved = resolveRunConfigText(VALID_CONFIG)
  assert.ok(resolved.kind === 'ok')
  return resolved.value.configRevision
}

const REMOTES: readonly GitRemote[] = [{ name: 'origin', url: 'https://github.com/acme/widget.git' }]

/** A valid delivery record for member I_A as loaded from the map fixtures. */
const MEMBER_A_RECORD = makeDeliveryRecord()

type TestSetup = {
  configJson?: string
  catalogModels?: readonly { id: string; family: string }[]
  evidence?: ReadonlyMap<string, IssueEvidenceReadOutcome>
  evidenceError?: boolean
  gitFacts?: { ancestors?: readonly string[] }
  loader?: readonly TaskMapLoadOutcome[]
}

type Harness = {
  cwd: string
  nornHome: string
  repositoryHome: string
  writeRunState: (state: RunState) => void
  gitFactsCalls: string[]
  readonly filesBeforeInit: readonly string[]
  cleanup: () => void
}

async function setup(options: TestSetup = {}): Promise<Harness & CheckMapDepsLike> {
  const nornHome = mkdtempSync(join(tmpdir(), 'norn-check-ev-'))
  const cwd = mkdtempSync(join(tmpdir(), 'norn-check-cwd-'))
  const baseStore = fsControlStore(nornHome)
  const repositoryHome = baseStore.repositoryHome({ githubHost: HOST, repositoryId: REPO })
  const written = await baseStore.writeRepositorySetup(repositoryHome, {
    metadataJson: `${JSON.stringify({ schema: 'norn-repository-metadata:v1' })}\n`,
    configJson: options.configJson ?? VALID_CONFIG,
  })
  assert.ok(written.kind === 'ok')
  const filesBeforeInit = listFiles(nornHome)

  const git: GitRepositoryAdapter = {
    async resolveRoot(directory: string) {
      return { kind: 'ok' as const, value: directory }
    },
    async listRemotes() {
      return { kind: 'ok' as const, value: REMOTES }
    },
  }

  const gateway: GitHubGatewayAdapter = {
    async resolveRepository() {
      return { kind: 'ok' as const, value: REPOSITORY }
    },
    async authenticatedActor() {
      throw new Error('check does not resolve the actor')
    },
  }

  const loader: TaskMapLoader & { calls: number } = {
    calls: 0,
    async loadTaskMap() {
      loader.calls += 1
      const script = options.loader ?? [
        { kind: 'ok', value: rawLoad([memberA(), memberB()]) } as TaskMapLoadOutcome,
        { kind: 'ok', value: rawLoad([memberA(), memberB()]) } as TaskMapLoadOutcome,
      ]
      const outcome = script[(loader.calls - 1) % script.length]
      if (outcome === undefined) throw new Error('no scripted load left')
      return outcome
    },
  }

  const catalog: ModelCatalogAdapter & { models: readonly { id: string; family: string }[] } = {
    models: options.catalogModels ?? [
      { id: 'provider-a/model-x', family: 'provider-a' },
      { id: 'provider-b/model-y', family: 'provider-b' },
    ],
    async listModels() {
      return {
        kind: 'ok' as const,
        value: this.models.map((model) => ({
          id: model.id,
          family: model.family,
          displayName: model.id,
          thinkingLevels: ['off', 'medium', 'high'] as const,
        })),
      }
    },
  }

  const evidence: IssueEvidenceReader & { requested: string[] } = {
    requested: [],
    async loadIssueEvidence(locator) {
      evidence.requested.push(locator.url)
      if (options.evidenceError) {
        return { kind: 'error' as const, scope: 'operation' as const, code: 'github-unavailable' as const, reason: 'dial tcp', sharedWrite: 'none' as const, evidence: [] }
      }
      const outcome = options.evidence?.get(locator.url)
      if (outcome !== undefined) return outcome
      return { kind: 'ok' as const, value: { comments: [], timeline: [] } }
    },
  }

  const gitFactsCalls: string[] = []
  const ancestors = new Set(options.gitFacts?.ancestors ?? [INTEGRATED_SHA, BASE_SHA, TIP_SHA])
  // The fixture data is keyed by object-format-prefixed OIDs; canonicalize
  // incoming OIDs so both prefixed and raw-hex callers find it.
  const canon = (oid: string): string => (oid.includes(':') ? oid : `sha1:${oid}`)
  const gitFacts: GitDeliveryFactsAdapter = {
    async fetchTarget(_root, remote, branch) {
      gitFactsCalls.push(`fetch:${remote}/${branch}`)
      return { kind: 'ok' as const, value: undefined }
    },
    async targetSha() {
      return { kind: 'ok' as const, value: TIP_SHA }
    },
    async commitFacts(_root, rawSha) {
      const sha = canon(rawSha)
      gitFactsCalls.push(`commit:${sha}`)
      if (sha === INTEGRATED_SHA) {
        return { kind: 'ok' as const, value: { treeOid: DELIVERED_TREE, parents: [BASE_SHA] } }
      }
      if (sha === BASE_SHA) {
        return { kind: 'ok' as const, value: { treeOid: BASE_TREE, parents: [] } }
      }
      return { kind: 'ok' as const, value: undefined }
    },
    async isAncestorOfTarget(_root, _remote, _branch, rawSha) {
      const sha = canon(rawSha)
      gitFactsCalls.push(`ancestor:${sha}`)
      return { kind: 'ok' as const, value: ancestors.has(sha) }
    },
  }

  return {
    cwd,
    nornHome,
    repositoryHome,
    filesBeforeInit,
    gitFactsCalls,
    writeRunState: (state) => {
      const saved = saveRunState(repositoryHome, encodePathSegment(state.map.issueId), state)
      assert.ok(saved.kind === 'ok', saved.kind === 'error' ? saved.reason : '')
    },
    cleanup: () => {
      rmSync(nornHome, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    },
    git,
    gateway,
    loader,
    store: baseStore,
    catalog,
    evidence,
    gitFacts,
  }
}

type CheckMapDepsLike = {
  cwd: string
  git: GitRepositoryAdapter
  gateway: GitHubGatewayAdapter
  loader: TaskMapLoader
  store: LocalControlStore
  catalog: ModelCatalogAdapter
  evidence: IssueEvidenceReader & { requested: string[] }
  gitFacts: GitDeliveryFactsAdapter
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

function deliveryFinding(outcome: CheckMapOutcome): CheckMapFinding & { kind: 'delivery-evidence' } {
  assert.ok(isBlocked(outcome))
  const report = outcome.kind === 'blocked' ? (outcome.evidence[0] as { findings?: CheckMapFinding[] }) : undefined
  const finding = report?.findings?.find((entry) => entry.kind === 'delivery-evidence')
  assert.ok(finding !== undefined && finding.kind === 'delivery-evidence')
  return finding
}

/** The default closed-A/open-B load with member A's valid record available. */
function closedMemberALoad(): readonly TaskMapLoadOutcome[] {
  const closedA = { ...memberA(), state: 'CLOSED' as const }
  const load = rawLoad([closedA, memberB()])
  return [
    { kind: 'ok', value: load },
    { kind: 'ok', value: load },
  ]
}

function evidenceWithRecord(options: { ticketUrl?: string; record?: ReturnType<typeof makeDeliveryRecord> } = {}): ReadonlyMap<string, IssueEvidenceReadOutcome> {
  const url = options.ticketUrl ?? MEMBER_A_URL
  const record = options.record ?? MEMBER_A_RECORD
  return new Map([
    [url, { kind: 'ok', value: evidenceRead([recordComment(record)], fixtureTimeline(['C1'])) }],
  ])
}

/** One running run state for a map with the given members. */
function runState(options: {
  mapIssueId?: string
  mapNumber?: number
  members?: readonly string[]
  runId?: string
  configRevision?: Sha256Digest
  nornVersion?: string
  status?: RunState['status']
}): RunState {
  const mapIssueId = options.mapIssueId ?? 'I_map'
  const mapNumber = options.mapNumber ?? 6
  const members = (options.members ?? ['I_A', 'I_B']).map((issueId) => ({
    ticketIssueId: issueId,
    ticketRevision: computeTicketRevision({
      githubHost: HOST,
      repositoryId: REPO,
      ticketIssueId: issueId,
      title: `Ticket ${issueId}`,
      body: `Body of ${issueId}`,
    }).revision,
  }))
  const payload = computeMapRevision({
    githubHost: HOST,
    repositoryId: REPO,
    mapIssueId,
    title: 'Ship widget v2',
    body: 'Shared intent of the map.',
    members,
    dependencies: [],
  }).payload
  return {
    schema: 'norn-run-state:v1',
    runId: options.runId ?? 'run-1',
    map: {
      role: 'map',
      githubHost: HOST,
      repositoryId: REPO,
      issueId: mapIssueId,
      number: mapNumber,
      url: `https://${HOST}/acme/widget/issues/${mapNumber}`,
    },
    acceptedMapRevisions: [{ revision: canonicalJsonDigest(payload as never), payload }],
    configRevision: options.configRevision ?? CONFIG_REVISION,
    nornVersion: options.nornVersion ?? NORN_VERSION,
    status: options.status ?? 'running',
    wave: 0,
    parkedTickets: [],
    tickets: {},
    activeProcesses: [],
    ...(options.status === 'terminal' ? { report: terminalReportFor(payload) } : {}),
  }
}

/** The minimal valid terminal report for a fixture run (§13.1). */
function terminalReportFor(payload: unknown): RunState['report'] {
  const revision = canonicalJsonDigest(payload as never)
  return {
    label: 'blocked',
    code: 'operator-abort',
    runId: 'run-1',
    initialMapRevision: revision,
    finalMapRevision: revision,
    acceptedExtensions: [],
    tickets: [],
    sharedWrite: 'none',
    warnings: [],
  }
}

describe('checkMap — model availability against the authenticated catalog', () => {
  it('passes when both configured models resolve to different families', async () => {
    const harness = await setup()
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.ok(isOk(outcome))
    } finally {
      harness.cleanup()
    }
  })

  it('reports each unavailable model as its own finding', async () => {
    const harness = await setup({ catalogModels: [{ id: 'provider-a/model-x', family: 'provider-a' }] })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.deepEqual(findingKinds(outcome), ['model-unavailable'])
      if (outcome.kind === 'blocked') {
        const report = outcome.evidence[0] as { findings?: CheckMapFinding[] }
        const finding = report?.findings?.[0]
        assert.ok(finding?.kind === 'model-unavailable')
        assert.equal(finding.role, 'reviewer')
      }
    } finally {
      harness.cleanup()
    }
  })

  it('reports a worker/reviewer family conflict', async () => {
    const harness = await setup({
      catalogModels: [
        { id: 'provider-a/model-x', family: 'provider-a' },
        { id: 'provider-b/model-y', family: 'provider-a' },
      ],
    })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.deepEqual(findingKinds(outcome), ['model-family-conflict'])
    } finally {
      harness.cleanup()
    }
  })

  it('surfaces an unreadable catalog as an error', async () => {
    const harness = await setup()
    const brokenCatalog: ModelCatalogAdapter = {
      async listModels() {
        return error({ scope: 'operation', code: 'model-catalog-unavailable', reason: 'empty catalog' })
      },
    }
    try {
      const outcome = await checkMap({ ...harness, catalog: brokenCatalog }, MAP_URL)
      assert.ok(isError(outcome))
      if (outcome.kind === 'error') assert.equal(outcome.code, 'model-catalog-unavailable')
    } finally {
      harness.cleanup()
    }
  })
})

describe('checkMap — delivery evidence for map members', () => {
  it('passes a closed member with a fully valid delivery record, fetching the target once', async () => {
    const harness = await setup({
      loader: closedMemberALoad(),
      evidence: evidenceWithRecord(),
    })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.ok(isOk(outcome), outcome.kind === 'error' ? outcome.reason : 'expected ok')
      // One fetch, then the integration and base commit facts, then ancestry.
      assert.deepEqual(harness.gitFactsCalls, [
        'fetch:origin/main',
        `commit:${INTEGRATED_SHA}`,
        `commit:${BASE_SHA}`,
        `ancestor:${INTEGRATED_SHA}`,
      ])
      assert.deepEqual([...harness.evidence.requested].sort(), [MEMBER_A_URL, MEMBER_B_URL].sort())
    } finally {
      harness.cleanup()
    }
  })

  it('blocks a closed member without any delivery record, with the §14 remedies', async () => {
    const harness = await setup({ loader: closedMemberALoad() })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.deepEqual(findingKinds(outcome), ['delivery-evidence'])
      const finding = deliveryFinding(outcome)
      assert.equal(finding.ticketState, 'CLOSED')
      assert.deepEqual(finding.findings.map((entry) => entry.code), ['no-valid-record'])
      assert.deepEqual(finding.remedies, ['reopen-for-fresh-work', 'remove-from-map', 'restore-recorded-facts'])
    } finally {
      harness.cleanup()
    }
  })

  it('blocks an open member carrying otherwise-valid delivery evidence instead of re-working it', async () => {
    const harness = await setup({ evidence: evidenceWithRecord() })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.deepEqual(findingKinds(outcome), ['delivery-evidence'])
      const finding = deliveryFinding(outcome)
      assert.equal(finding.ticketState, 'OPEN')
      assert.deepEqual(finding.findings.map((entry) => entry.code), ['ticket-open'])
      assert.deepEqual(finding.remedies, ['reclose-ticket', 'change-ticket-specification'])
    } finally {
      harness.cleanup()
    }
  })

  it('reports a closed member whose record carries a stale ticket revision', async () => {
    const harness = await setup({
      loader: closedMemberALoad(),
      evidence: evidenceWithRecord({
        record: makeDeliveryRecord({
          ticketRevision: canonicalJsonDigest({ edited: 'specification' }),
        }),
      }),
    })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      const finding = deliveryFinding(outcome)
      assert.deepEqual(finding.findings.map((entry) => entry.code), ['stale-ticket-revision'])
    } finally {
      harness.cleanup()
    }
  })

  it('reports a closed member whose integrated commit lost target ancestry', async () => {
    const harness = await setup({
      loader: closedMemberALoad(),
      evidence: evidenceWithRecord(),
      gitFacts: { ancestors: [BASE_SHA, TIP_SHA] },
    })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      const finding = deliveryFinding(outcome)
      assert.deepEqual(finding.findings.map((entry) => entry.code), ['not-target-ancestor'])
    } finally {
      harness.cleanup()
    }
  })

  it('reports a divergent duplicate record as integrity-blocking', async () => {
    const divergent = makeDeliveryRecord()
    ;(divergent as unknown as Record<string, unknown>).actorId = 'I_attacker'
    const read: IssueEvidenceReadOutcome = {
      kind: 'ok',
      value: evidenceRead(
        [recordComment(MEMBER_A_RECORD, { commentId: 'C1' }), recordComment(divergent, { commentId: 'C2' })],
        fixtureTimeline(['C1', 'C2']),
      ),
    }
    const harness = await setup({
      loader: closedMemberALoad(),
      evidence: new Map([[MEMBER_A_URL, read]]),
    })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      const finding = deliveryFinding(outcome)
      assert.deepEqual(finding.findings.map((entry) => entry.code), ['divergent-duplicate'])
    } finally {
      harness.cleanup()
    }
  })

  it('surfaces an evidence-reader failure as an error and never writes under repository home', async () => {
    const harness = await setup({ evidenceError: true })
    try {
      const outcome = await checkMap(harness, MAP_URL)
      assert.ok(isError(outcome))
      if (outcome.kind === 'error') assert.equal(outcome.code, 'github-unavailable')
      const after = listFiles(harness.nornHome)
      assert.deepEqual(after, [...harness.filesBeforeInit])
    } finally {
      harness.cleanup()
    }
  })
})

describe('checkMap — run-state resumability, disjointness, and compatibility', () => {
  it('accepts a resumable running state for this map with matching identity', async () => {
    const harness = await setup()
    try {
      harness.writeRunState(runState({}))
      const outcome = await checkMap(harness, MAP_URL)
      assert.ok(isOk(outcome))
    } finally {
      harness.cleanup()
    }
  })

  it('reports a running state whose configRevision or Norn version differ', async () => {
    const configMismatch = await setup()
    try {
      configMismatch.writeRunState(runState({ configRevision: canonicalJsonDigest({ other: 'config' }) }))
      let outcome = await checkMap(configMismatch, MAP_URL)
      assert.deepEqual(findingKinds(outcome), ['state-not-resumable'])
      if (outcome.kind === 'blocked') {
        const report = outcome.evidence[0] as { findings?: CheckMapFinding[] }
        const finding = report?.findings?.[0]
        assert.ok(finding?.kind === 'state-not-resumable')
        assert.deepEqual(finding.mismatches, ['configRevision'])
      }
    } finally {
      configMismatch.cleanup()
    }

    const versionMismatch = await setup()
    try {
      versionMismatch.writeRunState(runState({ nornVersion: '0.0.1' }))
      const outcome = await checkMap(versionMismatch, MAP_URL)
      const finding = deliveryRunFinding(outcome)
      assert.deepEqual(finding.mismatches, ['nornVersion'])
    } finally {
      versionMismatch.cleanup()
    }
  })

  it('ignores terminal and aborted run states', async () => {
    for (const status of ['terminal', 'aborted'] as const) {
      const harness = await setup()
      try {
        harness.writeRunState(runState({ status }))
        const outcome = await checkMap(harness, MAP_URL)
        assert.ok(isOk(outcome))
      } finally {
        harness.cleanup()
      }
    }
  })

  it('reports members claimed by another map\u2019s active run', async () => {
    const harness = await setup()
    try {
      harness.writeRunState(runState({ mapIssueId: 'I_map2', mapNumber: 9, members: ['I_A'], runId: 'run-2' }))
      const outcome = await checkMap(harness, MAP_URL)
      assert.deepEqual(findingKinds(outcome), ['ticket-claimed-by-active-run'])
      if (outcome.kind === 'blocked') {
        const report = outcome.evidence[0] as { findings?: CheckMapFinding[] }
        const finding = report?.findings?.[0]
        assert.ok(finding?.kind === 'ticket-claimed-by-active-run')
        assert.deepEqual(finding.ticketIssueIds, ['I_A'])
        assert.equal(finding.runId, 'run-2')
        assert.equal(finding.mapNumber, 9)
      }
    } finally {
      harness.cleanup()
    }
  })

  it('reports another active run with an incompatible config or version', async () => {
    const harness = await setup()
    try {
      harness.writeRunState(
        runState({
          mapIssueId: 'I_map2',
          mapNumber: 9,
          members: ['I_C'],
          runId: 'run-2',
          configRevision: canonicalJsonDigest({ other: 'config' }),
          nornVersion: '0.0.1',
        }),
      )
      const outcome = await checkMap(harness, MAP_URL)
      const finding = findingKinds(outcome)
      assert.deepEqual(finding, ['incompatible-active-run'])
    } finally {
      harness.cleanup()
    }
  })

  it('accepts a compatible disjoint active run of another map', async () => {
    const harness = await setup()
    try {
      harness.writeRunState(runState({ mapIssueId: 'I_map2', mapNumber: 9, members: ['I_C'], runId: 'run-2' }))
      const outcome = await checkMap(harness, MAP_URL)
      assert.ok(isOk(outcome))
    } finally {
      harness.cleanup()
    }
  })
})

describe('checkMap — full-pass finding accumulation', () => {
  it('reports model, evidence, resumability, and disjointness findings in one blocked outcome', async () => {
    const harness = await setup({
      catalogModels: [{ id: 'provider-a/model-x', family: 'provider-a' }],
      loader: closedMemberALoad(),
      // No evidence: the closed member has no record.
    })
    try {
      harness.writeRunState(
        runState({
          mapIssueId: 'I_map2',
          mapNumber: 9,
          members: ['I_B'],
          runId: 'run-2',
          configRevision: canonicalJsonDigest({ other: 'config' }),
        }),
      )
      harness.writeRunState(runState({ configRevision: canonicalJsonDigest({ other: 'config' }) }))
      const outcome = await checkMap(harness, MAP_URL)
      assert.ok(isBlocked(outcome))
      const kinds = findingKinds(outcome).sort()
      assert.deepEqual(kinds, [
        'delivery-evidence',
        'incompatible-active-run',
        'model-unavailable',
        'state-not-resumable',
        'ticket-claimed-by-active-run',
      ].sort())
    } finally {
      harness.cleanup()
    }
  })
})

function deliveryRunFinding(outcome: CheckMapOutcome): { readonly mismatches: readonly string[] } {
  assert.ok(isBlocked(outcome))
  const report = outcome.kind === 'blocked' ? (outcome.evidence[0] as { findings?: CheckMapFinding[] }) : undefined
  const finding = report?.findings?.find((entry) => entry.kind === 'state-not-resumable')
  assert.ok(finding !== undefined && finding.kind === 'state-not-resumable')
  return { mismatches: finding.mismatches }
}
