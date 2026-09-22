/**
 * The Work round gate against real temporary repositories (design.md §10.2,
 * ticket #9). Fake workers and reviewers perform real git effects and write
 * real completion sidecars; the gate's independent OID reads, lineage and
 * cleanliness checks, diff generation, and evidence binding therefore run
 * against a true repository — deterministically, with no Pi launches.
 *
 * Covers the acceptance criteria: the full round gate from slot reservation
 * to sealed Shippable Change; round advancement on clean setup/test failures
 * and reviewer iterate; exhaustion, typed blocks, and child interruption as
 * ticket-scoped blocked outcomes with no shared write; launch and settle
 * failures as ticket-scoped errors; no-merge lineage, independent OID reads,
 * and cleanliness; the read-only reviewer and its post-exit re-verification;
 * zero-delta candidates; and round/launch-intent persistence before process
 * creation.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, it } from 'node:test'

import { runGit } from '../src/adapters/git-repository.ts'
import type { GitCommandRunner } from '../src/adapters/git-repository.ts'
import { error } from '../src/core/outcome.ts'
import type { WorkInput } from '../src/runstate/types.ts'
import type { WorkAttemptRecord, WorkOutcome } from '../src/work/round-gate.ts'
import { runWorkAttempt } from '../src/work/round-gate.ts'

import {
  attemptRecord,
  commitInWorkspace,
  committingWorker,
  failed,
  fakeStore,
  makeHarness,
  passDigest,
  passed,
  preCreateWorkspace,
  readWorkspaceOids,
  writeUntracked,
  zeroDeltaWorker,
} from './helpers/round-gate-fixtures.ts'
import type { Harness, ReviewerScript, WorkerScript } from './helpers/round-gate-fixtures.ts'

const passReviewer: ReviewerScript = () => ({ discriminant: 'pass' })

function expectBlocked(outcome: WorkOutcome, code: string): void {
  assert.ok(outcome.kind === 'blocked', `expected blocked, got ${JSON.stringify(outcome)}`)
  assert.equal(outcome.code, code)
  assert.equal(outcome.scope, 'ticket')
  assert.equal(outcome.sharedWrite, 'none')
}

function expectError(outcome: WorkOutcome, code: string, scope: 'ticket' | 'run' = 'ticket'): void {
  assert.ok(outcome.kind === 'error', `expected error, got ${JSON.stringify(outcome)}`)
  assert.equal(outcome.code, code)
  assert.equal(outcome.scope, scope)
  assert.equal(outcome.sharedWrite, 'none')
}

/** A reviewer that iterates on its first call and passes afterwards. */
function iterateThenPass(): ReviewerScript {
  return ({ call }) =>
    call === 0
      ? { discriminant: 'iterate', feedback: 'cover the failure path too' }
      : { discriminant: 'pass' }
}

/** Seed a harness store with a persisted attempt to resume from. */
function seedResume(
  harness: Harness,
  attempt: { round: number; slot: 'awaiting-reservation' | 'reserved' | 'released' },
  mutateInput?: (input: WorkInput) => WorkInput,
): void {
  const input = mutateInput === undefined ? harness.input : mutateInput(harness.input)
  const record = attemptRecord(input, harness.repositoryHome, attempt)
  const working = harness.store.working as WorkAttemptRecord[]
  working.length = 0
  working.push(record)
}

