/**
 * Ship final candidate and reconciliation (design.md §11.1–§11.2, ticket #10).
 *
 * §11.1 preconditions run against fake seams — the git runners throw if
 * reached, proving a precondition decision never touches git — while the
 * §11.2 mechanics run against real temporary repositories with real
 * branches, worktrees, `merge-tree` replays, `commit-tree` canonical
 * commits, ancestry, and messages. Every test also asserts that no push was
 * attempted: the git spies record every invocation, and reconciliation stops
 * before §11.3 by design.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { blocked, ok } from '../src/core/outcome.ts'
import type { Outcome } from '../src/core/outcome.ts'
import { canonicalJsonDigest } from '../src/core/digest.ts'
import { computeTicketRevision } from '../src/core/revision.ts'
import { encodePathSegment } from '../src/config/paths.ts'
import { loadRunState, saveRunState } from '../src/runstate/run-state-store.ts'
import type { AcceptedMapRevision, RunState } from '../src/runstate/types.ts'
import type { GitCommandRunner, GitFactsCommandRunner } from '../src/adapters/git-repository.ts'
import type { DeliveryCommitFacts } from '../src/evidence/delivery.ts'
import type { IssueEvidenceReadOutcome } from '../src/evidence/read.ts'
import type { StableSnapshotOutcome } from '../src/map/stable-read.ts'
import type { TaskMapSnapshot } from '../src/map/snapshot.ts'
import {
  CANONICAL_COMMIT_IDENTITY,
  GITHUB_AUTO_CLOSE_KEYWORDS,
  canonicalCommitMessage,
  containsAutoCloseKeyword,
  reconcileFinalCandidate,
  runStateAdoptExtension,
  snapshotMapPayload,
} from '../src/ship/reconcile.ts'
import type {
  FinalCandidate,
  ShipExtensionAdoption,
  ShipFacts,
  ShipReconcileDeps,
  ShipReconcileOutcome,
  ShipReconcileParams,
} from '../src/ship/reconcile.ts'

import {
  ACTOR_ID,
  evidenceRead,
  fakeFacts,
  fixtureTimeline,
  makeDeliveryRecord,
  recordComment,
} from './helpers/delivery-fixtures.ts'
import { gitText } from './helpers/round-gate-fixtures.ts'
import { member as memberOf, rawRef } from './helpers/map-fixtures.ts'
import {
  RUN_ID,
  REPOSITORY_ID,
  SHARED_FILE,
  SHARED_FILE_BASE,
  TARGET_LINE,
  TICKET_ISSUE_ID,
  WORK_ATTEMPT_ID,
  WORKER_LINE,
  acceptedEntryOf,
  assertNoPush,
  commandFailure,
  defaultMap,
  makeRepoHarness,
  memberC,
  revisionOf,
  sealedChange,
  snapshotOf,
  ticket7,
} from './helpers/ship-fixtures.ts'
import type { RepoHarness } from './helpers/ship-fixtures.ts'

// ---------------------------------------------------------------------------
// The canonical commit template (§11.2)
// ---------------------------------------------------------------------------

describe('the canonical commit template', () => {
  it('carries the stable ticket locator and nothing else', () => {
    const message = canonicalCommitMessage({
      ticketNumber: 7,
      ticketIssueId: 'I_7',
      mapIssueId: 'I_map',
      runId: 'run-9',
    })
    assert.match(message, /^norn: ship ticket #7\n/)
    assert.match(message, /map: I_map/)
    assert.match(message, /ticket: I_7/)
    assert.match(message, /run: run-9/)
    assert.equal(
      message,
      canonicalCommitMessage({ ticketNumber: 7, ticketIssueId: 'I_7', mapIssueId: 'I_map', runId: 'run-9' }),
    )
  })

  it('contains no GitHub auto-close keyword', () => {
    const message = canonicalCommitMessage({
      ticketNumber: 12,
      ticketIssueId: 'I_x',
      mapIssueId: 'I_map',
      runId: 'run-1',
    })
    assert.equal(containsAutoCloseKeyword(message), false)
    for (const keyword of GITHUB_AUTO_CLOSE_KEYWORDS) {
      assert.equal(containsAutoCloseKeyword(`${keyword} #12`), true, keyword)
    }
    assert.equal(containsAutoCloseKeyword('Fixed the flaky build'), true)
    assert.equal(containsAutoCloseKeyword('ship ticket #12'), false)
  })
})

// ---------------------------------------------------------------------------
// Fake-seam preconditions (§11.1)
// ---------------------------------------------------------------------------

const FAKE_BASE = `sha1:${'1'.repeat(40)}`
const FAKE_BASE_TREE = `sha1:${'2'.repeat(40)}`
const FAKE_CANDIDATE_COMMIT = `sha1:${'3'.repeat(40)}`
const FAKE_WORKSPACE_PATH = join(tmpdir(), 'norn-ship-fake-workspace')

function throwingGit(): GitCommandRunner & GitFactsCommandRunner {
  const git = async (args: readonly string[]): Promise<never> => {
    throw new Error(`a precondition path must never touch git: ${args.join(' ')}`)
  }
  return git as GitCommandRunner & GitFactsCommandRunner
}

function gitFactsFailure(): Outcome<never, never, 'git-failed'> {
  return {
    kind: 'error',
    scope: 'operation',
    code: 'git-failed',
    reason: 'scripted facts failure',
    sharedWrite: 'none',
    evidence: [],
  } as const
}

function preconditionFacts(init: {
  readonly targetSha?: string
  readonly treeOid?: string
  readonly commits?: Record<string, DeliveryCommitFacts>
  readonly fail?: 'fetch' | 'targetSha' | 'commitFacts'
}): ShipFacts & { readonly calls: string[] } {
  const base = fakeFacts(init.commits === undefined ? {} : { commits: init.commits })
  const calls: string[] = []
  const raw = (sha: string): string => sha.replace(/^sha(?:1|256):/, '')
  const keyed = (sha: string): string => (/^sha(?:1|256):/.test(sha) ? sha : `sha1:${sha}`)
  const targetSha = init.targetSha ?? FAKE_BASE
  const treeOid = init.treeOid ?? FAKE_BASE_TREE
  return {
    calls,
    fetchTarget: async (branch) => {
      calls.push(`fetch:${branch}`)
      return init.fail === 'fetch' ? gitFactsFailure() : ok(undefined)
    },
    targetSha: async (branch) => {
      calls.push(`targetSha:${branch}`)
      return init.fail === 'targetSha' ? gitFactsFailure() : ok(raw(targetSha))
    },
    commitFacts: async (sha) => {
      calls.push(`commitFacts:${sha.slice(0, 10)}`)
      if (init.fail === 'commitFacts') return gitFactsFailure()
      if (raw(sha) === raw(targetSha)) return ok({ treeOid: raw(treeOid), parents: [] })
      return base.commitFacts(keyed(sha))
    },
    isAncestorOfTarget: async (sha, branch) => {
      calls.push(`isAncestor:${sha.slice(0, 10)}`)
      return base.isAncestorOfTarget(keyed(sha), branch)
    },
  }
}

type PreconditionScript = {
  /** The accepted map; defaults to the bare I_7 map. */
  readonly acceptedMap?: TaskMapSnapshot
  readonly map?: () => StableSnapshotOutcome
  readonly adopt?: (extension: ShipExtensionAdoption) => Outcome<void, never, 'control-store'>
  readonly evidence?: Readonly<Record<string, IssueEvidenceReadOutcome>>
  readonly facts?: ShipFacts & { readonly calls: string[] }
  readonly events?: string[]
}

