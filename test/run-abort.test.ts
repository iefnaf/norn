/**
 * Abort and interrupt handling — the ticket #16 suite (design.md §2.3, §2.5,
 * §13.2, §13.3–§13.4).
 *
 * Every acceptance criterion is exercised over the five deterministic seams
 * of the ticket #13/#15 harness: a real git repository with a bare remote
 * (pushes, fetches, and ancestry are real), the fake scriptable gateway
 * (unknown-write scripting), the fake agents (scripted settlement
 * behavior), and the real Run State store, map lock, and Work-slot registry
 * under a temporary Norn home.
 *
 * Mid-Ship states are produced exactly as recovery tests produce them — a
 * seam dies over real persisted state — and `/norn abort` then runs over
 * that state. The handled coordinator interrupt (an `AbortSignal` fired
 * mid-Ship) is compared world-for-world against `/norn abort` over the same
 * mid-Ship state to prove both entry points converge on the identical
 * protocol outcome: the same persisted `aborted` decision, the same ticket
 * checkpoints, and the same untouched remote evidence.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { GitRemote, GitRepositoryAdapter, GitDeliveryFactsAdapter } from '../src/adapters/git-repository.ts'
import type { GitPushSeam } from '../src/adapters/git-repository.ts'
import type { VisibleAgentRunner } from '../src/agents/runner.ts'
import type { CommandExecutionRequest } from '../src/work/command-runner.ts'
import { abortMap, abortRunSummary } from '../src/run/abort.ts'
import type { AbortDeps, AbortInteraction, ConfirmedWrite } from '../src/run/abort.ts'
import { runMap } from '../src/run/lifecycle.ts'
import type { RunLifecycleDeps, RunMapOutcome } from '../src/run/lifecycle.ts'
import { settlementProbe } from '../src/run/recovery.ts'
import { saveRunState } from '../src/runstate/run-state-store.ts'
import type { ProcessGroupCheckpoint, RunState } from '../src/runstate/types.ts'
import { acquireMapLock } from '../src/runstate/locks.ts'
import {
  readWorkSlotRegistry,
  releaseWorkSlot,
  reserveWorkSlot,
} from '../src/runstate/slot-registry.ts'
import {
  ENCODED_MAP,
  MAP_NUMBER,
  MAP_URL,
  REPOSITORY_ID,
  craftCompletionCheckpoint,
  makeRunHarness,
} from './helpers/run-fixtures.ts'
import type { MemberSpec, RunHarness, WorkerBehavior } from './helpers/run-fixtures.ts'

// ---------------------------------------------------------------------------
// Fixture members and shared helpers
// ---------------------------------------------------------------------------

const ticketA = (overrides: Partial<MemberSpec> = {}): MemberSpec => ({
  issueId: 'I_A',
  number: 1,
  ...overrides,
})
const ticketB = (overrides: Partial<MemberSpec> = {}): MemberSpec => ({
  issueId: 'I_B',
  number: 2,
  ...overrides,
})

const FILE_BEHAVIOR: WorkerBehavior = { kind: 'file', name: 'delivered.txt', content: 'done\n' }
const FILE_B_BEHAVIOR: WorkerBehavior = { kind: 'file', name: 'delivered-b.txt', content: 'done-b\n' }
const REMOTE_URL = 'https://github.com/acme/widget.git'

/** Models coordinator death: an exception nothing in the runner catches. */
class CoordinatorDeath extends Error {
  constructor(stage: string) {
    super(`coordinator death at ${stage}`)
  }
}

/** The typed answer the operator gives `/norn abort`'s run-ID confirmation. */
function confirming(runId: string | undefined): AbortInteraction {
  return { confirmRunId: async () => runId }
}

/** Scripted settlement behavior for the fake Visible Agent Runner. */
type RunnerScript = {
  readonly liveHandles: ReadonlySet<string>
  readonly timeoutHandles?: ReadonlySet<string>
  readonly waitForExit: 'exited' | 'timeout'
  readonly terminate: 'terminated' | 'terminate-failed'
}

function scriptedRunner(
  base: VisibleAgentRunner,
  script: RunnerScript,
  events: string[],
): VisibleAgentRunner {
  return {
    kind: base.kind,
    launch: (request) => base.launch(request),
    attach: (adapterHandle) => {
      events.push(`attach:${adapterHandle}`)
      return base.attach(adapterHandle)
    },
    isLive: async (process) => {
      const live = script.liveHandles.has(process.adapterHandle)
      events.push(`isLive:${process.adapterHandle}:${live}`)
      return live
    },
    waitForExit: async (process) => {
      events.push(`wait:${process.adapterHandle}`)
      if (script.waitForExit === 'timeout') return 'timeout'
      return script.timeoutHandles?.has(process.adapterHandle) ? 'timeout' : 'exited'
    },
    terminate: async (process) => {
      events.push(`terminate:${process.adapterHandle}`)
      return script.terminate
    },
  }
}