describe('runWorkAttempt: the full round gate', () => {
  it('seals a shippable change after one passing round', async () => {
    const harness = makeHarness({ label: 'seal', worker: committingWorker(), reviewer: passReviewer })
    try {
      const outcome = await harness.run()
      assert.ok(outcome.kind === 'ok', JSON.stringify(outcome))
      const change = outcome.value
      const oids = readWorkspaceOids(harness.workspacePath)

      assert.equal(change.candidateCommit, oids.commit)
      assert.equal(change.candidateTreeOid, oids.treeOid)
      assert.equal(change.baseSha, harness.input.target.baseSha)
      assert.equal(change.mapRevision, harness.input.spec.mapRevision)
      assert.equal(change.ticketRevision, harness.input.spec.ticketRevision)
      assert.equal(change.workspace.path, harness.workspacePath)
      assert.equal((change.workspace as { branch?: string }).branch, 'norn/run-9/7/wa-1')

      assert.equal(change.tests.length, 1)
      const test = change.tests[0]!
      assert.equal(test.phase, 'work')
      assert.equal(test.testIndex, 0)
      assert.deepEqual(test.argv, ['npm', 'test'])
      assert.equal(test.timeoutMs, 60_000)
      assert.equal(test.exitCode, 0)
      assert.equal(test.baseSha, harness.input.target.baseSha)
      assert.equal(test.treeOid, oids.treeOid)
      assert.equal(test.outputDigest, passDigest(0))

      const review = change.review
      assert.equal(review.phase, 'work')
      assert.equal(review.verdict, 'pass')
      assert.equal(review.provider, 'provider-b')
      assert.equal(review.model, 'provider-b/model-y')
      assert.equal(review.family, 'provider-b')
      assert.equal(review.thinking, 'high')
      assert.equal(review.baseSha, change.baseSha)
      assert.equal(review.treeOid, change.candidateTreeOid)

      // The attempt-owned branch exists at the candidate; the slot was
      // reserved before the workspace and released after the seal.
      assert.equal(
        gitSha(harness.repo.root, 'norn/run-9/7/wa-1'),
        oids.commit,
      )
      assert.equal(harness.slots.reserveCalls, 1)
      assert.equal(harness.slots.releaseCalls, 1)
      assert.deepEqual(
        harness.events.slice(0, 3),
        ['saveWorking:0:awaiting-reservation', 'saveWorking:0:reserved', 'saveWorking:1:reserved'],
      )
      assert.equal(harness.events.at(-1), 'saveTerminal:sealed')

      const sealed = harness.store.terminals[0]
      assert.equal(sealed?.terminal.kind, 'sealed')
      assert.equal(sealed?.workAttemptId, 'wa-1')

      // Both owned invocations are recorded as settled process groups.
      const lastWorking = harness.store.latestRecord()
      assert.deepEqual(lastWorking?.attempt.processGroupIds, ['wa-1-worker-r1', 'wa-1-reviewer-r1'])
      assert.ok(lastWorking?.processes.every((group) => group.state === 'settled'))
    } finally {
      harness.cleanup()
    }
  })

  it('hands a clean initial-setup non-pass to the first worker as feedback', async () => {
    const harness = makeHarness({
      label: 'initial-setup',
      worker: committingWorker(),
      reviewer: passReviewer,
      setup: [{ argv: ['npm', 'ci'], timeoutMs: 60_000 }],
      commandScript: (_request, call) => (call === 0 ? failed('ci boom') : passed(`pass-${call}`)),
    })
    try {
      const outcome = await harness.run()
      assert.ok(outcome.kind === 'ok', JSON.stringify(outcome))
      assert.equal(harness.workerInputs.length, 1)
      const feedback = harness.workerInputs[0]!.feedback
      assert.equal(feedback.length, 1)
      assert.equal(feedback[0]!.kind, 'setup')
      assert.equal(feedback[0]!.round, 0)
      assert.equal(feedback[0]!.origin, 'initial')
      assert.equal(feedback[0]!.exitCode, 1)
    } finally {
      harness.cleanup()
    }
  })

  it('seeds a fresh attempt with carried conflict feedback for its first round', async () => {
    const harness = makeHarness({ label: 'carried-conflict', worker: committingWorker(), reviewer: passReviewer })
    try {
      const outcome = await runWorkAttempt(harness.deps, {
        ...harness.params,
        carriedFeedback: [
          {
            kind: 'conflict',
            round: 0,
            code: 'integration-conflict',
            reason: 'the candidate conflicts when replayed onto the advanced target',
            evidence: [{ conflictedPaths: ['shared.txt'] }],
          },
        ],
      })
      assert.ok(outcome.kind === 'ok', JSON.stringify(outcome))
      assert.equal(harness.workerInputs.length, 1)
      const feedback = harness.workerInputs[0]!.feedback
      assert.equal(feedback.length, 1)
      assert.equal(feedback[0]!.kind, 'conflict')
      if (feedback[0]!.kind === 'conflict') {
        assert.equal(feedback[0]!.round, 0)
        assert.equal(feedback[0]!.code, 'integration-conflict')
        assert.deepEqual(feedback[0]!.evidence, [{ conflictedPaths: ['shared.txt'] }])
      }
    } finally {
      harness.cleanup()
    }
  })

  it('advances the round on a clean candidate-setup failure with structured feedback', async () => {
    const harness = makeHarness({
      label: 'setup-fail',
      worker: committingWorker(),
      reviewer: passReviewer,
      setup: [{ argv: ['npm', 'ci'], timeoutMs: 60_000 }],
      // call 0: initial setup passes; call 1: round-1 candidate setup fails.
      commandScript: (_request, call) => (call === 1 ? failed('candidate ci boom') : passed(`pass-${call}`)),
    })
    try {
      const outcome = await harness.run()
      assert.ok(outcome.kind === 'ok', JSON.stringify(outcome))
      assert.equal(harness.runner.launches.length, 3, 'two workers plus one reviewer')
      assert.equal(harness.workerInputs.length, 2)
      const feedback = harness.workerInputs[1]!.feedback
      assert.equal(feedback.length, 1)
      assert.equal(feedback[0]!.kind, 'setup')
      assert.equal(feedback[0]!.round, 1)
      assert.equal(feedback[0]!.origin, 'candidate')
      assert.equal(feedback[0]!.exitCode, 1)
    } finally {
      harness.cleanup()
    }
  })

  it('advances the round on a clean test failure with test feedback', async () => {
    const harness = makeHarness({
      label: 'test-fail',
      worker: committingWorker(),
      reviewer: passReviewer,
      commandScript: (_request, call) => (call === 0 ? failed('tests boom') : passed(`pass-${call}`)),
    })
    try {
      const outcome = await harness.run()
      assert.ok(outcome.kind === 'ok', JSON.stringify(outcome))
      assert.equal(harness.workerInputs.length, 2)
      const feedback = harness.workerInputs[1]!.feedback
      assert.equal(feedback[0]!.kind, 'tests')
      assert.equal(feedback[0]!.round, 1)
      assert.equal(feedback[0]!.testIndex, 0)
    } finally {
      harness.cleanup()
    }
  })

  it('starts a later round from the previous clean candidate commit', async () => {
    const headsBeforeCommit: string[] = []
    const worker: WorkerScript = ({ workspacePath, round }) => {
      headsBeforeCommit.push(readWorkspaceOids(workspacePath).commit)
      const oids = commitInWorkspace(workspacePath, `work-${round}.txt`, `round ${round}\n`)
      return { discriminant: 'candidate', claimedCommit: oids.commit, claimedTreeOid: oids.treeOid }
    }
    const harness = makeHarness({ label: 'iterate', worker, reviewer: iterateThenPass() })
    try {
      const outcome = await harness.run()
      assert.ok(outcome.kind === 'ok', JSON.stringify(outcome))

      // Round 1 started at the base; round 2 started at round 1's commit.
      assert.equal(headsBeforeCommit[0], harness.input.target.baseSha)
      assert.match(headsBeforeCommit[1]!, /^sha1:[0-9a-f]{40}$/)
      assert.notEqual(headsBeforeCommit[1], harness.input.target.baseSha)
      assert.equal(harness.workerInputs[1]!.previousCandidateCommit, headsBeforeCommit[1])

      // The iterate feedback reached the second worker.
      const feedback = harness.workerInputs[1]!.feedback
      assert.equal(feedback.length, 1)
      assert.equal(feedback[0]!.kind, 'review')
      assert.equal(feedback[0]!.round, 1)
    } finally {
      harness.cleanup()
    }
  })

  it('parks the ticket as blocked with no shared write when rounds are exhausted', async () => {
    const harness = makeHarness({
      label: 'exhausted',
      worker: committingWorker(),
      reviewer: iterateThenPass(),
      maxWorkRounds: 1,
    })
    try {
      const outcome = await harness.run()
      expectBlocked(outcome, 'work-rounds-exhausted')
      assert.equal(harness.workerInputs.length, 1, 'the budget allowed exactly one worker')
      assert.equal(harness.slots.releaseCalls, 1)

      const parked = harness.store.terminals[0]
      assert.equal(parked?.terminal.kind, 'parked')
      if (parked?.terminal.kind === 'parked') {
        assert.equal(parked.terminal.outcome.kind, 'blocked')
        assert.equal(parked.terminal.outcome.code, 'work-rounds-exhausted')
        assert.equal(parked.terminal.workspace?.path, harness.workspacePath)
      }
    } finally {
      harness.cleanup()
    }
  })

  it('parks the ticket immediately on a typed worker block', async () => {
    const harness = makeHarness({
      label: 'worker-block',
      worker: () => ({
        discriminant: 'block',
        code: 'cannot-satisfy-spec',
        reason: 'the spec needs a decision',
      }),
      reviewer: passReviewer,
    })
    try {
      const outcome = await harness.run()
      expectBlocked(outcome, 'worker-block')
      assert.ok(outcome.kind === 'blocked')
      assert.deepEqual(outcome.evidence[0], {
        code: 'cannot-satisfy-spec',
        reason: 'the spec needs a decision',
        round: 1,
      })
      assert.equal(harness.runner.launches.length, 1, 'no reviewer runs after a worker block')
      assert.equal(harness.slots.releaseCalls, 1)
    } finally {
      harness.cleanup()
    }
  })

  it('parks the ticket on a typed reviewer block', async () => {
    const harness = makeHarness({
      label: 'reviewer-block',
      worker: committingWorker(),
      reviewer: () => ({
        discriminant: 'block',
        code: 'spec-defect',
        reason: 'the ticket contradicts the map',
      }),
    })
    try {
      const outcome = await harness.run()
      expectBlocked(outcome, 'reviewer-block')
      assert.ok(outcome.kind === 'blocked')
      assert.deepEqual(outcome.evidence[0], {
        code: 'spec-defect',
        reason: 'the ticket contradicts the map',
        round: 1,
      })
    } finally {
      harness.cleanup()
    }
  })

  it('seals a zero-delta candidate when the reviewer passes the base tree', async () => {
    const harness = makeHarness({ label: 'zero-delta', worker: zeroDeltaWorker(), reviewer: passReviewer })
    try {
      const outcome = await harness.run()
      assert.ok(outcome.kind === 'ok', JSON.stringify(outcome))
      const change = outcome.value
      const base = harness.baseOids()
      assert.equal(change.candidateCommit, base.commit)
      assert.equal(change.candidateTreeOid, base.treeOid)
      assert.equal(change.tests[0]!.treeOid, base.treeOid)
      assert.equal(readWorkspaceOids(harness.workspacePath).commit, base.commit)

      // The reviewer judged the zero-delta assertion explicitly.
      assert.equal(harness.reviewerInputs[0]!.candidate.zeroDelta, true)
      assert.equal(harness.reviewerInputs[0]!.diff, '')
    } finally {
      harness.cleanup()
    }
  })
})

