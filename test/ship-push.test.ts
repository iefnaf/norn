/**
 * Ship push, remote verification, and the retry protocol
 * (design.md §11.3, §13.3 steps 1–2, ticket #11).
 *
 * The fake GitHub target is a real local bare remote: pushes, non-fast-
 * forward races, protected-branch declines, fetches, ancestry, and commit
 * shapes all run through real git plumbing. Every acceptance criterion of
 * the ticket is exercised end to end over the real §11.2 reconciliation, the
 * real Run-State-backed Ship Checkpoint store, and the real delivery facts:
 *
 * - the checkpoint (candidate + gate evidence + sealed Delivery Record +
 *   attempt count) precedes every push, and every outcome is classifiable
 *   from persisted state alone — crash-and-resume runs re-decide from the
 *   store and free remote probes;
 * - the attempt counter persists before each push call, survives recovery,
 *   and only actual pushes consume budget;
 * - budget exhaustion yields ticket-scoped `blocked(target-advanced)` or
 *   `blocked(push-retries-exhausted)` with `sharedWrite: 'none'`;
 * - persistent remote ambiguity yields a recoverable run-scoped error with
 *   `sharedWrite: 'unknown'`, never a guess;
 * - an extension arriving mid-Ship exercises the release-adopt-reacquire
 *   dance with the re-read of map and target;
 * - the target lock is held from the final target read through remote
 *   verification and released on every exit path.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { ok } from '../src/core/outcome.ts'
import { canonicalJsonDigest } from '../src/core/digest.ts'
import { encodePathSegment, targetLockPath } from '../src/config/paths.ts'
import { isLockHeld } from '../src/runstate/locks.ts'
import { classifyPushResult, gitCliPush } from '../src/adapters/git-repository.ts'
import type { GitFactsCommandResult } from '../src/adapters/git-repository.ts'
import { computeDeliveryId } from '../src/evidence/delivery.ts'
import { loadRunState, saveRunState } from '../src/runstate/run-state-store.ts'
import type { RunState } from '../src/runstate/types.ts'
import { runStateShipCheckpointStore, shipPush } from '../src/ship/push.ts'
import type { ShipPushOutcome } from '../src/ship/push.ts'
import type { ShipExtensionAdoption } from '../src/ship/reconcile.ts'

import {
  ACTOR_ID,
  CONFIG_REVISION,
  ENCODED_MAP,
  NORN_VERSION,
  SEALED_AT,
  advanceRemoteTarget,
  makePushHarness,
  protectBranch,
  pushGate,
  tempBareRemote,
} from './helpers/push-fixtures.ts'
import type { PushHarness } from './helpers/push-fixtures.ts'
import {
  RUN_ID,
  TICKET_ISSUE_ID,
  commandFailure,
  sealedChange,
  snapshotOf,
  ticket7,
} from './helpers/ship-fixtures.ts'
import { gitText } from './helpers/round-gate-fixtures.ts'

// ---------------------------------------------------------------------------
// The push seam classification (§11.3)
// ---------------------------------------------------------------------------

function pushFailure(exitCode: number | undefined, message: string): GitFactsCommandResult {
  return { ok: false, exitCode, message }
}

describe('the git push classifier', () => {
  it('classifies a clean exit as pushed', () => {
    assert.deepEqual(classifyPushResult({ ok: true, stdout: '' }), { kind: 'pushed' })
  })

  it('classifies a non-fast-forward rejection as target-advanced', () => {
    const message =
      'To /tmp/target.git\n ! [rejected]        abc123 -> main (non-fast-forward)\n' +
      'error: failed to push some refs to /tmp/target.git'
    assert.deepEqual(classifyPushResult(pushFailure(1, message)), {
      kind: 'target-advanced',
      message,
    })
  })

  it('classifies a fetch-first rejection as target-advanced', () => {
    const message = ' ! [rejected] abc -> main (fetch first)\nerror: failed to push some refs'
    assert.equal(classifyPushResult(pushFailure(1, message)).kind, 'target-advanced')
  })

  it('classifies protected-branch declines as rejected branch-policy', () => {
    const message =
      'remote: error: GH006: Protected branch update failed for refs/heads/main.\n' +
      'To /tmp/target.git\n ! [remote rejected] main -> main (pre-receive hook declined)\n' +
      'error: failed to push some refs to /tmp/target.git'
    const outcome = classifyPushResult(pushFailure(1, message))
    assert.equal(outcome.kind, 'rejected')
    if (outcome.kind === 'rejected') assert.equal(outcome.detail, 'branch-policy')
  })

  it('classifies permission failures as rejected authentication', () => {
    const message =
      'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'
    const outcome = classifyPushResult(pushFailure(128, message))
    assert.equal(outcome.kind, 'rejected')
    if (outcome.kind === 'rejected') assert.equal(outcome.detail, 'authentication')
  })

  it('classifies a missing exit status as unknown', () => {
    assert.equal(classifyPushResult(pushFailure(undefined, 'the git CLI is not installed')).kind, 'unknown')
  })

  it('never guesses an unrecognized failure', () => {
    assert.equal(classifyPushResult(pushFailure(1, 'error: something entirely novel')).kind, 'unknown')
  })
})

describe('gitCliPush against a real bare remote', () => {
  it('pushes without force and reports the optimistic-concurrency loss', async () => {
    const remote = tempBareRemote('push-ok')
    const scratch = mkdtempSync(join(tmpdir(), 'norn-push-cli-'))
    const clone = join(scratch, 'clone')
    try {
      execFileSync('git', ['clone', '--quiet', remote.path, clone])
      execFileSync('git', ['-C', clone, 'config', 'user.email', 'norn@example.invalid'])
      execFileSync('git', ['-C', clone, 'config', 'user.name', 'Norn'])
      writeFileSync(join(clone, 'f.txt'), 'x\n')
      execFileSync('git', ['-C', clone, 'add', '.'])
      execFileSync('git', ['-C', clone, 'commit', '--quiet', '--no-gpg-sign', '-m', 'one'])
      const sha = gitText(clone, ['rev-parse', 'HEAD'])
      const push = gitCliPush()
      assert.deepEqual(await push({ root: clone, remote: 'origin', branch: 'main', sha }), {
        kind: 'pushed',
      })
      assert.equal(gitText(remote.path, ['rev-parse', 'main']), sha)

      // Advance the remote, then push a divergent commit: the non-force push
      // is rejected as non-fast-forward — the §11.3 target-advanced outcome.
      execFileSync('git', ['-C', clone, 'commit', '--quiet', '--allow-empty', '--no-gpg-sign', '-m', 'two'])
      const advancedTip = gitText(clone, ['rev-parse', 'HEAD'])
      execFileSync('git', ['-C', clone, 'push', '--quiet', 'origin', 'main'])
      execFileSync('git', ['-C', clone, 'reset', '--hard', sha])
      execFileSync('git', ['-C', clone, 'commit', '--quiet', '--allow-empty', '--no-gpg-sign', '-m', 'divergent'])
      const divergent = gitText(clone, ['rev-parse', 'HEAD'])
      const raced = await push({ root: clone, remote: 'origin', branch: 'main', sha: divergent })
      assert.equal(raced.kind, 'target-advanced')
      // The rejected push left the remote at its advanced tip.
      assert.equal(gitText(remote.path, ['rev-parse', 'main']), advancedTip)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
      remote.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// The Ship Checkpoint store (§13.1, §13.3)
// ---------------------------------------------------------------------------

describe('runStateShipCheckpointStore', () => {
  async function storeHarness(): Promise<{ harness: PushHarness; store: ReturnType<typeof runStateShipCheckpointStore> }> {
    const harness = await makePushHarness({ label: 'store' })
    const store = runStateShipCheckpointStore({
      repositoryHome: harness.repositoryHome,
      encodedMapIssueId: ENCODED_MAP,
      ticketIssueId: TICKET_ISSUE_ID,
    })
    return { harness, store }
  }

  const OID = (digit: string): string => `sha1:${digit.repeat(40)}`

  /** A sealed §14 record whose target matches the checkpoint fixture below. */
  const delivery = (baseSha: string, integratedSha: string, treeOid: string) => {
    const mapRevision = `sha256:${'a'.repeat(64)}`
    const ticketRevision = `sha256:${'b'.repeat(64)}`
    const tests = [
      {
        phase: 'work' as const,
        testIndex: 0,
        argv: ['npm', 'test'],
        timeoutMs: 60_000,
        baseSha,
        treeOid,
        exitCode: 0 as const,
        outputDigest: canonicalJsonDigest({ fixture: 'store-tests' } as never),
      },
    ]
    const review = {
      phase: 'work' as const,
      provider: 'provider-b',
      model: 'provider-b/model-y',
      family: 'provider-b',
      thinking: 'high',
      verdict: 'pass' as const,
      mapRevision,
      ticketRevision,
      baseSha,
      treeOid,
      testEvidenceDigest: canonicalJsonDigest(tests as never),
    }
    const record = {
      schema: 'norn-delivery:v1' as const,
      run: { id: RUN_ID, configRevision: CONFIG_REVISION, nornVersion: NORN_VERSION },
      gate: pushGate(),
      map: { issueId: 'I_map', revision: mapRevision },
      ticket: { issueId: TICKET_ISSUE_ID, revision: ticketRevision },
      target: { repositoryId: 'R_kgDOMAP', branch: 'main', baseSha, integratedSha, treeOid },
      review,
      tests,
      actorId: ACTOR_ID,
      recordedAt: SEALED_AT,
    }
    return { ...record, deliveryId: computeDeliveryId(record) }
  }

  /**
   * One prepare input. The default reuses Work evidence (work-phase review),
   * so its base and tree must equal the sealed change's (§11.2) — exactly the
   * integrity rule the Run State store enforces.
   */
  const prepareInput = (
    harness: PushHarness,
    overrides: Partial<Parameters<ReturnType<typeof runStateShipCheckpointStore>['prepare']>[0]> = {},
  ) => {
    const baseSha = overrides.baseSha ?? harness.change.baseSha
    const integratedSha = overrides.integratedSha ?? OID('2')
    const treeOid = overrides.treeOid ?? harness.change.candidateTreeOid
    const record = delivery(baseSha, integratedSha, treeOid)
    return {
      wave: 1,
      change: harness.change,
      zeroDelta: false,
      baseSha,
      integratedSha,
      treeOid,
      tests: record.tests,
      review: record.review,
      delivery: record,
      ...overrides,
    }
  }

  it('loads undefined when no shipping checkpoint exists', async () => {
    const { harness, store } = await storeHarness()
    try {
      const loaded = await store.load()
      assert.equal(loaded.kind, 'ok')
      assert.equal(loaded.value, undefined)
    } finally {
      harness.cleanup()
    }
  })

  it('prepares the shipping checkpoint atomically from a shippable ticket', async () => {
    const { harness, store } = await storeHarness()
    try {
      const prepared = await store.prepare(prepareInput(harness))
      assert.equal(prepared.kind, 'ok', JSON.stringify(prepared))
      if (prepared.kind !== 'ok') return
      assert.equal(prepared.value.stage, 'prepared')
      assert.equal(prepared.value.pushAttempts, 0)

      const loaded = await store.load()
      assert.equal(loaded.kind, 'ok')
      if (loaded.kind !== 'ok') return
      assert.equal(loaded.value?.checkpoint.stage, 'prepared')
      assert.equal(loaded.value?.wave, 1)
      // The sealed Delivery Record persists verbatim with a recomputable ID.
      assert.equal(computeDeliveryId(stripId(loaded.value!.checkpoint.delivery)), loaded.value!.checkpoint.delivery.deliveryId)
    } finally {
      harness.cleanup()
    }
  })

  it('replaces the prepared candidate while carrying the attempt counter forward', async () => {
    const { harness, store } = await storeHarness()
    try {
      assert.equal((await store.prepare(prepareInput(harness))).kind, 'ok')
      assert.equal((await store.incrementPushAttempts()).kind === 'ok', true)
      const replacement = await store.prepare(
        prepareInput(harness, { integratedSha: OID('8') }),
      )
      assert.equal(replacement.kind, 'ok')
      if (replacement.kind !== 'ok') return
      assert.equal(replacement.value.pushAttempts, 1)
    } finally {
      harness.cleanup()
    }
  })

  it('increments the persisted counter before each push and never resets', async () => {
    const { harness, store } = await storeHarness()
    try {
      assert.equal((await store.prepare(prepareInput(harness))).kind, 'ok')
      for (const expected of [1, 2, 3]) {
        const outcome = await store.incrementPushAttempts()
        assert.equal(outcome.kind, 'ok')
        if (outcome.kind === 'ok') assert.equal(outcome.value, expected)
        const loaded = await store.load()
        if (loaded.kind === 'ok') assert.equal(loaded.value?.checkpoint.pushAttempts, expected)
      }
    } finally {
      harness.cleanup()
    }
  })

  it('refuses to count attempts without a prepared checkpoint', async () => {
    const { harness, store } = await storeHarness()
    try {
      const outcome = await store.incrementPushAttempts()
      assert.equal(outcome.kind, 'error')
      if (outcome.kind === 'error') assert.equal(outcome.code, 'state-integrity')
    } finally {
      harness.cleanup()
    }
  })

  it('advances the stage forward only', async () => {
    const { harness, store } = await storeHarness()
    try {
      assert.equal((await store.prepare(prepareInput(harness))).kind, 'ok')
      const marked = await store.markStage('push-verified')
      assert.equal(marked.kind, 'ok')
      if (marked.kind === 'ok') assert.equal(marked.value.stage, 'push-verified')
      const again = await store.markStage('push-verified')
      assert.equal(again.kind, 'ok')
      const regress = await store.prepare(prepareInput(harness))
      assert.equal(regress.kind, 'error')
      if (regress.kind === 'error') assert.equal(regress.code, 'state-integrity')
    } finally {
      harness.cleanup()
    }
  })
})