/** Build the `/norn abort` deps over one harness world. */
function abortDeps(
  harness: RunHarness,
  interaction: AbortInteraction,
  init: {
    readonly runner?: VisibleAgentRunner
    readonly gitFacts?: GitDeliveryFactsAdapter
    readonly releaseReservation?: AbortDeps['releaseReservation']
  } = {},
): AbortDeps {
  const base = harness.deps()
  const git: GitRepositoryAdapter = {
    async resolveRoot(cwd: string) {
      return { kind: 'ok' as const, value: cwd === harness.repo.root ? harness.repo.root : harness.repo.root }
    },
    async listRemotes() {
      return { kind: 'ok' as const, value: [{ name: 'origin', url: REMOTE_URL }] as readonly GitRemote[] }
    },
  }
  return {
    cwd: harness.repo.root,
    nornHome: harness.nornHome,
    git,
    gateway: base.gateway,
    loader: base.loader,
    store: base.store,
    evidence: base.evidence,
    gitFacts: init.gitFacts ?? base.gitFacts,
    runner: init.runner ?? base.runner,
    interaction,
    agentSettleTimeoutMs: 1_000,
    ...(init.releaseReservation === undefined
      ? {}
      : { releaseReservation: init.releaseReservation }),
  }
}

/** Run once; a CoordinatorDeath surfaces to the caller as `{ died: true }`. */
async function runOnce(
  harness: RunHarness,
  wraps: {
    /** The run's operator-interruption signal, forwarded to Work (§9, §17). */
    readonly signal?: AbortSignal
    /** Fire this controller's abort once the given issue's close succeeded. */
    readonly interruptAfterCloseOf?: { readonly controller: AbortController; readonly number: number }
    readonly push?: GitPushSeam
    readonly dieAtCommentOf?: number
    readonly dieAroundPush?: boolean
    /** Die at the map's evidence read once its record comment is written. */
    readonly dieAtMapValidation?: boolean
  } = {},
): Promise<{ outcome: RunMapOutcome } | { died: true }> {
  const base = harness.deps()
  let diedAtPush = false
  let closed = 0
  const deps: RunLifecycleDeps = {
    ...base,
    ...(wraps.signal === undefined ? {} : { signal: wraps.signal }),
    ...(wraps.dieAtMapValidation === undefined
      ? {}
      : {
          evidence: {
            loadIssueEvidence: async (locator: Parameters<typeof base.evidence.loadIssueEvidence>[0]) => {
              if (
                locator.number === MAP_NUMBER &&
                harness.store.observed.mapCommentCalls >= 1
              ) {
                throw new CoordinatorDeath('map-validation')
              }
              return base.evidence.loadIssueEvidence(locator)
            },
          },
        }),
    ...(wraps.dieAtCommentOf === undefined
      ? {}
      : {
          writer: {
            writeIssueComment: async (locator, body) => {
              if (locator.number === wraps.dieAtCommentOf) throw new CoordinatorDeath('comment')
              return base.writer.writeIssueComment(locator, body)
            },
            closeIssue: base.writer.closeIssue,
            reopenIssue: base.writer.reopenIssue,
          },
        }),
    push: async (request) => {
      const outcome = await (wraps.push ?? base.push)(request)
      if (wraps.dieAroundPush && outcome.kind === 'pushed' && !diedAtPush) {
        diedAtPush = true
        throw new CoordinatorDeath('after-push')
      }
      return outcome
    },
    ...(wraps.interruptAfterCloseOf === undefined
      ? {}
      : {
          writer: {
            writeIssueComment: base.writer.writeIssueComment,
            closeIssue: async (locator: Parameters<typeof base.writer.closeIssue>[0]) => {
              const outcome = await base.writer.closeIssue(locator)
              if (
                outcome.kind === 'ok' &&
                locator.number === wraps.interruptAfterCloseOf!.number
              ) {
                closed += 1
                if (closed === 1) wraps.interruptAfterCloseOf!.controller.abort()
              }
              return outcome
            },
            reopenIssue: base.writer.reopenIssue,
          },
        }),
  }
  try {
    return { outcome: await runMap(deps, MAP_URL) }
  } catch (cause) {
    if (cause instanceof CoordinatorDeath) return { died: true }
    throw cause
  }
}

/** The integration confirmed writes of one abort result, narrowed for asserts. */
type IntegrationWrite = Extract<ConfirmedWrite, { kind: 'integration' }>

function integrationWritesOf(writes: readonly ConfirmedWrite[]): IntegrationWrite[] {
  return writes.filter((write): write is IntegrationWrite => write.kind === 'integration')
}

// ---------------------------------------------------------------------------
// Crafted-state helpers (§13.1)
// ---------------------------------------------------------------------------

/** Craft a running state whose one member is mid-Wave in a working attempt. */
function craftWorkingAttempt(
  harness: RunHarness,
  processes: readonly ProcessGroupCheckpoint[] = [],
): RunState {
  const snapshot = harness.snapshot()
  const ticket = snapshot.tickets[0]!
  const baseSha = `sha1:${execFileSync('git', ['-C', harness.repo.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}`
  const baseTreeOid = `sha1:${execFileSync('git', ['-C', harness.repo.root, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()}`
  const workAttemptId = 'wa-w1-t1'
  const branch = `norn/run-crafted/1/${workAttemptId}`
  const crafted = harness.craftRunningState([...processes])
  const state: RunState = {
    ...crafted,
    wave: 1,
    activeWave: {
      number: 1,
      mapRevision: snapshot.mapRevision,
      target: { branch: 'main', baseSha, baseTreeOid },
      frontierTicketIssueIds: [ticket.ref.issueId],
      shipQueueTicketIssueIds: [],
      nextShipIndex: 0,
    },
    tickets: {
      [ticket.ref.issueId]: {
        phase: 'working',
        wave: 1,
        attempt: {
          workAttemptId,
          input: {
            ticket: ticket.ref,
            spec: {
              mapTitle: snapshot.title,
              mapBody: snapshot.body,
              mapRevision: snapshot.mapRevision,
              ticketTitle: ticket.title,
              ticketBody: ticket.body,
              ticketRevision: ticket.ticketRevision,
            },
            target: { branch: 'main', baseSha, baseTreeOid },
          },
          branch,
          workspace: {
            kind: 'ticket',
            repositoryId: crafted.map.repositoryId,
            runId: 'run-crafted',
            path: join(harness.repositoryHome, 'runs', 'run-crafted', 'workspaces', '1', workAttemptId),
            branch,
            workAttemptId,
          },
          round: 0,
          slot: 'reserved',
          processGroupIds: processes.map((group) => group.id),
        },
      },
    },
  }
  const saved = saveRunState(harness.repositoryHome, ENCODED_MAP, state)
  assert.equal(saved.kind, 'ok')
  return state
}