describe('runWorkAttempt: candidate acceptance', () => {
  it('rejects a handoff whose OIDs differ from the independent reads', async () => {
    const harness = makeHarness({
      label: 'handoff-mismatch',
      worker: ({ workspacePath, round }) => {
        commitInWorkspace(workspacePath, `work-${round}.txt`, `round ${round}\n`)
        return {
          discriminant: 'candidate',
          claimedCommit: `sha1:${'f'.repeat(40)}`,
          claimedTreeOid: `sha1:${'e'.repeat(40)}`,
        }
      },
      reviewer: passReviewer,
    })
    try {
      const outcome = await harness.run()
      expectError(outcome, 'handoff-mismatch')
      assert.equal(harness.runner.launches.length, 1, 'no reviewer after a handoff mismatch')
    } finally {
      harness.cleanup()
    }
  })

  it('rejects a candidate whose history contains a merge commit', async () => {
    const harness = makeHarness({
      label: 'merge-commit',
      worker: ({ workspacePath }) => {
        execFileSync('git', ['-C', workspacePath, 'checkout', '-q', '-b', 'side'])
        commitInWorkspace(workspacePath, 'side.txt', 'side\n')
        execFileSync('git', ['-C', workspacePath, 'checkout', '-q', 'norn/run-9/7/wa-1'])
        execFileSync('git', ['-C', workspacePath, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'side'])
        const oids = readWorkspaceOids(workspacePath)
        return { discriminant: 'candidate', claimedCommit: oids.commit, claimedTreeOid: oids.treeOid }
      },
      reviewer: passReviewer,
    })
    try {
      const outcome = await harness.run()
      expectError(outcome, 'candidate-verification')
      assert.ok(outcome.kind === 'error')
      assert.match(JSON.stringify(outcome.evidence), /merge commits/)
    } finally {
      harness.cleanup()
    }
  })

  it('rejects a candidate left unclean by the worker', async () => {
    const harness = makeHarness({
      label: 'unclean',
      worker: ({ workspacePath }) => {
        writeUntracked(workspacePath, 'worker-leftover.txt')
        const oids = readWorkspaceOids(workspacePath)
        return { discriminant: 'candidate', claimedCommit: oids.commit, claimedTreeOid: oids.treeOid }
      },
      reviewer: passReviewer,
    })
    try {
      const outcome = await harness.run()
      expectError(outcome, 'candidate-verification')
      assert.ok(outcome.kind === 'error')
      assert.match(JSON.stringify(outcome.evidence), /worker-leftover/)
    } finally {
      harness.cleanup()
    }
  })

  it('rejects a candidate whose HEAD left the attempt-owned branch', async () => {
    const harness = makeHarness({
      label: 'detached',
      worker: ({ workspacePath }) => {
        execFileSync('git', ['-C', workspacePath, 'checkout', '-q', '--detach'])
        const oids = readWorkspaceOids(workspacePath)
        return { discriminant: 'candidate', claimedCommit: oids.commit, claimedTreeOid: oids.treeOid }
      },
      reviewer: passReviewer,
    })
    try {
      const outcome = await harness.run()
      expectError(outcome, 'candidate-verification')
      assert.ok(outcome.kind === 'error')
      assert.match(JSON.stringify(outcome.evidence), /symbolicHead/)
    } finally {
      harness.cleanup()
    }
  })
})