function preconditionHarness(script: PreconditionScript = {}, alreadyShipped = false): {
  readonly deps: ShipReconcileDeps
  readonly params: ShipReconcileParams
  run(): Promise<ShipReconcileOutcome>
} {
  const acceptedMap = script.acceptedMap ?? defaultMap()
  // Zero-delta against the fake target: the ok path completes without git.
  const change = sealedChange({
    mapRevision: acceptedMap.mapRevision,
    ticketRevision: revisionOf(acceptedMap, TICKET_ISSUE_ID),
    baseSha: FAKE_BASE,
    candidateCommit: FAKE_CANDIDATE_COMMIT,
    candidateTreeOid: FAKE_BASE_TREE,
    workspace: {
      kind: 'ticket',
      repositoryId: REPOSITORY_ID,
      runId: RUN_ID,
      path: FAKE_WORKSPACE_PATH,
      branch: `norn/${RUN_ID}/7/${WORK_ATTEMPT_ID}`,
      workAttemptId: WORK_ATTEMPT_ID,
    },
  })
  const events = script.events ?? []
  const rawFacts = script.facts ?? preconditionFacts({})
  const facts: ShipFacts & { readonly calls: string[] } = {
    calls: rawFacts.calls,
    fetchTarget: async (branch) => {
      const outcome = await rawFacts.fetchTarget(branch)
      events.push(`facts:fetch:${branch}`)
      return outcome
    },
    targetSha: async (branch) => {
      const outcome = await rawFacts.targetSha(branch)
      events.push(`facts:targetSha:${branch}`)
      return outcome
    },
    commitFacts: async (sha) => rawFacts.commitFacts(sha),
    isAncestorOfTarget: async (sha, branch) => rawFacts.isAncestorOfTarget(sha, branch),
  }
  const deps: ShipReconcileDeps = {
    git: throwingGit(),
    gitDetailed: throwingGit(),
    facts,
    readMap: () => {
      events.push('readMap')
      return Promise.resolve(script.map?.() ?? ok(acceptedMap))
    },
    adoptExtension: async (extension) => {
      events.push('adopt')
      return script.adopt?.(extension) ?? ok(undefined)
    },
    readIssueEvidence: async (locator) =>
      script.evidence?.[locator.url.split('/').pop() ?? ''] ?? ok({ comments: [], timeline: [] }),
    runner: {
      kind: 'local-process',
      launch: async () => {
        throw new Error('the precondition harness never launches a reviewer')
      },
      attach: (handle) => ({ kind: 'local-process', adapterHandle: handle }),
      isLive: async () => false,
      waitForExit: async () => 'exited',
      terminate: async () => 'terminated',
      release: async () => undefined,
    },
    commands: {
      execute: async () => {
        throw new Error('the precondition harness never runs a command')
      },
    },
    planReviewer: () => {
      throw new Error('the precondition harness never plans a reviewer')
    },
    newInvocationId: () => 'precondition-reviewer-1',
  }
  const params: ShipReconcileParams = {
    change,
    accepted: acceptedEntryOf(acceptedMap),
    runId: RUN_ID,
    repositoryRoot: '/nonexistent',
    targetBranch: 'main',
    setup: [],
    tests: [{ argv: ['npm', 'test'], timeoutMs: 60_000 }],
    reviewer: { model: 'provider-b/model-y', thinking: 'high', timeoutMs: 60_000, family: 'provider-b' },
    trustedEvidenceAuthorIds: [ACTOR_ID],
    completionsDir: join(tmpdir(), 'norn-ship-fake-completions'),
    alreadyShipped,
  }
  return { deps, params, run: () => reconcileFinalCandidate(deps, params) }
}

function assertChangedInput(
  outcome: ShipReconcileOutcome,
  expectedSharedWrite: 'none' | 'confirmed',
  stage: string,
): void {
  assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
  if (outcome.kind !== 'blocked') return
  assert.equal(outcome.code, 'changed-input')
  assert.equal(outcome.scope, 'run')
  assert.equal(outcome.sharedWrite, expectedSharedWrite)
  const stages = outcome.evidence.map((entry) =>
    typeof entry === 'object' && entry !== null && 'stage' in entry
      ? (entry as { stage: string }).stage
      : '',
  )
  assert.ok(stages.includes(stage), `expected stage ${stage} in ${JSON.stringify(outcome.evidence)}`)
}