/** One recorded process-group checkpoint bound to the crafted attempt. */
function craftProcessGroup(
  harness: RunHarness,
  init: { readonly id: string; readonly handle: string; readonly state?: 'launch-intent' | 'running' },
): ProcessGroupCheckpoint {
  return {
    id: init.id,
    owner: 'worker',
    phase: 'work',
    workspace: {
      kind: 'ticket',
      repositoryId: REPOSITORY_ID,
      runId: 'run-crafted',
      path: join(harness.repositoryHome, 'runs', 'run-crafted', 'gone'),
      branch: 'norn/run-crafted/1/wa-w1-t1',
      workAttemptId: 'wa-w1-t1',
    },
    ticketIssueId: 'I_A',
    workAttemptId: 'wa-w1-t1',
    adapterHandle: init.handle,
    state: init.state ?? 'launch-intent',
  }
}

/** The registry's reserved work-attempt IDs. */
function reservedIds(harness: RunHarness): readonly string[] {
  const registry = readWorkSlotRegistry(harness.repositoryHome)
  assert.equal(registry.kind, 'ok')
  return (registry.value?.reserved ?? []).map((entry) => entry.workAttemptId)
}

/** The recorded settlement evidence of one ticket's shipping checkpoint. */
function shippingOf(harness: RunHarness, issueId: string) {
  const record = harness.runState()!.tickets[issueId]!
  assert.ok(record.phase === 'shipping', `ticket ${issueId} is shipping, not ${record.phase}`)
  return record.checkpoint
}

// ---------------------------------------------------------------------------
// Acceptance: a mismatched or unconfirmed run ID aborts nothing (§2.3)
// ---------------------------------------------------------------------------