describe('runWorkAttempt: the read-only reviewer and its re-verification', () => {
  it('refuses a reviewer launch plan that exposes write-capable tools', async () => {
    const harness = makeHarness({
      label: 'reviewer-tools',
      worker: committingWorker(),
      reviewer: passReviewer,
      reviewerPlannerOverride: () => ({ argv: ['pi', '--tools', 'bash,edit,write,norn_complete'] }),
    })
    try {
      const outcome = await harness.run()
      expectError(outcome, 'reviewer-not-read-only')
      assert.equal(harness.runner.launches.length, 1, 'the reviewer process was never created')
    } finally {
      harness.cleanup()
    }
  })

  it('re-verifies HEAD after the reviewer exits and rejects a reviewer commit', async () => {
    const harness = makeHarness({
      label: 'reviewer-commit',
      worker: committingWorker(),
      reviewer: ({ workspacePath }) => {
        commitInWorkspace(workspacePath, 'reviewer-edit.txt', 'sneaky\n')
        return { discriminant: 'pass' }
      },
    })
    try {
      const outcome = await harness.run()
      expectError(outcome, 'reviewer-verification')
      assert.ok(outcome.kind === 'error')
      assert.match(JSON.stringify(outcome.evidence), /head/)
    } finally {
      harness.cleanup()
    }
  })

  it('rejects a reviewer that leaves the workspace unclean', async () => {
    const harness = makeHarness({
      label: 'reviewer-unclean',
      worker: committingWorker(),
      reviewer: ({ workspacePath }) => {
        writeUntracked(workspacePath, 'reviewer-leftover.txt')
        return { discriminant: 'pass' }
      },
    })
    try {
      const outcome = await harness.run()
      expectError(outcome, 'reviewer-verification')
      assert.ok(outcome.kind === 'error')
      assert.match(JSON.stringify(outcome.evidence), /reviewer-leftover/)
    } finally {
      harness.cleanup()
    }
  })

  it('rejects a reviewer that moves HEAD off the attempt branch', async () => {
    const harness = makeHarness({
      label: 'reviewer-detach',
      worker: committingWorker(),
      reviewer: ({ workspacePath }) => {
        execFileSync('git', ['-C', workspacePath, 'checkout', '-q', '--detach'])
        return { discriminant: 'pass' }
      },
    })
    try {
      const outcome = await harness.run()
      expectError(outcome, 'reviewer-verification')
      assert.ok(outcome.kind === 'error')
      assert.match(JSON.stringify(outcome.evidence), /symbolicHead/)
    } finally {
      harness.cleanup()
    }
  })
})