function stripId<T extends { deliveryId: string }>(record: T): Omit<T, 'deliveryId'> {
  const { deliveryId: _omit, ...rest } = record
  return rest
}

// ---------------------------------------------------------------------------
// The happy path: pushed, verified, checkpointed (§11.3)
// ---------------------------------------------------------------------------

describe('shipPush: pushed → verification', () => {
  it('checkpoints before the push, verifies the exact remote shape, and releases the lock', async () => {
    const harness = await makePushHarness({ label: 'happy' })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind !== 'ok') return
      const value = outcome.value

      // The exact integration shape is present on the remote target.
      assert.equal(harness.remoteMainSha(), value.checkpoint.integratedSha)
      assert.equal(value.checkpoint.stage, 'push-verified')
      assert.equal(value.checkpoint.pushAttempts, 1)
      assert.equal(value.pushes, 1)
      assert.equal(value.candidate.zeroDelta, false)
      const [treeLine = '', parentLine = ''] = gitText(harness.remote.path, [
        'show',
        '-s',
        '--format=%T%n%P',
        value.checkpoint.integratedSha.replace('sha1:', ''),
      ]).split('\n')
      assert.equal(`sha1:${treeLine}`, value.checkpoint.treeOid)
      assert.equal(`sha1:${parentLine}`, value.checkpoint.baseSha)
      assert.equal(value.remoteTargetSha, harness.remoteMainSha())

      // The checkpoint preceded the push: the store was already stage
      // 'prepared' with the sealed record and the incremented counter when
      // the push seam observed it (§11.3, §13.3).
      assert.equal(harness.pushCalls.length, 1)
      const observed = harness.pushCalls[0]!.persistedAtCall
      assert.notEqual(observed, undefined)
      assert.equal(observed!.stage, 'prepared')
      assert.equal(observed!.pushAttempts, 1)
      assert.equal(computeDeliveryId(stripId(observed!.delivery)), observed!.delivery.deliveryId)

      // The persisted checkpoint agrees with the delivery record (§13.1).
      const persisted = harness.persisted()
      assert.equal(persisted?.checkpoint.stage, 'push-verified')
      assert.equal(persisted?.checkpoint.delivery.deliveryId, value.checkpoint.delivery.deliveryId)
      assert.equal(persisted?.checkpoint.delivery.actorId, ACTOR_ID)
      assert.equal(persisted?.checkpoint.delivery.recordedAt, SEALED_AT)
      assert.deepEqual(persisted?.checkpoint.delivery.gate, pushGate())

      // Probes were free: several fetches ran, exactly one push consumed budget.
      assert.ok(harness.counts.factsFetches() >= 4)
      assert.equal(persisted?.checkpoint.pushAttempts, 1)

      // The lock was held across the push and released after verification.
      assert.deepEqual(harness.lock.events, ['acquire', 'release'])
    } finally {
      harness.cleanup()
    }
  })

  it('holds the OS-backed target lock from the target read through verification', async () => {
    const harness = await makePushHarness({ label: 'os-lock', osLock: true })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      assert.equal(harness.pushCalls.length, 1)
      // Observed while the push was in flight.
      assert.equal(harness.pushCalls[0]!.osLockHeld, true)
      // Released after shipPush returned.
      assert.equal(await isLockHeld(targetLockPath(harness.repositoryHome, 'main')), false)
    } finally {
      harness.cleanup()
    }
  })

  it('a zero-delta finale pushes nothing and consumes no attempt', async () => {
    const harness = await makePushHarness({ label: 'zero-delta', zeroDelta: true })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind !== 'ok') return
      assert.equal(harness.pushCalls.length, 0)
      assert.equal(outcome.value.checkpoint.zeroDelta, true)
      assert.equal(outcome.value.checkpoint.integratedSha, outcome.value.checkpoint.baseSha)
      assert.equal(outcome.value.checkpoint.integratedSha, harness.remoteMainSha())
      assert.equal(outcome.value.checkpoint.pushAttempts, 0)
      assert.equal(outcome.value.checkpoint.stage, 'push-verified')
      assert.equal(outcome.value.pushes, 0)
    } finally {
      harness.cleanup()
    }
  })

  it('a lock acquisition failure is a run-scoped error with no push', async () => {
    const harness = await makePushHarness({
      label: 'lock-fail',
      lockFailFirstAcquire: 'scripted: another coordinator holds the target lock',
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'error')
      if (outcome.kind === 'error') {
        assert.equal(outcome.code, 'lock-failed')
        assert.equal(outcome.scope, 'run')
        assert.equal(outcome.sharedWrite, 'none')
      }
      assert.equal(harness.pushCalls.length, 0)
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// target-advanced: reconciliation and fresh gates while budget remains (§11.3)
// ---------------------------------------------------------------------------

describe('shipPush: target-advanced', () => {
  it('re-reconciles with fresh gates and pushes the new integration commit', async () => {
    const harness = await makePushHarness({ label: 'advanced', maxPushRetries: 1 })
    try {
      const outcome = await harness.run({
        push: async (call, real) => {
          if (call === 0) {
            // A competing ship lands between our gates and our push.
            advanceRemoteTarget(harness.remote, `competing-${call}.txt`)
          }
          return real()
        },
      })
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind !== 'ok') return

      // Two pushes were attempted; the second landed after fresh gates.
      assert.equal(outcome.value.pushes, 2)
      assert.equal(outcome.value.checkpoint.pushAttempts, 2)
      assert.equal(harness.remoteMainSha(), outcome.value.checkpoint.integratedSha)

      // The fresh gates ran against the advanced target and produced
      // ship-phase evidence; the checkpoint was replaced with the counter
      // carried forward (§11.2, §11.3).
      assert.equal(outcome.value.checkpoint.review.phase, 'ship')
      assert.ok(outcome.value.checkpoint.baseSha !== harness.change.baseSha)
      assert.equal(outcome.value.checkpoint.tests[0]!.phase, 'ship')
      assert.equal(harness.counts.reviewerLaunches(), 1)

      // The remote shape: exactly one parent equal to the advanced base.
      const [treeLine = '', parentLine = ''] = gitText(harness.remote.path, [
        'show',
        '-s',
        '--format=%T%n%P',
        outcome.value.checkpoint.integratedSha.replace('sha1:', ''),
      ]).split('\n')
      assert.equal(`sha1:${treeLine}`, outcome.value.checkpoint.treeOid)
      assert.equal(`sha1:${parentLine}`, outcome.value.checkpoint.baseSha)
    } finally {
      harness.cleanup()
    }
  })

  it('budget exhaustion with a moving target parks the ticket as target-advanced', async () => {
    const harness = await makePushHarness({ label: 'advanced-exhausted', maxPushRetries: 1 })
    try {
      const outcome = await harness.run({
        push: async (call, real) => {
          advanceRemoteTarget(harness.remote, `competing-${call}.txt`)
          return real()
        },
      })
      assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
      if (outcome.kind !== 'blocked') return
      assert.equal(outcome.code, 'target-advanced')
      assert.equal(outcome.scope, 'ticket')
      assert.equal(outcome.sharedWrite, 'none')

      // Both pushes consumed budget; the last candidate never landed.
      assert.equal(harness.pushCalls.length, 2)
      assert.equal(harness.persisted()?.checkpoint.pushAttempts, 2)
      assert.notEqual(harness.remoteMainSha(), harness.persisted()?.checkpoint.integratedSha)
      // The lock was released on the blocked exit.
      assert.equal(harness.lock.isHeldNow(), false)
    } finally {
      harness.cleanup()
    }
  })

  it('budget exhaustion without target movement parks as push-retries-exhausted', async () => {
    const harness = await makePushHarness({ label: 'absent-exhausted', maxPushRetries: 1 })
    try {
      const outcome = await harness.run({
        push: async () => ({
          kind: 'unknown' as const,
          message: 'scripted unknown outcome; the remote is never reached',
        }),
      })
      assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
      if (outcome.kind !== 'blocked') return
      assert.equal(outcome.code, 'push-retries-exhausted')
      assert.equal(outcome.scope, 'ticket')
      assert.equal(outcome.sharedWrite, 'none')
      assert.equal(harness.pushCalls.length, 2)
      assert.equal(harness.persisted()?.checkpoint.pushAttempts, 2)
    } finally {
      harness.cleanup()
    }
  })

  it('a resumed exhausted checkpoint stays blocked without another push (§13.3)', async () => {
    const harness = await makePushHarness({ label: 'resume-exhausted', maxPushRetries: 1 })
    try {
      const first = await harness.run({
        push: async () => ({ kind: 'unknown' as const, message: 'scripted unknown' }),
      })
      assert.equal(first.kind, 'blocked')
      const pushesAfterFirst = harness.pushCalls.length

      const second = await harness.run()
      assert.equal(second.kind, 'blocked')
      if (second.kind !== 'blocked') return
      assert.equal(second.code, 'push-retries-exhausted')
      // Free probes classified the state; no budget was consumed.
      assert.equal(harness.pushCalls.length, pushesAfterFirst)
      assert.equal(harness.persisted()?.checkpoint.pushAttempts, 2)
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// rejected: authentication or branch policy (§11.3, §8)
// ---------------------------------------------------------------------------

describe('shipPush: rejected', () => {
  it('a protected branch returns run-scoped blocked(push-rejected) with sharedWrite none', async () => {
    const harness = await makePushHarness({ label: 'rejected' })
    protectBranch(harness.remote)
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
      if (outcome.kind !== 'blocked') return
      assert.equal(outcome.code, 'push-rejected')
      assert.equal(outcome.scope, 'run')
      assert.equal(outcome.sharedWrite, 'none')
      assert.equal(harness.pushCalls.length, 1)
      assert.equal(harness.lock.isHeldNow(), false)
      // The rejected push still consumed its attempt (§11.3).
      assert.equal(harness.persisted()?.checkpoint.pushAttempts, 1)
    } finally {
      harness.cleanup()
    }
  })

  it('a rejection after an earlier shipment carries sharedWrite confirmed', async () => {
    const harness = await makePushHarness({ label: 'rejected-confirmed', alreadyShipped: true })
    protectBranch(harness.remote)
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked')
      if (outcome.kind !== 'blocked') return
      assert.equal(outcome.sharedWrite, 'confirmed')
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// unknown: bounded stable fetches decide, never a guess (§11.3)
// ---------------------------------------------------------------------------

describe('shipPush: unknown push outcomes', () => {
  it('proven presence continues to verification without another push', async () => {
    const harness = await makePushHarness({ label: 'unknown-present', maxPushRetries: 1 })
    try {
      const outcome = await harness.run({
        push: async (call, real) => {
          // The push lands, but the process ambiguity reports unknown.
          const landed = await real()
          return landed.kind === 'pushed'
            ? { kind: 'unknown' as const, message: 'scripted: network dropped after the write' }
            : landed
        },
      })
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind !== 'ok') return
      assert.equal(outcome.value.checkpoint.stage, 'push-verified')
      assert.equal(outcome.value.checkpoint.pushAttempts, 1)
      assert.equal(outcome.value.pushes, 1)
      assert.equal(harness.remoteMainSha(), outcome.value.checkpoint.integratedSha)
    } finally {
      harness.cleanup()
    }
  })

  it('proven absence follows the remaining budget and pushes again', async () => {
    const harness = await makePushHarness({ label: 'unknown-absent', maxPushRetries: 1 })
    try {
      const outcome = await harness.run({
        push: async (call, real) =>
          call === 0
            ? { kind: 'unknown' as const, message: 'scripted: the push never left the machine' }
            : real(),
      })
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind !== 'ok') return
      assert.equal(outcome.value.checkpoint.pushAttempts, 2)
      assert.equal(outcome.value.pushes, 2)
      assert.equal(harness.remoteMainSha(), outcome.value.checkpoint.integratedSha)
      // The second push reused the same recorded integration commit: the
      // absence was proven, so nothing was re-guessed (§13.3).
      assert.equal(
        harness.pushCalls[0]!.request.sha,
        harness.pushCalls[1]!.request.sha,
      )
    } finally {
      harness.cleanup()
    }
  })

  it('persistent ambiguity returns a recoverable run-scoped error with sharedWrite unknown', async () => {
    const harness = await makePushHarness({ label: 'ambiguous' })
    try {
      const outcome = await harness.run({
        push: async () => ({ kind: 'unknown' as const, message: 'scripted unknown' }),
        failFetchAt: new Set([3, 4, 5]),
      })
      assert.equal(outcome.kind, 'error', JSON.stringify(outcome))
      if (outcome.kind === 'error') {
        assert.equal(outcome.code, 'push-unknown')
        assert.equal(outcome.scope, 'run')
        assert.equal(outcome.sharedWrite, 'unknown')
      }
      // The checkpoint persists the consumed attempt: recovery never resets it.
      assert.equal(harness.persisted()?.checkpoint.stage, 'prepared')
      assert.equal(harness.persisted()?.checkpoint.pushAttempts, 1)
      assert.equal(harness.lock.isHeldNow(), false)
    } finally {
      harness.cleanup()
    }
  })

  it('a flapping remote state is ambiguous after bounded stable reads', async () => {
    const harness = await makePushHarness({ label: 'flapping', maxPushRetries: 0 })
    try {
      // Fetches alternate between succeeding and failing, so no two adjacent
      // probe cycles ever agree.
      const outcome = await harness.run({
        push: async () => ({ kind: 'unknown' as const, message: 'scripted unknown' }),
        failFetchAt: new Set([3, 5]),
      })
      assert.equal(outcome.kind, 'error')
      if (outcome.kind === 'error') {
        assert.equal(outcome.code, 'push-unknown')
        assert.equal(outcome.sharedWrite, 'unknown')
      }
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Recovery: kill-and-resume over the same store (§13.3)
// ---------------------------------------------------------------------------

describe('shipPush: recovery', () => {
  it('a killed coordinator resumes with the persisted counter, never reset', async () => {
    const harness = await makePushHarness({ label: 'kill-resume', maxPushRetries: 1 })
    try {
      // Invocation A dies mid-protocol: the push reported unknown and the
      // probes stayed ambiguous — a recoverable error (attempts = 1).
      const first = await harness.run({
        push: async () => ({ kind: 'unknown' as const, message: 'scripted unknown (crash)' }),
        failFetchAt: new Set([3, 4, 5]),
      })
      assert.equal(first.kind, 'error')
      assert.equal(harness.persisted()?.checkpoint.pushAttempts, 1)
      assert.equal(harness.pushCalls.length, 1)

      // Invocation B — a fresh orchestration over the same store — probes
      // (free), proves absence, revalidates, and pushes. The counter resumes
      // at 1 and reaches 2: recovery did not reset it (§11.3, §13.3).
      const second = await harness.run()
      assert.equal(second.kind, 'ok', JSON.stringify(second))
      if (second.kind !== 'ok') return
      assert.equal(second.value.checkpoint.stage, 'push-verified')
      assert.equal(harness.pushCalls.length, 2)
      assert.equal(harness.pushCalls[1]!.persistedAtCall?.pushAttempts, 2)
      assert.equal(second.value.checkpoint.pushAttempts, 2)
      assert.equal(second.value.pushes, 1)
      assert.equal(harness.remoteMainSha(), second.value.checkpoint.integratedSha)
    } finally {
      harness.cleanup()
    }
  })

  it('a crash after remote verification resumes from the probe without pushing again', async () => {
    const harness = await makePushHarness({ label: 'resume-verified' })
    try {
      // Invocation A: the push landed and the probe verified it, but the
      // local stage update failed — a crash between write and persist. The
      // error follows a confirmed shared write, so it is recoverable (§13.2).
      const first = await harness.run({ markStageFails: true })
      assert.equal(first.kind, 'error', JSON.stringify(first))
      if (first.kind === 'error') {
        assert.equal(first.sharedWrite, 'confirmed')
        assert.equal(first.scope, 'run')
      }
      assert.equal(harness.persisted()?.checkpoint.stage, 'prepared')
      assert.equal(harness.remoteMainSha(), harness.persisted()?.checkpoint.integratedSha)

      // Invocation B: the free probe proves the exact integration shape and
      // completes the stage transition; no second push occurs.
      const second = await harness.run()
      assert.equal(second.kind, 'ok', JSON.stringify(second))
      if (second.kind !== 'ok') return
      assert.equal(second.value.checkpoint.stage, 'push-verified')
      assert.equal(second.value.pushes, 0)
      assert.equal(harness.pushCalls.length, 1)
      assert.equal(second.value.checkpoint.pushAttempts, 1)
    } finally {
      harness.cleanup()
    }
  })

  it('a checkpoint past the push stage resumes from the probe untouched', async () => {
    const harness = await makePushHarness({ label: 'resume-stage' })
    try {
      const first = await harness.run()
      assert.equal(first.kind, 'ok')
      harness.mutatePersisted((checkpoint) => ({ ...checkpoint, stage: 'delivery-recorded' }))
      const second = await harness.run()
      assert.equal(second.kind, 'ok', JSON.stringify(second))
      if (second.kind !== 'ok') return
      assert.equal(second.value.checkpoint.stage, 'delivery-recorded')
      assert.equal(second.value.pushes, 0)
    } finally {
      harness.cleanup()
    }
  })

  it('a later persisted stage contradicted by an absent delivery is a state-integrity error', async () => {
    const harness = await makePushHarness({ label: 'resume-contradiction' })
    try {
      const first = await harness.run()
      assert.equal(first.kind, 'ok')
      // Rewind the remote so the recorded delivery is provably absent.
      const base = harness.change.baseSha.replace('sha1:', '')
      execFileSync('git', ['-C', harness.remote.path, 'update-ref', 'refs/heads/main', base])
      harness.mutatePersisted((checkpoint) => ({ ...checkpoint, stage: 'delivery-recorded' }))
      const second = await harness.run()
      assert.equal(second.kind, 'error', JSON.stringify(second))
      if (second.kind !== 'error') return
      assert.equal(second.code, 'state-integrity')
      assert.equal(second.scope, 'run')
      assert.equal(second.sharedWrite, 'confirmed')
    } finally {
      harness.cleanup()
    }
  })

  it('a persisted checkpoint binding a different change refuses with state-integrity', async () => {
    const harness = await makePushHarness({ label: 'resume-mismatch', maxPushRetries: 1 })
    try {
      const first = await harness.run({
        push: async () => ({ kind: 'unknown' as const, message: 'scripted unknown' }),
      })
      assert.equal(first.kind, 'blocked') // budget 2 exhausted via two unknown/absent pushes
      assert.notEqual(harness.persisted(), undefined)

      // Surgery: the store now binds a different shippable change.
      const different = sealedChange({
        mapRevision: harness.acceptedMap.mapRevision,
        ticketRevision: harness.change.ticketRevision,
        baseSha: harness.change.baseSha,
        candidateCommit: `sha1:${'7'.repeat(40)}`,
        candidateTreeOid: harness.change.candidateTreeOid,
        workspace: harness.change.workspace,
      })
      const loaded = loadRunState(harness.repositoryHome, ENCODED_MAP)
      if (loaded.kind !== 'ok' || loaded.value === undefined) throw new Error('no state')
      const state: RunState = loaded.value
      const ticket = state.tickets[TICKET_ISSUE_ID]!
      if (ticket.phase !== 'shipping') throw new Error('not shipping')
      const mutated: RunState = {
        ...state,
        tickets: {
          ...state.tickets,
          [TICKET_ISSUE_ID]: {
            ...ticket,
            change: different,
            checkpoint: { ...ticket.checkpoint },
          },
        },
      }
      assert.equal(saveRunState(harness.repositoryHome, ENCODED_MAP, mutated).kind, 'ok')

      const second = await harness.run()
      assert.equal(second.kind, 'error')
      if (second.kind !== 'error') return
      assert.equal(second.code, 'state-integrity')
      assert.equal(harness.pushCalls.length, 2) // no new push in the second run
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// The extension dance and changed inputs under the lock (§11.3, §16)
// ---------------------------------------------------------------------------

describe('shipPush: Compatible Map Extensions mid-Ship', () => {
  it('releases the lock, adopts under the control lock, reacquires, and re-reads map and target', async () => {
    const harness = await makePushHarness({ label: 'dance' })
    try {
      const outcome = await harness.run({
        mapScript: (read, snapshot) => (read === 0 ? harness.extendedMap : harness.extendedMap),
        adopt: (extension, lockHeld) => {
          // §16: adoption happens only with the target lock released.
          harness.events.push(`adopt-observes-lock-held:${lockHeld()}`)
          return undefined
        },
      })
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind !== 'ok') return

      // The dance: release before adoption, reacquire after, then the map
      // and target were re-read (fresh readMap and fetch calls follow).
      assert.ok(harness.events.includes('adopt-observes-lock-held:false'))
      const events = harness.events
      const acquireAt = events.indexOf('lock:acquire')
      const releaseAt = events.indexOf('lock:release')
      const adoptAt = events.indexOf('adopt-begin')
      const adoptEndAt = events.indexOf('adopt-end')
      const reacquireAt = events.indexOf('lock:acquire', releaseAt + 1)
      assert.ok(acquireAt !== -1 && releaseAt !== -1 && acquireAt < releaseAt, events.join(','))
      assert.ok(adoptAt !== -1 && releaseAt < adoptAt && adoptAt < adoptEndAt, events.join(','))
      assert.ok(reacquireAt !== -1 && reacquireAt > adoptEndAt, events.join(','))
      // A map and target re-read follow the reacquire before the push.
      const pushAt = events.indexOf('push:0')
      assert.ok(pushAt > reacquireAt)
      assert.ok(events.slice(reacquireAt, pushAt).some((e) => e.startsWith('readMap:')))
      assert.ok(events.slice(reacquireAt, pushAt).some((e) => e.startsWith('fetch:')))

      // The extension is persisted in the lineage and reported in the value.
      const loaded = loadRunState(harness.repositoryHome, ENCODED_MAP)
      if (loaded.kind === 'ok' && loaded.value !== undefined) {
        assert.equal(loaded.value.acceptedMapRevisions.length, 2)
      }
      assert.equal(outcome.value.adoptedExtensions.length, 1)
      assert.deepEqual(outcome.value.adoptedExtensions[0]!.addedTicketIssueIds, ['I_C'])
      assert.equal(harness.pushCalls.length, 1)
    } finally {
      harness.cleanup()
    }
  })

  it('an incompatible change on the pre-push re-read blocks before any push', async () => {
    const incompatibleMap = snapshotOf([ticket7({ body: 'edited by the operator mid-ship' })])
    const harness = await makePushHarness({
      label: 'incompatible',
      mapScript: (read, snapshot) => (read >= 2 ? incompatibleMap : snapshot()),
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
      if (outcome.kind !== 'blocked') return
      assert.equal(outcome.code, 'changed-input')
      assert.equal(outcome.scope, 'run')
      assert.equal(outcome.sharedWrite, 'none')
      assert.equal(harness.pushCalls.length, 0)
      assert.equal(harness.persisted(), undefined)
      assert.equal(harness.lock.isHeldNow(), false)
    } finally {
      harness.cleanup()
    }
  })

  it('an incompatible change after an earlier shipment carries sharedWrite confirmed', async () => {
    const incompatibleMap = snapshotOf([ticket7({ body: 'edited again' })])
    const harness = await makePushHarness({
      label: 'incompatible-confirmed',
      alreadyShipped: true,
      mapScript: (read, snapshot) => (read >= 2 ? incompatibleMap : snapshot()),
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked')
      if (outcome.kind !== 'blocked') return
      assert.equal(outcome.code, 'changed-input')
      assert.equal(outcome.sharedWrite, 'confirmed')
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Reconciliation outcomes pass through unchanged (§11.2 via §11.3)
// ---------------------------------------------------------------------------

describe('shipPush: reconciliation outcomes pass through', () => {
  it('a replay conflict returns ticket-scoped blocked(integration-conflict) with no push', async () => {
    const harness = await makePushHarness({
      label: 'conflict',
      workerFiles: [{ name: 'README.md', content: '# worker rewrote everything\n' }],
      targetFiles: [{ name: 'README.md', content: '# the target rewrote everything first\n' }],
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
      if (outcome.kind !== 'blocked') return
      assert.equal(outcome.code, 'integration-conflict')
      assert.equal(outcome.scope, 'ticket')
      assert.equal(outcome.sharedWrite, 'none')
      assert.equal(harness.pushCalls.length, 0)
      assert.equal(harness.lock.isHeldNow(), false)
    } finally {
      harness.cleanup()
    }
  })

  it('a failed fresh gate under the lock stops before any push', async () => {
    const harness = await makePushHarness({
      label: 'gate-failed',
      targetFiles: [{ name: 'moved-on.txt', content: 'the target advanced\n' }],
      commandScript: (argv) => (argv[0] === 'npm' ? commandFailure('integration tests failed') : undefined),
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
      if (outcome.kind !== 'blocked') return
      assert.equal(outcome.code, 'ship-gate-failed')
      assert.equal(outcome.scope, 'ticket')
      assert.equal(outcome.sharedWrite, 'none')
      assert.equal(harness.pushCalls.length, 0)
      assert.equal(harness.persisted(), undefined)
    } finally {
      harness.cleanup()
    }
  })
})