describe('§11.1 preconditions over fake seams', () => {
  it('an identical revision continues directly to a zero-delta candidate', async () => {
    const harness = preconditionHarness()
    const outcome = await harness.run()
    assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
    if (outcome.kind !== 'ok') return
    assert.equal(outcome.value.zeroDelta, true)
    assert.equal(outcome.value.integrationCommit, null)
    assert.equal(outcome.value.integratedSha, FAKE_BASE)
    assert.equal(outcome.value.mapRevision, harness.params.change.mapRevision)
    assert.deepEqual(outcome.value.tests, harness.params.change.tests)
    assert.equal(outcome.value.review, harness.params.change.review)
  })

  it('a Compatible Map Extension is persisted and adopted first', async () => {
    const acceptedMap = defaultMap()
    const extended = snapshotOf([ticket7(), memberC()])
    const events: string[] = []
    const harness = preconditionHarness({
      map: () => ok(extended),
      events,
      adopt: (extension) => {
        assert.equal(extension.fromRevision, acceptedMap.mapRevision)
        assert.equal(extension.revision, extended.mapRevision)
        assert.deepEqual(extension.addedTicketIssueIds, ['I_C'])
        assert.equal(
          canonicalJsonDigest(extension.payload as never),
          extended.mapRevision,
          'the adopted payload re-hashes to the adopted revision',
        )
        return ok(undefined)
      },
    })
    const outcome = await harness.run()
    assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
    if (outcome.kind !== 'ok') return
    assert.deepEqual(outcome.value.adoptedExtension, {
      revision: extended.mapRevision,
      fromRevision: acceptedMap.mapRevision,
      addedTicketIssueIds: ['I_C'],
    })
    // Adoption precedes every later read: the target was touched only after
    // the extension was persisted.
    assert.ok(events.indexOf('adopt') < events.indexOf('facts:targetSha:main'), JSON.stringify(events))
    // Reused Work evidence retains its historical revision (§11.2).
    assert.equal(outcome.value.mapRevision, harness.params.change.mapRevision)
    assert.notEqual(outcome.value.mapRevision, extended.mapRevision)
  })

  it('incompatible map changes block before any push', async () => {
    const cases: ReadonlyArray<{ name: string; map: () => TaskMapSnapshot }> = [
      { name: 'map title changed', map: () => snapshotOf([ticket7()], { title: 'Different intent' }) },
      { name: 'map body changed', map: () => snapshotOf([ticket7()], { body: 'Rewritten shared intent.' }) },
      { name: 'ticket specification changed', map: () => snapshotOf([ticket7({ title: 'Ticket I_7 (edited)' })]) },
      { name: 'member removed', map: () => snapshotOf([memberOf('I_8', 8)]) },
      {
        name: 'existing ticket gained a blocker',
        map: () => snapshotOf([ticket7({ blockers: [rawRef('I_C', 9)] }), memberC()]),
      },
    ]
    for (const testCase of cases) {
      const harness = preconditionHarness({ map: () => ok(testCase.map()) })
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked', testCase.name)
      assertChangedInput(outcome, 'none', 'map-classification')
    }
  })

  it('a closed map blocks the ship', async () => {
    const harness = preconditionHarness({ map: () => ok(snapshotOf([ticket7()], { state: 'CLOSED' })) })
    assertChangedInput(await harness.run(), 'none', 'map-state')
  })

  it('an unstable map read blocks the ship', async () => {
    const harness = preconditionHarness({
      map: () =>
        blocked({
          scope: 'operation',
          code: 'changed-input',
          reason: 'no two adjacent loads agreed',
          sharedWrite: 'none',
          evidence: [],
        }),
    })
    assertChangedInput(await harness.run(), 'none', 'map-read')
  })

  it('a structurally invalid current map blocks the ship', async () => {
    const harness = preconditionHarness({
      map: () =>
        blocked({
          scope: 'operation',
          code: 'invalid-map',
          reason: 'topology violation',
          sharedWrite: 'none',
          evidence: [],
        }),
    })
    assertChangedInput(await harness.run(), 'none', 'map-read')
  })

  it('a map read infrastructure error is a run-scoped error', async () => {
    const harness = preconditionHarness({
      map: () =>
        ({
          kind: 'error',
          scope: 'operation',
          code: 'github-unavailable',
          reason: 'gateway down',
          sharedWrite: 'none',
          evidence: [],
        }) as StableSnapshotOutcome,
    })
    const outcome = await harness.run()
    assert.equal(outcome.kind, 'error')
    if (outcome.kind !== 'error') return
    assert.equal(outcome.code, 'map-read')
    assert.equal(outcome.scope, 'run')
    assert.equal(outcome.sharedWrite, 'none')
  })

  it('a closed shipped ticket blocks the ship', async () => {
    const harness = preconditionHarness({ map: () => ok(snapshotOf([ticket7({ state: 'CLOSED' })])) })
    assertChangedInput(await harness.run(), 'none', 'ticket-state')
  })

  it('a changed ticket revision blocks the ship', async () => {
    const harness = preconditionHarness({ map: () => ok(snapshotOf([ticket7({ body: 'Edited body of I_7' })])) })
    const outcome = await harness.run()
    assertChangedInput(outcome, 'none', 'map-classification')
    assert.ok(
      JSON.stringify(outcome.kind === 'blocked' ? outcome.evidence : []).includes('ticket-revision-changed'),
    )
  })

  it('removing the ticket from the map blocks the ship', async () => {
    const harness = preconditionHarness({ map: () => ok(snapshotOf([memberOf('I_8', 8)])) })
    const outcome = await harness.run()
    assertChangedInput(outcome, 'none', 'map-classification')
    assert.ok(
      JSON.stringify(outcome.kind === 'blocked' ? outcome.evidence : []).includes('member-removed'),
    )
  })

  it('a changed blocker set blocks the ship', async () => {
    const harness = preconditionHarness({
      map: () => ok(snapshotOf([ticket7({ blockers: [rawRef('I_A', 6)] }), memberOf('I_A', 6)])),
    })
    const outcome = await harness.run()
    assertChangedInput(outcome, 'none', 'map-classification')
    assert.ok(
      JSON.stringify(outcome.kind === 'blocked' ? outcome.evidence : []).includes('ticket-blockers-changed'),
    )
  })

  it('a blocker without valid Completed Ticket evidence blocks the ship', async () => {
    const acceptedWithBlocker = snapshotOf([
      ticket7({ blockers: [rawRef('I_A', 6)] }),
      memberOf('I_A', 6, { state: 'CLOSED' }),
    ])
    const map = (): StableSnapshotOutcome => ok(acceptedWithBlocker)

    const noRecord = preconditionHarness({ acceptedMap: acceptedWithBlocker, map, evidence: { '6': ok({ comments: [], timeline: [] }) } })
    assertChangedInput(await noRecord.run(), 'none', 'blocker-completion')

    // Even with a record present, a reopened blocker fails predicate 1.
    const record = makeDeliveryRecord({ ticketIssueId: 'I_A' })
    const reopened = preconditionHarness({
      acceptedMap: acceptedWithBlocker,
      map: () =>
        ok(
          snapshotOf([
            ticket7({ blockers: [rawRef('I_A', 6)] }),
            memberOf('I_A', 6),
          ]),
        ),
      evidence: { '6': ok(evidenceRead([recordComment(record)], fixtureTimeline())) },
    })
    assertChangedInput(await reopened.run(), 'none', 'blocker-completion')
  })

  it('a valid Completed Ticket blocker lets the ship continue', async () => {
    const blockerRevision = computeTicketRevision({
      githubHost: 'github.com',
      repositoryId: REPOSITORY_ID,
      ticketIssueId: 'I_A',
      title: 'Ticket I_A',
      body: 'Body of I_A',
    }).revision
    const acceptedWithBlocker = snapshotOf([
      ticket7({ blockers: [rawRef('I_A', 6)] }),
      memberOf('I_A', 6, { state: 'CLOSED' }),
    ])
    const record = makeDeliveryRecord({ ticketIssueId: 'I_A', ticketRevision: blockerRevision })
    const harness = preconditionHarness({
      acceptedMap: acceptedWithBlocker,
      map: () => ok(acceptedWithBlocker),
      evidence: { '6': ok(evidenceRead([recordComment(record)], fixtureTimeline(['C1']))) },
    })
    const outcome = await harness.run()
    assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
  })

  it('blocker evidence infrastructure failures are run-scoped errors', async () => {
    const acceptedWithBlocker = snapshotOf([
      ticket7({ blockers: [rawRef('I_A', 6)] }),
      memberOf('I_A', 6, { state: 'CLOSED' }),
    ])
    const withBlockers = (): StableSnapshotOutcome => ok(acceptedWithBlocker)
    const readerError = preconditionHarness({
      acceptedMap: acceptedWithBlocker,
      map: withBlockers,
      evidence: {
        '6': {
          kind: 'error',
          scope: 'operation',
          code: 'github-unavailable',
          reason: 'gateway down',
          sharedWrite: 'none',
          evidence: [],
        },
      },
    })
    const readOutcome = await readerError.run()
    assert.equal(readOutcome.kind, 'error')
    if (readOutcome.kind === 'error') {
      assert.equal(readOutcome.code, 'evidence-read')
      assert.equal(readOutcome.scope, 'run')
    }

    const record = makeDeliveryRecord({ ticketIssueId: 'I_A' })
    const factsError = preconditionHarness({
      acceptedMap: acceptedWithBlocker,
      map: withBlockers,
      evidence: { '6': ok(evidenceRead([recordComment(record)], fixtureTimeline())) },
      facts: preconditionFacts({ fail: 'commitFacts' }),
    })
    const factsOutcome = await factsError.run()
    assert.equal(factsOutcome.kind, 'error')
    if (factsOutcome.kind === 'error') assert.equal(factsOutcome.code, 'evidence-read')
  })

  it('a failed extension adoption is a run-scoped error and nothing later runs', async () => {
    const events: string[] = []
    const harness = preconditionHarness({
      map: () => ok(snapshotOf([ticket7(), memberC()])),
      events,
      adopt: () =>
        ({
          kind: 'error',
          scope: 'run',
          code: 'control-store',
          reason: 'scripted failure',
          sharedWrite: 'none',
          evidence: [],
        }) as const,
    })
    const outcome = await harness.run()
    assert.equal(outcome.kind, 'error')
    if (outcome.kind !== 'error') return
    assert.equal(outcome.code, 'control-store')
    assert.equal(outcome.scope, 'run')
    assert.ok(events.includes('adopt'))
    assert.ok(!events.includes('facts:targetSha:main'), 'no target read after a failed adoption')
  })

  it('target read failures are run-scoped errors', async () => {
    for (const fail of ['fetch', 'targetSha', 'commitFacts'] as const) {
      const harness = preconditionHarness({ facts: preconditionFacts({ fail }) })
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'error', fail)
      if (outcome.kind === 'error') {
        assert.equal(outcome.code, 'target-read')
        assert.equal(outcome.scope, 'run')
        assert.equal(outcome.sharedWrite, 'none')
      }
    }
  })

  it('changed-input carries sharedWrite confirmed once the run already shipped', async () => {
    const harness = preconditionHarness(
      { map: () => ok(snapshotOf([ticket7({ state: 'CLOSED' })])) },
      true,
    )
    assertChangedInput(await harness.run(), 'confirmed', 'ticket-state')
  })

  it('a malformed sealed change is a ticket-scoped error', async () => {
    const harness = preconditionHarness()
    const params: ShipReconcileParams = {
      ...harness.params,
      change: { ...harness.params.change, candidateCommit: 'not-an-oid' },
    }
    const outcome = await reconcileFinalCandidate(harness.deps, params)
    assert.equal(outcome.kind, 'error')
    if (outcome.kind !== 'error') return
    assert.equal(outcome.code, 'integration-shape')
    assert.equal(outcome.scope, 'ticket')
    assert.equal(outcome.sharedWrite, 'none')
  })
})