describe('runWorkAttempt: settlement and interruption', () => {
  it('returns ticket-scoped blocked user-abort when the worker is interrupted', async () => {
    const controller = new AbortController()
    const harness = makeHarness({
      label: 'user-abort',
      workerMode: 'hang',
      onLaunch: () => controller.abort(),
    })
    try {
      const outcome = await harness.run(controller.signal)
      expectBlocked(outcome, 'user-abort')
      assert.equal(harness.runner.terminated.length, 1, 'the process group was terminated')
      assert.equal(harness.slots.releaseCalls, 1)
      assert.equal(harness.store.terminals[0]?.terminal.kind, 'parked')
    } finally {
      harness.cleanup()
    }
  })

  it('returns ticket-scoped error on a worker launch failure', async () => {
    const harness = makeHarness({ label: 'launch-failed', workerMode: 'throw' })
    try {
      const outcome = await harness.run()
      expectError(outcome, 'launch-failed')
      assert.equal(harness.store.terminals[0]?.terminal.kind, 'parked')
      assert.equal(harness.slots.releaseCalls, 1)
    } finally {
      harness.cleanup()
    }
  })

  it('returns ticket-scoped error when the worker exits without a sidecar', async () => {
    const harness = makeHarness({ label: 'no-sidecar', workerMode: 'exit-no-sidecar' })
    try {
      const outcome = await harness.run()
      expectError(outcome, 'protocol-error')
    } finally {
      harness.cleanup()
    }
  })

  it('returns ticket-scoped error when the reviewer exits without a sidecar', async () => {
    const harness = makeHarness({
      label: 'reviewer-no-sidecar',
      worker: committingWorker(),
      reviewerMode: 'exit-no-sidecar',
    })
    try {
      const outcome = await harness.run()
      expectError(outcome, 'protocol-error')
    } finally {
      harness.cleanup()
    }
  })
})