describe('/norn abort confirmation gate (§2.3)', () => {
  it('aborts nothing on a mismatched run ID: no settlement, no release, no state change', async () => {
    const harness = await makeRunHarness({ label: 'gate-mismatch', members: [ticketA()] })
    try {
      const events: string[] = []
      craftWorkingAttempt(harness, [craftProcessGroup(harness, { id: 'pg-live', handle: 'h-live' })])
      const reserved = await reserveWorkSlot(
        harness.repositoryHome,
        { runId: 'run-crafted', encodedMapIssueId: ENCODED_MAP, workAttemptId: 'wa-w1-t1' },
        4,
      )
      assert.equal(reserved.kind, 'ok')

      const outcome = await abortMap(
        abortDeps(harness, confirming('run-not-this'), { runner: scriptedRunner(harness.deps().runner, {
          liveHandles: new Set(['h-live']),
          waitForExit: 'exited',
          terminate: 'terminated',
        }, events) }),
        MAP_URL,
      )

      assert.equal(outcome.kind, 'blocked')
      assert.equal(outcome.code, 'run-id-mismatch')
      assert.equal(outcome.sharedWrite, 'none')

      // Nothing was stopped, reconciled, or recorded.
      assert.deepEqual(events, [])
      const state = harness.runState()!
      assert.equal(state.status, 'running')
      assert.equal(state.activeProcesses[0]?.state, 'launch-intent')
      assert.deepEqual(reservedIds(harness), ['wa-w1-t1'])
    } finally {
      harness.cleanup()
    }
  })

  it('aborts nothing when the confirmation dialog is cancelled or answered empty', async () => {
    const harness = await makeRunHarness({ label: 'gate-cancel', members: [ticketA()] })
    try {
      craftWorkingAttempt(harness)
      for (const answer of [undefined, '', '   '] as const) {
        const outcome = await abortMap(abortDeps(harness, confirming(answer)), MAP_URL)
        assert.equal(outcome.kind, 'blocked')
        assert.equal(outcome.code, 'unconfirmed-run-id')
        assert.equal(outcome.sharedWrite, 'none')
      }
      assert.equal(harness.runState()!.status, 'running')
    } finally {
      harness.cleanup()
    }
  })

  it('aborts nothing for an invalid URL, a map without a run, or an already-ended run', async () => {
    const harness = await makeRunHarness({ label: 'gate-ended', members: [ticketA({ worker: FILE_BEHAVIOR })] })
    try {
      const invalid = await abortMap(abortDeps(harness, confirming('run-1')), '#123')
      assert.equal(invalid.kind, 'blocked')
      assert.equal(invalid.code, 'invalid-map-url')

      let confirmations = 0
      const counting: AbortInteraction = {
        confirmRunId: async (summary) => {
          confirmations += 1
          return summary.runId
        },
      }
      const noRun = await abortMap(abortDeps(harness, counting), MAP_URL)
      assert.equal(noRun.kind, 'blocked')
      assert.equal(noRun.code, 'no-run')
      assert.equal(confirmations, 0)

      // A completed run is terminal: nothing to abort, no dialog shown.
      const passed = await harness.run()
      assert.equal(passed.kind, 'ok')
      const ended = await abortMap(abortDeps(harness, counting), MAP_URL)
      assert.equal(ended.kind, 'blocked')
      assert.equal(ended.code, 'run-not-running')
      assert.equal(confirmations, 0)
      assert.equal(harness.runState()!.status, 'terminal')
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Acceptance: a confirmed abort reconciles processes and shared writes and
// records `aborted` with every remote evidence intact (§2.3, §13.2)
// ---------------------------------------------------------------------------

describe('confirmed abort reconciliation (§2.3, §13.2)', () => {
  it('settles live process groups — by wait or by termination — and releases Work slots only after settlement', async () => {
    const harness = await makeRunHarness({ label: 'abort-settle', members: [ticketA()] })
    try {
      const events: string[] = []
      craftWorkingAttempt(harness, [
        craftProcessGroup(harness, { id: 'pg-live', handle: 'h-live' }),
        craftProcessGroup(harness, { id: 'pg-slow', handle: 'h-slow', state: 'running' }),
      ])
      const reserved = await reserveWorkSlot(
        harness.repositoryHome,
        { runId: 'run-crafted', encodedMapIssueId: ENCODED_MAP, workAttemptId: 'wa-w1-t1' },
        4,
      )
      assert.equal(reserved.kind, 'ok')

      const outcome = await abortMap(
        abortDeps(harness, confirming('run-crafted'), {
          runner: scriptedRunner(harness.deps().runner, {
            liveHandles: new Set(['h-live', 'h-slow']),
            timeoutHandles: new Set(['h-slow']),
            waitForExit: 'exited',
            terminate: 'terminated',
          }, events),
          releaseReservation: async (repositoryHome, workAttemptId) => {
            events.push(`release:${workAttemptId}`)
            return releaseWorkSlot(repositoryHome, workAttemptId, { probe: settlementProbe() })
          },
        }),
        MAP_URL,
      )

      assert.equal(outcome.kind, 'ok')
      assert.equal(outcome.value.kind, 'aborted')
      assert.deepEqual([...outcome.value.settledProcessGroupIds].sort(), ['pg-live', 'pg-slow'])
      assert.deepEqual(outcome.value.releasedSlots, ['wa-w1-t1'])
      assert.equal(outcome.value.sharedWrite, 'none')

      // Both reconciliation modes ran and both preceded the slot release.
      const waitedAt = events.indexOf('wait:h-live')
      const terminatedAt = events.indexOf('terminate:h-slow')
      const releasedAt = events.indexOf('release:wa-w1-t1')
      assert.ok(waitedAt !== -1 && terminatedAt !== -1 && releasedAt !== -1)
      assert.ok(waitedAt < releasedAt && terminatedAt < releasedAt)

      // Run State is retained — recorded aborted, both groups persisted settled.
      const state = harness.runState()!
      assert.equal(state.status, 'aborted')
      assert.equal(state.runId, 'run-crafted')
      assert.ok(state.activeProcesses.every((group) => group.state === 'settled'))
      assert.deepEqual(reservedIds(harness), [])
    } finally {
      harness.cleanup()
    }
  })

  it('records aborted with the confirmed integration write, leaving the pushed commit and all remote evidence intact', async () => {
    const harness = await makeRunHarness({ label: 'abort-confirmed', members: [ticketA({ worker: FILE_BEHAVIOR })] })
    try {
      // Coordinator dies after the push was remotely verified but before any
      // GitHub write: a confirmed shared write nothing later reconciled.
      const died = await runOnce(harness, { dieAtCommentOf: 1 })
      assert.ok('died' in died)
      const midShip = harness.runState()!
      assert.equal(midShip.status, 'running')
      assert.equal(shippingOf(harness, 'I_A').stage, 'push-verified')
      const remoteLogAfterPush = harness.remoteLog()
      assert.equal(remoteLogAfterPush.length, 2)
      assert.ok(abortRunSummary(midShip).pendingSharedWrite)

      const outcome = await abortMap(abortDeps(harness, confirming('run-1')), MAP_URL)

      assert.equal(outcome.kind, 'ok')
      assert.equal(outcome.value.kind, 'aborted')
      assert.equal(outcome.value.sharedWrite, 'confirmed')
      assert.deepEqual(outcome.value.confirmedWrites, [
        {
          kind: 'integration',
          ticketIssueId: 'I_A',
          stage: 'push-verified',
          integratedSha: shippingOf(harness, 'I_A').integratedSha,
          provenBy: 'persisted-checkpoint',
        },
      ])

      // Remote evidence intact: same target history, no record comment, no
      // close, no reopen, nothing rolled back.
      assert.deepEqual(harness.remoteLog(), remoteLogAfterPush)
      assert.equal(harness.store.issues.get(1)!.state, 'OPEN')
      assert.equal(harness.store.issues.get(1)!.comments.length, 0)
      assert.equal(harness.store.observed.closeCalls, 0)
      assert.equal(harness.store.observed.reopenCalls, 0)
      assert.equal(harness.store.observed.commentCalls, 0)

      // Run State is retained with the aborted decision, never deleted.
      const state = harness.runState()!
      assert.equal(state.status, 'aborted')
      assert.equal(state.runId, 'run-1')
      assert.equal(state.report, undefined)
    } finally {
      harness.cleanup()
    }
  })

  it('proves a possibly-successful push by remote probe when the checkpoint stayed prepared', async () => {
    const harness = await makeRunHarness({ label: 'abort-probe', members: [ticketA({ worker: FILE_BEHAVIOR })] })
    try {
      // The push itself succeeded, but the coordinator died before any
      // verification persisted: the checkpoint stays `prepared` with one
      // consumed attempt, and the integration IS on the target.
      const died = await runOnce(harness, { dieAroundPush: true })
      assert.ok('died' in died)
      const checkpoint = shippingOf(harness, 'I_A')
      assert.equal(checkpoint.stage, 'prepared')
      assert.equal(checkpoint.pushAttempts, 1)
      assert.equal(harness.remoteLog().length, 2)

      const outcome = await abortMap(abortDeps(harness, confirming('run-1')), MAP_URL)

      assert.equal(outcome.kind, 'ok')
      assert.equal(outcome.value.kind, 'aborted')
      assert.equal(outcome.value.sharedWrite, 'confirmed')
      const writes = integrationWritesOf(outcome.value.confirmedWrites)
      assert.equal(writes.length, 1)
      assert.equal(writes[0]!.provenBy, 'remote-probe')
      assert.equal(writes[0]!.integratedSha, checkpoint.integratedSha)

      // The pushed commit stays on the target; the open Ticket keeps no record.
      assert.equal(harness.remoteLog().length, 2)
      assert.equal(harness.store.issues.get(1)!.comments.length, 0)
      assert.equal(harness.runState()!.status, 'aborted')
    } finally {
      harness.cleanup()
    }
  })

  it('treats a provably-absent recorded push as no shared write', async () => {
    const harness = await makeRunHarness({ label: 'abort-absent', members: [ticketA({ worker: FILE_BEHAVIOR })] })
    try {
      // The coordinator died around a push that never reached the remote:
      // one attempt consumed, integration provably absent.
      const base = harness.deps()
      let calls = 0
      const died = await runOnce(harness, {
        push: async (request) => {
          calls += 1
          if (calls === 1) throw new CoordinatorDeath('around-push')
          return base.push(request)
        },
      })
      assert.ok('died' in died)
      const checkpoint = shippingOf(harness, 'I_A')
      assert.equal(checkpoint.stage, 'prepared')
      assert.equal(checkpoint.pushAttempts, 1)
      assert.equal(harness.remoteLog().length, 1)

      const outcome = await abortMap(abortDeps(harness, confirming('run-1')), MAP_URL)
      assert.equal(outcome.kind, 'ok')
      assert.equal(outcome.value.kind, 'aborted')
      assert.equal(outcome.value.sharedWrite, 'none')
      assert.deepEqual(outcome.value.confirmedWrites, [])
      assert.equal(harness.runState()!.status, 'aborted')
    } finally {
      harness.cleanup()
    }
  })

  it('refuses while a live coordinator holds the map lock, and touches nothing', async () => {
    const harness = await makeRunHarness({ label: 'abort-lock', members: [ticketA()] })
    try {
      craftWorkingAttempt(harness, [craftProcessGroup(harness, { id: 'pg-live', handle: 'h-live' })])
      const lock = await acquireMapLock(harness.repositoryHome, ENCODED_MAP)
      assert.equal(lock.kind, 'ok')
      try {
        const outcome = await abortMap(abortDeps(harness, confirming('run-crafted')), MAP_URL)
        assert.equal(outcome.kind, 'blocked')
        assert.equal(outcome.code, 'lock-held')
        assert.equal(outcome.sharedWrite, 'none')
        const state = harness.runState()!
        assert.equal(state.status, 'running')
        assert.equal(state.activeProcesses[0]?.state, 'launch-intent')
      } finally {
        await lock.value.release()
      }
    } finally {
      harness.cleanup()
    }
  })

  it('fails and keeps the run recoverable when settlement cannot be proven', async () => {
    const harness = await makeRunHarness({ label: 'abort-unsettled', members: [ticketA()] })
    try {
      craftWorkingAttempt(harness, [craftProcessGroup(harness, { id: 'pg-stuck', handle: 'h-stuck', state: 'running' })])
      const reserved = await reserveWorkSlot(
        harness.repositoryHome,
        { runId: 'run-crafted', encodedMapIssueId: ENCODED_MAP, workAttemptId: 'wa-w1-t1' },
        4,
      )
      assert.equal(reserved.kind, 'ok')

      const outcome = await abortMap(
        abortDeps(harness, confirming('run-crafted'), {
          runner: scriptedRunner(harness.deps().runner, {
            liveHandles: new Set(['h-stuck']),
            waitForExit: 'timeout',
            terminate: 'terminate-failed',
          }, []),
        }),
        MAP_URL,
      )

      assert.equal(outcome.kind, 'error')
      assert.equal(outcome.code, 'adapter-failure')
      assert.equal(outcome.sharedWrite, 'none')
      const state = harness.runState()!
      assert.equal(state.status, 'running')
      assert.equal(state.activeProcesses[0]?.state, 'running')
      assert.deepEqual(reservedIds(harness), ['wa-w1-t1'])
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Acceptance: unreconcilable ambiguity refuses and keeps the run recoverable
// (§2.3, §13.3, §13.4)
// ---------------------------------------------------------------------------

describe('unreconcilable ambiguity refuses (§2.3, §13.3, §13.4)', () => {
  it('fails the abort over an unclassifiable possibly-successful push, and the next run resumes — never replaces — the run', async () => {
    const harness = await makeRunHarness({ label: 'abort-ambiguous', members: [ticketA({ worker: FILE_BEHAVIOR })] })
    try {
      // One consumed push attempt whose remote state cannot be read: the
      // write may or may not have succeeded.
      const base = harness.deps()
      let calls = 0
      const died = await runOnce(harness, {
        push: async (request) => {
          calls += 1
          if (calls === 1) throw new CoordinatorDeath('around-push')
          return base.push(request)
        },
      })
      assert.ok('died' in died)
      assert.equal(shippingOf(harness, 'I_A').pushAttempts, 1)

      // Every fetch fails while the abort runs: the recorded integration
      // cannot be classified, so the abort must refuse.
      const failingFacts: GitDeliveryFactsAdapter = {
        ...base.gitFacts,
        fetchTarget: async () => ({
          kind: 'error' as const,
          scope: 'operation' as const,
          code: 'git-failed' as const,
          reason: 'scripted fetch failure',
          sharedWrite: 'none' as const,
          evidence: [],
        }),
      }
      const refused = await abortMap(abortDeps(harness, confirming('run-1'), { gitFacts: failingFacts }), MAP_URL)
      assert.equal(refused.kind, 'error')
      // The probe's bounded cycles never agreed: the write stays unclassifiable.
      assert.equal(refused.code, 'push-unknown')
      assert.equal(refused.sharedWrite, 'unknown')

      // The run stays recoverable: same ID, still running — a new run can
      // never start from this state while it remains ambiguous.
      let state = harness.runState()!
      assert.equal(state.status, 'running')
      assert.equal(state.runId, 'run-1')

      // With the remote readable again, the next invocation resumes the SAME
      // run and converges on a full delivery.
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')
      state = harness.runState()!
      assert.equal(state.runId, 'run-1')
      assert.equal(state.status, 'terminal')
      assert.equal(state.tickets.I_A!.phase, 'completed')
    } finally {
      harness.cleanup()
    }
  })

  it('fails the abort when the map-completion close window cannot be relocated', async () => {
    const harness = await makeRunHarness({ label: 'abort-anchor', members: [ticketA({ worker: FILE_BEHAVIOR })] })
    try {
      // A gated completion checkpoint whose timeline anchor is no longer in
      // the map's timeline: a possibly-successful close that cannot be
      // attributed — never guessed from (§13.1, §13.4).
      const state = harness.craftRunningState()
      const checkpoint = craftCompletionCheckpoint(harness, {
        mapRevision: state.acceptedMapRevisions[0]!.revision,
        timelineAnchor: { kind: 'event-id', eventId: 'E-gone' },
      })
      const saved = saveRunState(harness.repositoryHome, ENCODED_MAP, { ...state, mapCompletion: checkpoint })
      assert.equal(saved.kind, 'ok')

      const outcome = await abortMap(abortDeps(harness, confirming('run-crafted')), MAP_URL)
      assert.equal(outcome.kind, 'error')
      assert.equal(outcome.code, 'issue-close')
      assert.equal(outcome.sharedWrite, 'unknown')
      assert.equal(harness.runState()!.status, 'running')
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Acceptance: finalized map completion wins over abort (§13.2, §13.4)
// ---------------------------------------------------------------------------

describe('finalized completion wins over abort (§13.2)', () => {
  it('terminalizes passed from a validated completion record instead of aborting', async () => {
    const harness = await makeRunHarness({ label: 'abort-passed', members: [ticketA({ worker: FILE_BEHAVIOR })] })
    try {
      // Die at the final post-record validation: the map is CLOSED with its
      // completion record comment written, while the run is still `running`
      // at the `recorded` checkpoint — the exact world an abort lands on.
      const died = await runOnce(harness, { dieAtMapValidation: true })
      assert.ok('died' in died)
      const state = harness.runState()!
      assert.equal(state.status, 'running')
      assert.equal(state.mapCompletion?.stage, 'recorded')
      assert.equal(harness.store.issues.get(MAP_NUMBER)!.state, 'CLOSED')
      assert.equal(harness.store.issues.get(MAP_NUMBER)!.comments.length, 1)
      const gateRuns = harness.store.observed.completionReviewerLaunches

      const outcome = await abortMap(abortDeps(harness, confirming('run-1')), MAP_URL)

      // Reconciliation proved map completion finalized: terminal `passed`
      // takes precedence over the abort (§13.2).
      assert.equal(outcome.kind, 'ok')
      assert.equal(outcome.value.kind, 'passed')
      assert.equal(outcome.value.report.label, 'passed')
      assert.ok(outcome.value.report.completionSha !== undefined)
      const terminal = harness.runState()!
      assert.equal(terminal.status, 'terminal')
      assert.equal(terminal.report?.label, 'passed')
      assert.equal(terminal.mapCompletion?.stage, 'recorded')

      // No completion gates re-ran, and every remote fact stands untouched.
      assert.equal(harness.store.observed.completionReviewerLaunches, gateRuns)
      assert.equal(harness.store.observed.mapCloseCalls, 1)
      assert.equal(harness.store.observed.mapCommentCalls, 1)
      assert.equal(harness.store.issues.get(MAP_NUMBER)!.comments.length, 1)
      assert.equal(harness.store.issues.get(MAP_NUMBER)!.state, 'CLOSED')
    } finally {
      harness.cleanup()
    }
  })

  it('aborts plainly when the close is confirmed but the record never finalized', async () => {
    const harness = await makeRunHarness({ label: 'abort-close-only', members: [ticketA({ worker: FILE_BEHAVIOR })] })
    try {
      // Die at the record comment write: the map close is remotely visible
      // but the finalization marker was never written.
      const base = harness.deps()
      const died = await runOnce(harness, {
        push: base.push,
        dieAtCommentOf: MAP_NUMBER,
      })
      assert.ok('died' in died)
      const state = harness.runState()!
      assert.equal(state.status, 'running')
      assert.equal(state.mapCompletion?.stage, 'map-closed')
      assert.equal(harness.store.issues.get(MAP_NUMBER)!.state, 'CLOSED')
      assert.equal(harness.store.issues.get(MAP_NUMBER)!.comments.length, 0)

      const outcome = await abortMap(abortDeps(harness, confirming('run-1')), MAP_URL)
      assert.equal(outcome.kind, 'ok')
      assert.equal(outcome.value.kind, 'aborted')
      assert.equal(outcome.value.sharedWrite, 'confirmed')
      // The confirmed close write is recorded exactly; the map stays closed
      // with no record and no reopen — remote evidence is never touched.
      assert.ok(
        outcome.value.confirmedWrites.some((write) => write.kind === 'map-close'),
        'the actor close after the anchor is a confirmed write',
      )
      assert.equal(harness.runState()!.status, 'aborted')
      assert.equal(harness.store.issues.get(MAP_NUMBER)!.state, 'CLOSED')
      assert.equal(harness.store.issues.get(MAP_NUMBER)!.comments.length, 0)
      assert.equal(harness.store.observed.mapReopenCalls, 0)
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Acceptance: the next run after abort starts fresh (§2.5, §13.2)
// ---------------------------------------------------------------------------

describe('the next run after abort starts fresh (§2.5)', () => {
  it('retains valid Completed Tickets and never reuses unshipped Work, branches, or workspaces', async () => {
    const harness = await makeRunHarness({
      label: 'fresh-after-abort',
      members: [ticketA({ worker: FILE_BEHAVIOR }), ticketB({ worker: FILE_B_BEHAVIOR })],
    })
    try {
      // Interrupt the coordinator after ticket #1 closed: its Ship completes
      // fully (a valid Completed Ticket), while #2 stays queued and unshipped.
      const controller = new AbortController()
      const interrupted = await runOnce(harness, {
        signal: controller.signal,
        interruptAfterCloseOf: { controller, number: 1 },
      })
      assert.ok('outcome' in interrupted)
      assert.equal(interrupted.outcome.kind, 'blocked')
      assert.equal(interrupted.outcome.code, 'user-abort')

      const aborted = harness.runState()!
      assert.equal(aborted.status, 'aborted')
      assert.equal(aborted.tickets.I_A!.phase, 'completed')
      assert.equal(aborted.tickets.I_B!.phase, 'shippable')
      const runOneLaunches = harness.workedTickets().length
      const runOneLaunchSnapshot = [...harness.runner.launches]
      const runOneBWorkspace = aborted.tickets.I_B!.phase === 'shippable'
        ? aborted.tickets.I_B.change.workspace.path
        : undefined
      assert.ok(runOneBWorkspace !== undefined && existsSync(runOneBWorkspace))
      assert.equal(harness.store.issues.get(1)!.comments.length, 1)

      // The next run works from current facts: a new run ID, an empty parked
      // set, and only #2 reworked — #1's remote Delivery Record retains it.
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')
      const state = harness.runState()!
      assert.equal(state.runId, 'run-2')
      assert.equal(state.status, 'terminal')
      assert.deepEqual(state.parkedTickets, [])
      assert.equal(state.tickets.I_A!.phase, 'completed')
      assert.equal(state.tickets.I_B!.phase, 'completed')
      assert.equal(harness.workedTickets().filter((id) => id === 'I_A').length, 1)
      assert.equal(harness.workedTickets().filter((id) => id === 'I_B').length, 2)
      assert.ok(harness.workedTickets().length > runOneLaunches)

      // The aborted run's unshipped workspace was never reused.
      assert.ok(existsSync(runOneBWorkspace!))
      const runTwoLaunches = harness.runner.launches.filter(
        (entry) => !runOneLaunchSnapshot.includes(entry),
      )
      assert.ok(
        !runTwoLaunches.some((entry) => entry.cwd === runOneBWorkspace),
        'no agent of the fresh run ever ran in the aborted run workspace',
      )
      assert.equal(harness.store.issues.get(1)!.comments.length, 1)
      assert.equal(harness.store.observed.closeCalls, 2) // #1 once, #2 once
    } finally {
      harness.cleanup()
    }
  })

  it('credits a pushed-but-unrecorded commit only through fresh zero-delta Work', async () => {
    const harness = await makeRunHarness({ label: 'fresh-zero-delta', members: [ticketA({ worker: FILE_BEHAVIOR })] })
    try {
      // Abort after the integration landed but before any GitHub write: the
      // commit stays on the target with no Delivery Record.
      const died = await runOnce(harness, { dieAtCommentOf: 1 })
      assert.ok('died' in died)
      const aborted = await abortMap(abortDeps(harness, confirming('run-1')), MAP_URL)
      assert.equal(aborted.kind, 'ok')
      assert.equal(aborted.value.kind, 'aborted')
      assert.equal(aborted.value.sharedWrite, 'confirmed')
      assert.equal(harness.remoteLog().length, 2)
      assert.equal(harness.store.observed.pushes, 1)

      // Fresh Work takes the open Ticket: a zero-delta test and review over
      // the already-delivered target earns credit without a second push.
      harness.store.behaviors.I_A = { kind: 'zero-delta' }
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')
      const state = harness.runState()!
      assert.equal(state.runId, 'run-2')
      assert.equal(state.report?.label, 'passed')
      assert.equal(state.tickets.I_A!.phase, 'completed')
      assert.equal(harness.store.observed.pushes, 1)
      assert.equal(harness.remoteLog().length, 2)
      assert.equal(harness.store.issues.get(1)!.comments.length, 1)
      assert.equal(harness.store.issues.get(1)!.state, 'CLOSED')
      assert.equal(harness.store.issues.get(MAP_NUMBER)!.state, 'CLOSED')
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Acceptance: interrupting the coordinator mid-Ship equals /norn abort (§2.3)
// ---------------------------------------------------------------------------

describe('a handled coordinator interrupt mid-Ship equals /norn abort (§2.3)', () => {
  it('produces the same protocol outcome as aborting the identical world', async () => {
    const members = [ticketA({ worker: FILE_BEHAVIOR })]

    // World A: the operator interrupts the coordinator right after its push
    // landed mid-Ship; the handled interrupt runs the abort protocol itself.
    const interruptWorld = await makeRunHarness({ label: 'interrupt-mid-ship', members })
    try {
      const controller = new AbortController()
      const base = interruptWorld.deps()
      const interrupted = await runOnce(interruptWorld, {
        signal: controller.signal,
        push: async (request) => {
          const outcome = await base.push(request)
          if (outcome.kind === 'pushed') controller.abort()
          return outcome
        },
      })
      assert.ok('outcome' in interrupted)
      assert.equal(interrupted.outcome.kind, 'blocked')
      assert.equal(interrupted.outcome.code, 'user-abort')
      assert.equal(interrupted.outcome.sharedWrite, 'confirmed')

      const interruptState = interruptWorld.runState()!
      assert.equal(interruptState.status, 'aborted')
      const interruptCheckpoint = interruptState.tickets.I_A!
      assert.ok(interruptCheckpoint.phase === 'shipping')
      const interruptFacts = {
        status: interruptState.status,
        stage: interruptCheckpoint.checkpoint.stage,
        pushAttempts: interruptCheckpoint.checkpoint.pushAttempts,
        integratedIsRemoteTip:
          interruptCheckpoint.checkpoint.integratedSha === interruptWorld.remoteMainSha(),
        remoteLog: interruptWorld.remoteLog(),
        ticketState: interruptWorld.store.issues.get(1)!.state,
        ticketComments: interruptWorld.store.issues.get(1)!.comments.length,
        mapState: interruptWorld.store.issues.get(MAP_NUMBER)!.state,
        pushes: interruptWorld.store.observed.pushes,
        closeCalls: interruptWorld.store.observed.closeCalls,
      }

      // World B: the identical world, but the coordinator dies at the same
      // mid-Ship point and the operator runs /norn abort over its state.
      const abortWorld = await makeRunHarness({ label: 'abort-mid-ship', members })
      try {
        const died = await runOnce(abortWorld, { dieAtCommentOf: 1 })
        assert.ok('died' in died)
        const aborted = await abortMap(abortDeps(abortWorld, confirming('run-1')), MAP_URL)
        assert.equal(aborted.kind, 'ok')
        assert.equal(aborted.value.kind, 'aborted')
        assert.equal(aborted.value.sharedWrite, 'confirmed')

        const abortState = abortWorld.runState()!
        const abortCheckpoint = abortState.tickets.I_A!
        assert.ok(abortCheckpoint.phase === 'shipping')
        const abortFacts = {
          status: abortState.status,
          stage: abortCheckpoint.checkpoint.stage,
          pushAttempts: abortCheckpoint.checkpoint.pushAttempts,
          integratedIsRemoteTip:
            abortCheckpoint.checkpoint.integratedSha === abortWorld.remoteMainSha(),
          remoteLog: abortWorld.remoteLog(),
          ticketState: abortWorld.store.issues.get(1)!.state,
          ticketComments: abortWorld.store.issues.get(1)!.comments.length,
          mapState: abortWorld.store.issues.get(MAP_NUMBER)!.state,
          pushes: abortWorld.store.observed.pushes,
          closeCalls: abortWorld.store.observed.closeCalls,
        }
        assert.deepEqual(abortFacts, interruptFacts)
      } finally {
        abortWorld.cleanup()
      }
    } finally {
      interruptWorld.cleanup()
    }
  })
})