// ---------------------------------------------------------------------------
// §11.2 mechanics over real repositories
// ---------------------------------------------------------------------------

function strip(oid: string): string {
  return oid.replace(/^sha1:/, '')
}

function commitFactsOf(harness: RepoHarness, oid: string): { tree: string; parents: string[] } {
  const output = gitText(harness.repo.root, ['show', '-s', '--format=%T%n%P', strip(oid)])
  const [tree = '', parents = ''] = output.split('\n')
  return { tree, parents: parents.split(' ').filter((p) => p !== '') }
}

function isAncestor(harness: RepoHarness, ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', [
      '-C',
      harness.repo.root,
      'merge-base',
      '--is-ancestor',
      strip(ancestor),
      strip(descendant),
    ])
    return true
  } catch {
    return false
  }
}

function commitMessageOf(harness: RepoHarness, oid: string): string {
  return gitText(harness.repo.root, ['log', '-1', '--format=%B', strip(oid)])
}

describe('§11.2 with an unchanged target', () => {
  it('collapses worker history to one canonical commit reusing Work evidence', async () => {
    const harness = await makeRepoHarness({ label: 'unchanged-nonempty' })
    try {
      const commitsBefore = harness.countAllCommits()
      const outcome = await reconcileFinalCandidate(harness.deps, harness.params)
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind !== 'ok') return
      const candidate: FinalCandidate = outcome.value

      // Exactly one new commit: the canonical integration commit.
      assert.equal(harness.countAllCommits(), commitsBefore + 1)
      assert.equal(candidate.zeroDelta, false)
      assert.ok(candidate.integrationCommit)
      assert.equal(candidate.integratedSha, candidate.integrationCommit)

      const facts = commitFactsOf(harness, candidate.integrationCommit!)
      const targetSha = gitText(harness.repo.root, ['rev-parse', 'main'])
      // Parent equals the reviewed base == the current target.
      assert.deepEqual(facts.parents, [targetSha])
      assert.equal(strip(harness.params.change.baseSha), targetSha)
      // Tree equals the reviewed candidate tree.
      assert.equal(facts.tree, strip(harness.params.change.candidateTreeOid))
      assert.equal(candidate.treeOid, harness.params.change.candidateTreeOid)

      // The worker's intermediate commits never enter the integration history.
      assert.equal(
        isAncestor(harness, harness.params.change.candidateCommit, candidate.integrationCommit!),
        false,
        'worker commits must not be ancestors of the integration commit',
      )

      // Work evidence is reused verbatim: no fresh gates ran.
      assert.deepEqual(candidate.tests, harness.params.change.tests)
      assert.equal(candidate.review, harness.params.change.review)
      assert.equal(candidate.review.phase, 'work')
      assert.equal(harness.commands.requests.length, 0)
      assert.equal(harness.runner.launches, 0)
      assert.equal(harness.adoptions.length, 0)
      assert.equal(candidate.mapRevision, harness.params.change.mapRevision)
      assertNoPush(harness.gitCalls)
    } finally {
      harness.cleanup()
    }
  })

  it('the canonical commit message comes from the fixed template only', async () => {
    const harness = await makeRepoHarness({ label: 'canonical-message' })
    try {
      const outcome = await reconcileFinalCandidate(harness.deps, harness.params)
      assert.equal(outcome.kind, 'ok')
      if (outcome.kind !== 'ok') return

      const message = commitMessageOf(harness, outcome.value.integratedSha)
      assert.equal(
        message.trimEnd(),
        canonicalCommitMessage({
          ticketNumber: 7,
          ticketIssueId: TICKET_ISSUE_ID,
          mapIssueId: harness.params.accepted.payload.mapIssueId,
          runId: RUN_ID,
        }).trimEnd(),
      )
      // No worker prose, no issue text, no auto-close keywords.
      assert.equal(message.includes('fixes #99'), false)
      assert.equal(message.includes('Closes #12'), false)
      assert.equal(message.includes('worker change'), false)
      assert.equal(message.includes('Do the thing.'), false)
      assert.equal(containsAutoCloseKeyword(message), false)
      // The fixed committer identity, never the local git configuration.
      const identity = gitText(harness.repo.root, [
        'show',
        '-s',
        '--format=%an <%ae>',
        strip(outcome.value.integratedSha),
      ])
      assert.equal(identity, `${CANONICAL_COMMIT_IDENTITY.name} <${CANONICAL_COMMIT_IDENTITY.email}>`)
      assertNoPush(harness.gitCalls)
    } finally {
      harness.cleanup()
    }
  })

  it('a zero-delta finale creates no commit and records the current target SHA', async () => {
    const harness = await makeRepoHarness({ label: 'zero-delta-unchanged', workerFiles: [] })
    try {
      const commitsBefore = harness.countAllCommits()
      const outcome = await reconcileFinalCandidate(harness.deps, harness.params)
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind !== 'ok') return
      const candidate = outcome.value

      assert.equal(harness.countAllCommits(), commitsBefore, 'no commit may be created')
      assert.equal(candidate.zeroDelta, true)
      assert.equal(candidate.integrationCommit, null)
      const targetSha = gitText(harness.repo.root, ['rev-parse', 'main'])
      assert.equal(candidate.integratedSha, `sha1:${targetSha}`)
      assert.equal(candidate.baseSha, `sha1:${targetSha}`)
      assert.equal(candidate.treeOid, harness.params.change.candidateTreeOid)
      // The zero-delta Work evidence is reused as-is.
      assert.equal(candidate.review, harness.params.change.review)
      assert.equal(harness.runner.launches, 0)
      assertNoPush(harness.gitCalls)
    } finally {
      harness.cleanup()
    }
  })
})