describe('runWorkAttempt: slots, state, and crash-safety', () => {
  it('blocks before creating any workspace when the slot registry is full', async () => {
    const harness = makeHarness({
      label: 'slot-full',
      worker: committingWorker(),
      reviewer: passReviewer,
      slots: { reserve: 'full' },
    })
    try {
      const outcome = await harness.run()
      expectBlocked(outcome, 'slot-unavailable')
      assert.equal(harness.runner.launches.length, 0)
      assert.equal(harness.slots.releaseCalls, 0, 'nothing was reserved, nothing to release')
      assert.equal(existsSync(harness.workspacePath), false, 'no workspace was created')
      assert.equal(harness.store.terminals[0]?.terminal.kind, 'parked')
    } finally {
      harness.cleanup()
    }
  })

  it('defers on a full registry, then works once another run releases capacity', async () => {
    // §16: shared repository-wide capacity — a full registry defers the
    // attempt (polling within its budget) instead of parking it, so Work of
    // concurrent maps interleaves as reservations release.
    const harness = makeHarness({
      label: 'slot-defer',
      worker: committingWorker(),
      reviewer: passReviewer,
      slots: { fullFirst: 3 },
      slotWaitMs: 2_000,
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok', outcome.kind === 'error' ? outcome.reason : '')
      assert.ok(harness.slots.reserveCalls > 3, 'the attempt polled while deferred')
      assert.equal(harness.slots.releaseCalls, 1)
    } finally {
      harness.cleanup()
    }
  })

  it('parks with slot-unavailable after the defer budget elapses', async () => {
    const harness = makeHarness({
      label: 'slot-budget',
      worker: committingWorker(),
      reviewer: passReviewer,
      slots: { reserve: 'full' },
      slotWaitMs: 30,
    })
    try {
      const outcome = await harness.run()
      expectBlocked(outcome, 'slot-unavailable')
      assert.ok(harness.slots.reserveCalls > 1, 'the attempt exhausted its budget polling')
      assert.equal(harness.runner.launches.length, 0)
    } finally {
      harness.cleanup()
    }
  })

  it('maps a slot registry failure to a run-scoped error without parking', async () => {
    const harness = makeHarness({
      label: 'slot-error',
      worker: committingWorker(),
      reviewer: passReviewer,
      slots: { reserve: 'fail' },
    })
    try {
      const outcome = await harness.run()
      expectError(outcome, 'slot-registry', 'run')
      assert.equal(harness.store.terminals.length, 0)
    } finally {
      harness.cleanup()
    }
  })

  it('maps a run-state persistence failure to a run-scoped error', async () => {
    const base = fakeStore()
    const failing = {
      ...base,
      async saveWorking(record: WorkAttemptRecord) {
        if (record.attempt.round >= 1) {
          return error({
            scope: 'run' as const,
            code: 'control-store' as const,
            reason: 'scripted persistence failure',
            sharedWrite: 'none' as const,
            evidence: [],
          })
        }
        return base.saveWorking(record)
      },
    }
    const harness = makeHarness({
      label: 'store-error',
      worker: committingWorker(),
      reviewer: passReviewer,
      store: failing,
    })
    try {
      const outcome = await harness.run()
      expectError(outcome, 'control-store', 'run')
      assert.equal(harness.store.terminals.length, 0)
    } finally {
      harness.cleanup()
    }
  })

  it('maps a slot release failure after a park to a run-scoped error that carries the outcome', async () => {
    const harness = makeHarness({
      label: 'release-error',
      worker: () => ({ discriminant: 'block', code: 'workspace-unusable', reason: 'broken' }),
      slots: { releaseFails: true },
    })
    try {
      const outcome = await harness.run()
      expectError(outcome, 'slot-registry', 'run')
      assert.ok(outcome.kind === 'error')
      assert.match(JSON.stringify(outcome.evidence), /worker-block/)
      assert.equal(harness.store.terminals.length, 1, 'the park was persisted before the release attempt')
    } finally {
      harness.cleanup()
    }
  })

  it('persists the round counter and launch intent before the process is created', async () => {
    const observed: Array<{ round: number; launchIntent: string[]; states: string[] }> = []
    const worker: WorkerScript = (launch, tools) => {
      const record = tools.latestRecord()
      assert.ok(record !== undefined, 'a record exists before launch')
      observed.push({
        round: record.attempt.round,
        launchIntent: record.processes
          .filter((group) => group.state === 'launch-intent')
          .map((group) => group.id),
        states: record.processes.map((group) => group.state),
      })
      return committingWorker()(launch, tools)
    }
    const harness = makeHarness({ label: 'persist-order', worker, reviewer: passReviewer })
    try {
      const outcome = await harness.run()
      assert.ok(outcome.kind === 'ok', JSON.stringify(outcome))
      assert.equal(observed.length, 1)
      assert.equal(observed[0]!.round, 1, 'the round was persisted before the worker launched')
      assert.deepEqual(observed[0]!.launchIntent, ['wa-1-worker-r1'])
      assert.ok(observed[0]!.states.every((state) => state === 'launch-intent'))

      // The persisted order shows the intent save preceding the launch.
      const intentSaveIndex = harness.events.indexOf('saveWorking:1:reserved')
      const launchIndex = harness.events.indexOf('launch:wa-1-worker-r1')
      assert.ok(intentSaveIndex !== -1 && launchIndex !== -1)
      assert.ok(intentSaveIndex < launchIndex)
    } finally {
      harness.cleanup()
    }
  })

  it('resumes from the persisted round without resetting the budget', async () => {
    const harness = makeHarness({
      label: 'resume-round-2',
      worker: committingWorker(),
      reviewer: passReviewer,
      maxWorkRounds: 3,
      setup: [{ argv: ['npm', 'ci'], timeoutMs: 60_000 }],
    })
    try {
      await preCreateWorkspace(harness)
      seedResume(harness, { round: 2, slot: 'reserved' })
      const outcome = await harness.run()
      assert.ok(outcome.kind === 'ok', JSON.stringify(outcome))
      assert.equal(harness.workerInputs.length, 1, 'only round 3 launched')
      assert.equal(harness.workerInputs[0]!.round, 3)
      assert.equal(harness.slots.reserveCalls, 0, 'the persisted reservation was reused')
      // No initial-setup rerun: only the candidate setup and the tests ran.
      assert.equal(harness.commands.requests.length, 2)
      assert.deepEqual(harness.commands.requests[0]!.argv, ['npm', 'ci'])
    } finally {
      harness.cleanup()
    }
  })

  it('reports exhausted rounds without launching when the budget is already spent', async () => {
    const harness = makeHarness({
      label: 'resume-exhausted',
      worker: committingWorker(),
      reviewer: passReviewer,
      maxWorkRounds: 3,
    })
    try {
      await preCreateWorkspace(harness)
      seedResume(harness, { round: 3, slot: 'reserved' })
      const outcome = await harness.run()
      expectBlocked(outcome, 'work-rounds-exhausted')
      assert.equal(harness.workerInputs.length, 0, 'no worker launched')
      assert.equal(harness.runner.launches.length, 0)
    } finally {
      harness.cleanup()
    }
  })

  it('refuses a persisted attempt whose Work input contradicts the request', async () => {
    const harness = makeHarness({
      label: 'spec-contradiction',
      worker: committingWorker(),
      reviewer: passReviewer,
    })
    try {
      await preCreateWorkspace(harness)
      seedResume(harness, { round: 1, slot: 'reserved' }, (input) => ({
        ...input,
        spec: { ...input.spec, ticketBody: 'A different specification entirely.' },
      }))
      const outcome = await harness.run()
      expectBlocked(outcome, 'spec-contradiction')
      assert.equal(harness.runner.launches.length, 0)
      assert.equal(harness.store.terminals.length, 0, 'nothing was parked or written')
      assert.equal(harness.slots.reserveCalls, 0)
      assert.equal(harness.slots.releaseCalls, 0)
    } finally {
      harness.cleanup()
    }
  })

  it('returns ticket-scoped error when the coordinator diff cannot be read', async () => {
    const git: GitCommandRunner = async (args, cwd) =>
      args[0] === 'diff'
        ? { ok: false, failure: 'git-failed', message: 'scripted diff failure' }
        : runGit(args, cwd)
    const harness = makeHarness({
      label: 'diff-failed',
      worker: committingWorker(),
      reviewer: passReviewer,
      git,
    })
    try {
      const outcome = await harness.run()
      expectError(outcome, 'diff-failed')
    } finally {
      harness.cleanup()
    }
  })
})

/** Resolve a ref to a stored OID (`sha1:<hex>`). */
function gitSha(root: string, ref: string): string {
  return `sha1:${execFileSync('git', ['-C', root, 'rev-parse', ref], { encoding: 'utf8' }).trim()}`
}