describe('§11.2 with an advanced target', () => {
  it('replays cleanly, re-gates, and binds fresh evidence to the new base and tree', async () => {
    const acceptedMap = defaultMap()
    const extended = snapshotOf([ticket7(), memberC()])
    const harness = await makeRepoHarness({
      label: 'advanced-clean',
      targetFiles: [{ name: 'target-1.txt', content: 'independent target change\n' }],
      currentMap: extended,
    })
    try {
      const targetSha = `sha1:${gitText(harness.repo.root, ['rev-parse', 'main'])}`
      const outcome = await reconcileFinalCandidate(harness.deps, harness.params)
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind !== 'ok') return
      const candidate = outcome.value

      // The extension was adopted first, and the fresh review binds the latest
      // accepted revision, not the historical one (§11.2).
      assert.equal(harness.adoptions.length, 1)
      assert.equal(candidate.mapRevision, extended.mapRevision)
      assert.notEqual(candidate.mapRevision, acceptedMap.mapRevision)
      assert.equal(candidate.review.mapRevision, extended.mapRevision)

      // Canonical commit: parent is the advanced target; tree is the replay.
      assert.equal(candidate.baseSha, targetSha)
      const facts = commitFactsOf(harness, candidate.integrationCommit!)
      assert.deepEqual(facts.parents, [strip(targetSha)])
      assert.equal(facts.tree, strip(candidate.treeOid))
      assert.equal(candidate.zeroDelta, false)
      assert.equal(
        isAncestor(harness, harness.params.change.candidateCommit, candidate.integrationCommit!),
        false,
        'worker commits must not be ancestors of the integration commit',
      )

      // The reconciled final tree contains both sides of the advance.
      execFileSync('git', [
        '-C',
        harness.repo.root,
        'cat-file',
        '-e',
        `${strip(candidate.treeOid)}:target-1.txt`,
      ])
      execFileSync('git', [
        '-C',
        harness.repo.root,
        'cat-file',
        '-e',
        `${strip(candidate.treeOid)}:work-1.txt`,
      ])

      // Fresh gates ran: setup, the complete test list, and one reviewer.
      const argvs = harness.commands.requests.map((request) => request.argv.join(' '))
      assert.deepEqual(argvs, ['setup-cmd', 'npm test', 'npm run lint'])
      assert.ok(harness.commands.requests.every((request) => request.cwd === harness.workspacePath))
      assert.equal(harness.runner.launches, 1)
      assert.equal(harness.reviewerInputs.length, 1)

      // The fresh evidence binds the new base, the complete final tree, and
      // the ordered ship tests (§10.3).
      assert.equal(candidate.review.phase, 'ship')
      assert.equal(candidate.review.baseSha, targetSha)
      assert.equal(candidate.review.treeOid, candidate.treeOid)
      assert.equal(candidate.tests.length, 2)
      candidate.tests.forEach((entry, index) => {
        assert.equal(entry.phase, 'ship')
        assert.equal(entry.testIndex, index)
        assert.equal(entry.baseSha, targetSha)
        assert.equal(entry.treeOid, candidate.treeOid)
        assert.equal(entry.exitCode, 0)
      })
      assert.equal(candidate.review.testEvidenceDigest, canonicalJsonDigest(candidate.tests as never))

      // The reviewer judged the exact new bindings.
      const input = harness.reviewerInputs[0]!
      assert.equal(input.spec.mapRevision, extended.mapRevision)
      assert.equal(input.target.baseSha, targetSha)
      assert.equal(input.candidate.commit, candidate.integrationCommit)
      assert.equal(input.candidate.treeOid, candidate.treeOid)
      assert.equal(input.candidate.zeroDelta, false)
      assert.deepEqual(input.tests, candidate.tests)
      assert.ok(input.diff.length > 0)
      assertNoPush(harness.gitCalls)
    } finally {
      harness.cleanup()
    }
  })

  it('a replay conflict is ticket-scoped blocked(integration-conflict) with no push', async () => {
    const harness = await makeRepoHarness({
      label: 'replay-conflict',
      baseFiles: [{ name: SHARED_FILE, content: SHARED_FILE_BASE }],
      workerEdits: [{ name: SHARED_FILE, content: WORKER_LINE }],
      targetEdits: [{ name: SHARED_FILE, content: TARGET_LINE }],
    })
    try {
      const commitsBefore = harness.countAllCommits()
      const outcome = await reconcileFinalCandidate(harness.deps, harness.params)
      assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
      if (outcome.kind !== 'blocked') return
      assert.equal(outcome.code, 'integration-conflict')
      assert.equal(outcome.scope, 'ticket')
      assert.equal(outcome.sharedWrite, 'none')
      const evidence = outcome.evidence[0] as { conflictedPaths: string[] }
      assert.deepEqual(evidence.conflictedPaths, [SHARED_FILE])

      // Nothing else ran: no commit, no gates, no reviewer, no push.
      assert.equal(harness.countAllCommits(), commitsBefore)
      assert.equal(harness.commands.requests.length, 0)
      assert.equal(harness.runner.launches, 0)
      assertNoPush(harness.gitCalls)
    } finally {
      harness.cleanup()
    }
  })

  it('a replayed tree equal to the target tree is a zero-delta finale', async () => {
    const harness = await makeRepoHarness({
      label: 'zero-delta-replay',
      workerFiles: [{ name: 'feature.txt', content: 'the landed feature\n' }],
      targetFiles: [{ name: 'feature.txt', content: 'the landed feature\n' }],
    })
    try {
      const commitsBefore = harness.countAllCommits()
      const targetSha = `sha1:${gitText(harness.repo.root, ['rev-parse', 'main'])}`
      const outcome = await reconcileFinalCandidate(harness.deps, harness.params)
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind !== 'ok') return
      const candidate = outcome.value

      // No empty commit: the current target SHA is the integration SHA.
      assert.equal(harness.countAllCommits(), commitsBefore)
      assert.equal(candidate.zeroDelta, true)
      assert.equal(candidate.integrationCommit, null)
      assert.equal(candidate.integratedSha, targetSha)
      assert.equal(candidate.baseSha, targetSha)

      // Fresh gates still ran, bound to the new base and the target tree.
      assert.equal(harness.runner.launches, 1)
      assert.equal(candidate.review.phase, 'ship')
      assert.equal(candidate.review.baseSha, targetSha)
      assert.equal(candidate.review.treeOid, candidate.treeOid)
      const input = harness.reviewerInputs[0]!
      assert.equal(input.candidate.zeroDelta, true)
      assert.equal(input.candidate.treeOid, candidate.treeOid)
      assertNoPush(harness.gitCalls)
    } finally {
      harness.cleanup()
    }
  })

  it('review is never reused merely because the changed files look unchanged', async () => {
    // The target advanced with an empty commit: the candidate tree itself is
    // unchanged, but the evidence binding base changed, so fresh gates run.
    const harness = await makeRepoHarness({ label: 'same-tree-new-base' })
    try {
      const root = harness.repo.root
      execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '--no-gpg-sign', '-m', 'empty advance'])
      const targetSha = `sha1:${gitText(root, ['rev-parse', 'main'])}`

      const outcome = await reconcileFinalCandidate(harness.deps, harness.params)
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind !== 'ok') return
      const candidate = outcome.value
      assert.equal(candidate.baseSha, targetSha)
      assert.equal(candidate.treeOid, harness.params.change.candidateTreeOid)
      assert.equal(candidate.review.phase, 'ship')
      assert.equal(candidate.review.baseSha, targetSha)
      assert.equal(candidate.review.treeOid, harness.params.change.candidateTreeOid)
      assert.equal(harness.runner.launches, 1, 'the reused work review is not applicable')
      assertNoPush(harness.gitCalls)
    } finally {
      harness.cleanup()
    }
  })

  it('a failed integration setup gate is ticket-scoped blocked(ship-gate-failed)', async () => {
    const harness = await makeRepoHarness({
      label: 'setup-failure',
      targetFiles: [{ name: 'target-1.txt', content: 'advance\n' }],
      commandScript: (argv) => (argv[0] === 'setup-cmd' ? commandFailure('setup exploded') : undefined),
    })
    try {
      const outcome = await reconcileFinalCandidate(harness.deps, harness.params)
      assert.equal(outcome.kind, 'blocked')
      if (outcome.kind !== 'blocked') return
      assert.equal(outcome.code, 'ship-gate-failed')
      assert.equal(outcome.scope, 'ticket')
      assert.equal(outcome.sharedWrite, 'none')
      assert.equal((outcome.evidence[0] as { gate: string }).gate, 'setup')
      // The tests never ran and no reviewer launched.
      assert.equal(harness.commands.requests.length, 1)
      assert.equal(harness.runner.launches, 0)
      assertNoPush(harness.gitCalls)
    } finally {
      harness.cleanup()
    }
  })

  it('a failed integration test gate is ticket-scoped blocked(ship-gate-failed)', async () => {
    const harness = await makeRepoHarness({
      label: 'test-failure',
      targetFiles: [{ name: 'target-1.txt', content: 'advance\n' }],
      commandScript: (argv) => (argv[1] === 'test' ? commandFailure('tests failed') : undefined),
    })
    try {
      const outcome = await reconcileFinalCandidate(harness.deps, harness.params)
      assert.equal(outcome.kind, 'blocked')
      if (outcome.kind !== 'blocked') return
      assert.equal(outcome.code, 'ship-gate-failed')
      assert.equal(outcome.scope, 'ticket')
      assert.equal(outcome.sharedWrite, 'none')
      assert.equal((outcome.evidence[0] as { gate: string }).gate, 'tests')
      const argvs = harness.commands.requests.map((request) => request.argv.join(' '))
      assert.deepEqual(argvs, ['setup-cmd', 'npm test'])
      assert.equal(harness.runner.launches, 0)
      assertNoPush(harness.gitCalls)
    } finally {
      harness.cleanup()
    }
  })

  it('a reviewer iterate or block verdict is ticket-scoped blocked(ship-gate-failed)', async () => {
    const verdicts = [
      { label: 'iterate', verdict: { discriminant: 'iterate', feedback: 'misses the criterion' } as const },
      {
        label: 'block',
        verdict: { discriminant: 'block', code: 'spec-defect', reason: 'contradiction' } as const,
      },
    ]
    for (const { label, verdict } of verdicts) {
      const harness = await makeRepoHarness({
        label: `review-${label}`,
        targetFiles: [{ name: 'target-1.txt', content: 'advance\n' }],
        reviewerVerdict: () => verdict,
      })
      try {
        const outcome = await reconcileFinalCandidate(harness.deps, harness.params)
        assert.equal(outcome.kind, 'blocked', label)
        if (outcome.kind !== 'blocked') continue
        assert.equal(outcome.code, 'ship-gate-failed', label)
        assert.equal(outcome.scope, 'ticket', label)
        assert.equal(outcome.sharedWrite, 'none', label)
        assert.equal((outcome.evidence[0] as { gate: string }).gate, 'review', label)
        assert.equal(harness.runner.launches, 1, label)
        assertNoPush(harness.gitCalls)
      } finally {
        harness.cleanup()
      }
    }
  })

  it('a gate command that mutates the workspace is a ticket-scoped protocol error', async () => {
    const harness = await makeRepoHarness({
      label: 'gate-protocol',
      targetFiles: [{ name: 'target-1.txt', content: 'advance\n' }],
      commandScript: (argv, call) => {
        if (argv[0] === 'npm' && call === 1) {
          writeFileSync(join(harness.workspacePath, 'dirty.txt'), 'mutation\n', 'utf8')
        }
        return undefined
      },
    })
    try {
      const outcome = await reconcileFinalCandidate(harness.deps, harness.params)
      assert.equal(outcome.kind, 'error', JSON.stringify(outcome))
      if (outcome.kind !== 'error') return
      assert.equal(outcome.code, 'command-protocol')
      assert.equal(outcome.scope, 'ticket')
      assert.equal(outcome.sharedWrite, 'none')
      assert.equal(harness.runner.launches, 0)
      assertNoPush(harness.gitCalls)
    } finally {
      harness.cleanup()
    }
  })

  it('a reviewer launch failure is a ticket-scoped error with no push', async () => {
    const harness = await makeRepoHarness({
      label: 'reviewer-launch-failure',
      targetFiles: [{ name: 'target-1.txt', content: 'advance\n' }],
      reviewerLaunchMode: 'throw',
    })
    try {
      const outcome = await reconcileFinalCandidate(harness.deps, harness.params)
      assert.equal(outcome.kind, 'error')
      if (outcome.kind !== 'error') return
      assert.equal(outcome.code, 'launch-failed')
      assert.equal(outcome.scope, 'ticket')
      assert.equal(outcome.sharedWrite, 'none')
      assertNoPush(harness.gitCalls)
    } finally {
      harness.cleanup()
    }
  })

  it('a reviewer plan with write-capable tools is rejected before launch', async () => {
    const harness = await makeRepoHarness({
      label: 'reviewer-not-readonly',
      targetFiles: [{ name: 'target-1.txt', content: 'advance\n' }],
      reviewerPlan: () => ({ argv: ['pi', '--tools', 'read,bash,edit,norn_complete'] }),
    })
    try {
      const outcome = await reconcileFinalCandidate(harness.deps, harness.params)
      assert.equal(outcome.kind, 'error')
      if (outcome.kind !== 'error') return
      assert.equal(outcome.code, 'reviewer-not-read-only')
      assert.equal(outcome.scope, 'ticket')
      assert.equal(outcome.sharedWrite, 'none')
      assert.equal(harness.runner.launches, 0)
      assertNoPush(harness.gitCalls)
    } finally {
      harness.cleanup()
    }
  })

  it('a sealed workspace that is no longer at the candidate is a ticket-scoped error', async () => {
    const harness = await makeRepoHarness({
      label: 'dirty-workspace',
      targetFiles: [{ name: 'target-1.txt', content: 'advance\n' }],
    })
    try {
      writeFileSync(join(harness.workspacePath, 'leftover.txt'), 'stray\n', 'utf8')
      const outcome = await reconcileFinalCandidate(harness.deps, harness.params)
      assert.equal(outcome.kind, 'error', JSON.stringify(outcome))
      if (outcome.kind !== 'error') return
      assert.equal(outcome.code, 'workspace-verification-failed')
      assert.equal(outcome.scope, 'ticket')
      assert.equal(outcome.sharedWrite, 'none')
      assert.equal(harness.runner.launches, 0)
      assertNoPush(harness.gitCalls)
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// The production extension-adoption store (§7.4, §13.1)
// ---------------------------------------------------------------------------

describe('runStateAdoptExtension', () => {
  function minimalRunState(accepted: AcceptedMapRevision): RunState {
    return {
      schema: 'norn-run-state:v1',
      runId: RUN_ID,
      map: {
        role: 'map',
        githubHost: 'github.com',
        repositoryId: REPOSITORY_ID,
        issueId: 'I_map',
        number: 6,
        url: 'https://github.com/acme/widget/issues/6',
      },
      acceptedMapRevisions: [accepted],
      configRevision: canonicalJsonDigest({ fixture: 'config' } as never),
      nornVersion: '0.1.0',
      status: 'running',
      wave: 0,
      parkedTickets: [],
      tickets: {},
      activeProcesses: [],
    }
  }

  it('appends the verified extension to the accepted lineage', async () => {
    const home = mkdtempSync(join(tmpdir(), 'norn-adopt-home-'))
    try {
      const acceptedMap = defaultMap()
      const extended = snapshotOf([ticket7(), memberC()])
      assert.equal(
        saveRunState(home, encodePathSegment('I_map'), minimalRunState(acceptedEntryOf(acceptedMap))).kind,
        'ok',
      )

      const adopt = runStateAdoptExtension({
        repositoryHome: home,
        encodedMapIssueId: encodePathSegment('I_map'),
      })
      const outcome = await adopt({
        revision: extended.mapRevision,
        payload: snapshotMapPayload(extended).payload,
        fromRevision: acceptedMap.mapRevision,
        addedTicketIssueIds: ['I_C'],
      })
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))

      const loaded = loadRunState(home, encodePathSegment('I_map'))
      assert.equal(loaded.kind, 'ok')
      if (loaded.kind !== 'ok') return
      const entries = loaded.value!.acceptedMapRevisions
      assert.equal(entries.length, 2)
      assert.equal(entries[1]!.revision, extended.mapRevision)
      assert.deepEqual(entries[1]!.extension, {
        fromRevision: acceptedMap.mapRevision,
        addedTicketIssueIds: ['I_C'],
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('refuses when the persisted latest revision is not the extension base', async () => {
    const home = mkdtempSync(join(tmpdir(), 'norn-adopt-mismatch-'))
    try {
      const acceptedMap = defaultMap()
      const extended = snapshotOf([ticket7(), memberC()])
      assert.equal(
        saveRunState(home, encodePathSegment('I_map'), minimalRunState(acceptedEntryOf(acceptedMap))).kind,
        'ok',
      )
      const adopt = runStateAdoptExtension({
        repositoryHome: home,
        encodedMapIssueId: encodePathSegment('I_map'),
      })

      const outcome = await adopt({
        revision: extended.mapRevision,
        payload: snapshotMapPayload(extended).payload,
        fromRevision: extended.mapRevision,
        addedTicketIssueIds: ['I_C'],
      })
      assert.equal(outcome.kind, 'error')
      if (outcome.kind === 'error') assert.equal(outcome.code, 'control-store')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('refuses a transition the lineage integrity rules reject', async () => {
    const home = mkdtempSync(join(tmpdir(), 'norn-adopt-invalid-'))
    try {
      const acceptedMap = defaultMap()
      // The "extension" removes the accepted member: not a Compatible
      // Extension, so the persisted lineage must reject it.
      const incompatible = snapshotOf([memberC()])
      assert.equal(
        saveRunState(home, encodePathSegment('I_map'), minimalRunState(acceptedEntryOf(acceptedMap))).kind,
        'ok',
      )
      const adopt = runStateAdoptExtension({
        repositoryHome: home,
        encodedMapIssueId: encodePathSegment('I_map'),
      })

      const outcome = await adopt({
        revision: incompatible.mapRevision,
        payload: snapshotMapPayload(incompatible).payload,
        fromRevision: acceptedMap.mapRevision,
        addedTicketIssueIds: ['I_C'],
      })
      assert.equal(outcome.kind, 'error')
      if (outcome.kind === 'error') assert.equal(outcome.code, 'control-store')
      const loaded = loadRunState(home, encodePathSegment('I_map'))
      assert.equal(loaded.kind, 'ok')
      if (loaded.kind === 'ok') assert.equal(loaded.value!.acceptedMapRevisions.length, 1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('refuses when no run state exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'norn-adopt-empty-'))
    try {
      const adopt = runStateAdoptExtension({
        repositoryHome: home,
        encodedMapIssueId: encodePathSegment('I_map'),
      })
      const acceptedMap = defaultMap()
      const outcome = await adopt({
        revision: acceptedMap.mapRevision,
        payload: snapshotMapPayload(acceptedMap).payload,
        fromRevision: acceptedMap.mapRevision,
        addedTicketIssueIds: [],
      })
      assert.equal(outcome.kind, 'error')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
