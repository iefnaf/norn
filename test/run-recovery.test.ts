/**
 * Recovery and resume — the fault-injection suite (design.md §13.2–§13.4,
 * ticket #15).
 *
 * Coordinator death is modeled exactly as the design intends recovery to be
 * exercised: a seam throws mid-orchestration over real persisted state — the
 * real Run State document, the real Work-slot registry, a real git
 * repository with a bare remote, and the fake gateway's scriptable issue
 * timelines — and `/norn run` is simply re-invoked. One deterministic
 * harness (the ticket #13 fixtures) covers all five seams.
 *
 * Every stage of the §13.1 checkpoint vocabulary is killed once:
 *
 * - Work: after the attempt record (before workspace creation), mid-round
 *   after the worker settled, and at the wave barrier before the ship queue
 *   persists;
 * - Ship (§13.3): around the push call (the conservative attempt
 *   consumption), after remote verification (stage `push-verified`), after
 *   the Delivery Record (stage `delivery-recorded`), after the close (stage
 *   `ticket-closed`), and with the retry budget exhausted while the
 *   integration is provably absent;
 * - Map completion (§13.4): at the `gated`, `map-closed`, and `recorded`
 *   checkpoint stages, plus the close/reopen ambiguity.
 *
 * Each faulted scenario is compared against an uninterrupted reference run
 * of the same world: the resumed run must converge on the same safe outcome
 * — the same report label and code, the same per-Ticket states, the same
 * remote target history, and the same map state. Ordering assertions prove
 * no Work slot is released and no workspace is reused before process-group
 * settlement is persisted, and total local state loss behaves per §13.3:
 * open Tickets take fresh Work, closed Tickets without valid remote evidence
 * are integrity-blocked.
 */
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { runMap } from '../src/run/lifecycle.ts'
import type { RunLifecycleDeps, RunMapOutcome } from '../src/run/lifecycle.ts'
import { settlementProbe } from '../src/run/recovery.ts'
import { saveRunState } from '../src/runstate/run-state-store.ts'
import type { ProcessGroupCheckpoint, RunState } from '../src/runstate/types.ts'
import {
  readWorkSlotRegistry,
  releaseWorkSlot,
  reserveWorkSlot,
} from '../src/runstate/slot-registry.ts'
import type { GitCommandRunner, GitPushSeam } from '../src/adapters/git-repository.ts'
import type { VisibleAgentRunner } from '../src/agents/runner.ts'
import type { CommandExecutionRequest } from '../src/work/command-runner.ts'
import { ENCODED_MAP, MAP_NUMBER, MAP_URL, makeRunHarness } from './helpers/run-fixtures.ts'
import type { MemberSpec, RunHarness, WorkerBehavior } from './helpers/run-fixtures.ts'

// ---------------------------------------------------------------------------
// Fixture members
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
const ticket9 = (overrides: Partial<MemberSpec> = {}): MemberSpec => ({
  issueId: 'I_9',
  number: 9,
  ...overrides,
})

const FILE_BEHAVIOR: WorkerBehavior = { kind: 'file', name: 'delivered.txt', content: 'done\n' }

// ---------------------------------------------------------------------------
// Coordinator death and the fault-injecting deps
// ---------------------------------------------------------------------------

/** Models coordinator death: an exception nothing in the runner catches. */
class CoordinatorDeath extends Error {
  readonly stage: string

  constructor(stage: string) {
    super(`coordinator death at ${stage}`)
    this.stage = stage
  }
}

/** The seams a death can be armed on. */
type FaultSeam =
  | 'map-read'
  | 'comment'
  | 'close'
  | 'reopen'
  | 'command'
  | 'evidence-read'
  | 'work-git'

type FaultSpec = {
  readonly label: string
  readonly seam: FaultSeam
  readonly match: (detail: unknown) => boolean
}

/** One push-call action: optionally advance the remote, then delegate or die. */
type PushAction = 'delegate' | 'die' | 'advance-then-delegate' | 'advance-then-die'

/**
 * Scenario-wide wraps: the one-shot fault, the push plan keyed on a counter
 * that survives re-invocation, an event log, and the fake runner's scripted
 * reconciliation behavior.
 */
type ScenarioWraps = {
  readonly fault?: FaultSpec & { readonly armed: { fired: boolean } }
  readonly pushPlan?: (call: number) => PushAction
  /** The persistent push-call counter; one per scenario. */
  readonly pushState?: { count: number }
  readonly record?: string[]
  readonly runnerScript?: {
    readonly liveHandles: ReadonlySet<string>
    /** Handles whose wait budget elapses; they terminate-and-settle instead. */
    readonly timeoutHandles?: ReadonlySet<string>
    readonly waitForExit: 'exited' | 'timeout'
    readonly terminate: 'terminated' | 'terminate-failed'
  }
}

function buildDeps(harness: RunHarness, wraps: ScenarioWraps = {}): RunLifecycleDeps {
  const base = harness.deps()
  const events = wraps.record
  const die = (): never => {
    if (wraps.fault !== undefined) wraps.fault.armed.fired = true
    throw new CoordinatorDeath(wraps.fault?.label ?? 'push')
  }
  const check = (seam: FaultSeam, detail: unknown): void => {
    const fault = wraps.fault
    if (fault === undefined || fault.armed.fired || fault.seam !== seam) return
    if (fault.match(detail)) die()
  }

  const pushState = wraps.pushState ?? { count: 0 }
  const advances = { count: 0 }
  const push: GitPushSeam = async (request) => {
    pushState.count += 1
    const action = wraps.pushPlan?.(pushState.count) ?? 'delegate'
    if (action.startsWith('advance')) {
      advances.count += 1
      advanceRemote(harness, advances.count)
    }
    if (action.endsWith('die')) die()
    events?.push(`push:${pushState.count}`)
    const outcome = await base.push(request)
    events?.push(`push-result:${pushState.count}:${outcome.kind}`)
    return outcome
  }

  const workGit: GitCommandRunner = async (args, cwd) => {
    check('work-git', { args, cwd })
    events?.push(`git:${args[0]}:${cwd.includes(`${join('runs', 'workspaces')}`) ? 'workspace' : 'other'}`)
    return base.workGit(args, cwd)
  }

  const runner: VisibleAgentRunner =
    wraps.runnerScript === undefined
      ? base.runner
      : recordingRunner(base.runner, wraps.record!, wraps.runnerScript)

  return {
    ...base,
    loader: {
      loadTaskMap: async (locator) => {
        check('map-read', locator)
        return base.loader.loadTaskMap(locator)
      },
    },
    push,
    workGit,
    runner,
    commands: {
      execute: async (request: CommandExecutionRequest) => {
        check('command', request)
        events?.push(`command:${request.argv.join('-')}`)
        return base.commands.execute(request)
      },
    },
    evidence: {
      loadIssueEvidence: async (locator) => {
        check('evidence-read', locator)
        events?.push(`evidence:${locator.number}`)
        return base.evidence.loadIssueEvidence(locator)
      },
    },
    writer: {
      writeIssueComment: async (locator, body) => {
        check('comment', locator)
        events?.push(`comment:${locator.number}`)
        return base.writer.writeIssueComment(locator, body)
      },
      closeIssue: async (locator) => {
        check('close', locator)
        events?.push(`close:${locator.number}`)
        return base.writer.closeIssue(locator)
      },
      reopenIssue: async (locator) => {
        check('reopen', locator)
        events?.push(`reopen:${locator.number}`)
        return base.writer.reopenIssue(locator)
      },
    },
    ...(wraps.record === undefined
      ? {}
      : {
          releaseReservation: async (repositoryHome: string, workAttemptId: string) => {
            wraps.record!.push(`release:${workAttemptId}`)
            return releaseWorkSlot(repositoryHome, workAttemptId, {
              probe: settlementProbe(),
            })
          },
        }),
  }
}

/** Wrap the fake runner with recorded, scripted reconciliation behavior. */
function recordingRunner(
  base: VisibleAgentRunner,
  events: string[],
  script: NonNullable<ScenarioWraps['runnerScript']>,
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

/** Advance the bare remote's main by one empty commit (the "other shipper"). */
function advanceRemote(harness: RunHarness, index: number): void {
  execFileSync('git', [
    '-C',
    harness.repo.root,
    'commit',
    '--quiet',
    '--allow-empty',
    '--no-gpg-sign',
    '-m',
    `advance ${index}`,
  ])
  execFileSync('git', ['-C', harness.repo.root, 'push', '--quiet', 'origin', 'main'])
}

/** Run once; a CoordinatorDeath surfaces to the caller as `{ died: true }`. */
async function runOnce(
  harness: RunHarness,
  wraps: ScenarioWraps = {},
): Promise<{ outcome: RunMapOutcome } | { died: true }> {
  try {
    return { outcome: await runMap(buildDeps(harness, wraps), MAP_URL) }
  } catch (cause) {
    if (cause instanceof CoordinatorDeath) return { died: true }
    throw cause
  }
}

/**
 * Re-invoke `/norn run` until the faulted world reaches a terminal (or
 * terminal-error) outcome, tolerating coordinator deaths and recoverable
 * interruptions along the way.
 */
async function runToCompletion(harness: RunHarness, wraps: ScenarioWraps): Promise<RunMapOutcome> {
  for (let invocation = 0; invocation < 4; invocation++) {
    const attempt = await runOnce(harness, wraps)
    if ('died' in attempt) {
      // Let any floating wave tasks of the dead coordinator drain before a
      // new coordinator takes the map lock.
      await new Promise((resolve) => setTimeout(resolve, 150))
      continue
    }
    const outcome = attempt.outcome
    if (outcome.kind !== 'error') return outcome
    if (outcome.sharedWrite === 'none') return outcome
    // A recoverable interruption: the same run resumes on the next loop.
  }
  throw new Error('the faulted run never reached a terminal outcome')
}

// ---------------------------------------------------------------------------
// The convergence comparator
// ---------------------------------------------------------------------------

type SafeOutcome = {
  readonly label: string
  readonly code: string | undefined
  readonly mapState: 'OPEN' | 'CLOSED'
  readonly remoteLog: readonly string[]
  readonly tickets: ReadonlyArray<{ readonly number: number; readonly state: string; readonly code?: string }>
  readonly sharedWrite: string
}

function safeOutcomeOf(harness: RunHarness, outcome: RunMapOutcome): SafeOutcome {
  assert.ok(
    outcome.kind === 'ok' || outcome.kind === 'blocked' || outcome.sharedWrite === 'none',
    'the comparator runs only on terminal outcomes',
  )
  const state = harness.runState()!
  const report = state.report
  assert.ok(report !== undefined, 'the converged run persists its terminal report')
  return {
    label: report.label,
    code: report.code,
    mapState: harness.store.issues.get(MAP_NUMBER)!.state,
    remoteLog: harness.remoteLog(),
    tickets: report.tickets
      .map((entry) => ({
        number: entry.ticket.number,
        state: entry.state,
        ...(entry.code === undefined ? {} : { code: entry.code }),
      }))
      .sort((a, b) => a.number - b.number),
    sharedWrite: report.sharedWrite,
  }
}

/** The safe outcome an uninterrupted run of the same world establishes. */
async function referenceOutcome(
  options: { readonly label: string; readonly members: readonly MemberSpec[] },
  wraps: ScenarioWraps = {},
): Promise<SafeOutcome> {
  const harness = await makeRunHarness(options)
  try {
    const outcome = await runToCompletion(harness, wraps)
    return safeOutcomeOf(harness, outcome)
  } finally {
    harness.cleanup()
  }
}

function assertConverged(reference: SafeOutcome, faulted: SafeOutcome, stage: string): void {
  assert.deepEqual(
    { ...faulted },
    { ...reference },
    `resume after a coordinator death at ${stage} must converge on the uninterrupted run's safe outcome`,
  )
}

// ---------------------------------------------------------------------------
// Crafted-state helpers
// ---------------------------------------------------------------------------

function ticketPhaseOf(harness: RunHarness, issueId: string): string {
  return harness.runState()!.tickets[issueId]!.phase
}

/** Craft a running state whose one member is mid-Wave in a working attempt. */
function craftWorkingAttempt(
  harness: RunHarness,
  init: {
    readonly processes?: readonly ProcessGroupCheckpoint[]
    readonly parkInstead?: boolean
  } = {},
): RunState {
  const snapshot = harness.snapshot()
  const ticket = snapshot.tickets[0]!
  const baseSha = `sha1:${execFileSync('git', ['-C', harness.repo.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}`
  const baseTreeOid = `sha1:${execFileSync('git', ['-C', harness.repo.root, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()}`
  const workAttemptId = 'wa-w1-t1'
  const branch = `norn/run-crafted/1/${workAttemptId}`
  const crafted = harness.craftRunningState([...(init.processes ?? [])])
  const wave = {
    number: 1,
    mapRevision: snapshot.mapRevision,
    target: { branch: 'main', baseSha, baseTreeOid },
    frontierTicketIssueIds: [ticket.ref.issueId],
    shipQueueTicketIssueIds: [],
    nextShipIndex: 0,
  }
  const attemptRecord = {
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
      kind: 'ticket' as const,
      repositoryId: crafted.map.repositoryId,
      runId: 'run-crafted',
      path: join(harness.repositoryHome, 'runs', 'run-crafted', 'workspaces', '1', workAttemptId),
      branch,
      workAttemptId,
    },
    round: 0,
    slot: 'reserved' as const,
    processGroupIds: (init.processes ?? []).map((group) => group.id),
  }
  const state: RunState = {
    ...crafted,
    wave: 1,
    activeWave: wave,
    tickets: {
      [ticket.ref.issueId]: init.parkInstead
        ? {
            phase: 'parked' as const,
            wave: 1,
            outcome: {
              kind: 'blocked' as const,
              code: 'worker-block',
              reason: 'crafted parked attempt',
              evidence: [],
            },
          }
        : { phase: 'working' as const, wave: 1, attempt: attemptRecord },
    },
    ...(init.parkInstead ? { parkedTickets: [ticket.ref] } : {}),
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
      repositoryId: 'R_kgDOMAP',
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

// ---------------------------------------------------------------------------
// The executor gate (§13.2)
// ---------------------------------------------------------------------------

describe('resume executor gate (§13.2)', () => {
  it('refuses a resumed state recorded by a different Norn version, never mixing executors', async () => {
    const harness = await makeRunHarness({ label: 'gate-version', members: [ticketA()] })
    try {
      const crafted = harness.craftRunningState()
      const modified: RunState = { ...crafted, nornVersion: '0.0.0-not-this' }
      const saved = saveRunState(harness.repositoryHome, ENCODED_MAP, modified)
      assert.equal(saved.kind, 'ok')

      const attempt = await runOnce(harness)
      assert.ok('outcome' in attempt)
      const refusal = attempt.outcome
      assert.equal(refusal.kind, 'blocked')
      assert.ok(
        JSON.stringify(refusal.evidence).includes('state-not-resumable'),
        'the refusal names the resumability finding',
      )

      // The persisted state is untouched and still running: no mixed executor.
      const state = harness.runState()!
      assert.equal(state.status, 'running')
      assert.equal(state.runId, 'run-crafted')
      assert.equal(state.nornVersion, '0.0.0-not-this')
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Settlement ordering (§13.2, §16): settlement precedes every other step
// ---------------------------------------------------------------------------

describe('resume reconciliation ordering (§13.2, §16)', () => {
  it('settles every live recorded group — by wait or by termination — before any workspace inspection or slot release', async () => {
    const harness = await makeRunHarness({ label: 'order-settle', members: [ticketA()] })
    try {
      const events: string[] = []
      craftWorkingAttempt(harness, {
        processes: [
          craftProcessGroup(harness, { id: 'pg-live', handle: 'h-live' }),
          craftProcessGroup(harness, { id: 'pg-slow', handle: 'h-slow', state: 'running' }),
        ],
      })

      const outcome = await runToCompletion(harness, {
        record: events,
        runnerScript: {
          liveHandles: new Set(['h-live', 'h-slow']),
          timeoutHandles: new Set(['h-slow']),
          waitForExit: 'exited',
          terminate: 'terminated',
        },
      })
      assert.equal(outcome.kind, 'ok')

      // Both reconciliation modes ran — reattach-and-wait for one group,
      // terminate-and-settle for the other — and both happened FIRST:
      // before the first git operation of the resumed attempt (workspace
      // recreation and inspection alike) and before any slot changed hands.
      const waitedAt = events.indexOf('wait:h-live')
      const terminatedAt = events.indexOf('terminate:h-slow')
      assert.ok(waitedAt !== -1, 'one live group was reattached and waited for')
      assert.ok(terminatedAt !== -1, 'the timed-out group was terminated and settled')
      const firstGit = events.findIndex((entry) => entry.startsWith('git:'))
      assert.ok(firstGit !== -1, 'the resumed attempt used its workspace')
      assert.ok(waitedAt < firstGit && terminatedAt < firstGit, 'settlement precedes every workspace inspection')
      assert.ok(
        !events.some((entry) => entry.startsWith('release:')),
        'no slot was released for the still-working attempt',
      )

      const state = harness.runState()!
      assert.equal(state.status, 'terminal')
      assert.equal(state.report?.label, 'passed')
    } finally {
      harness.cleanup()
    }
  })

  it('releases a stale reservation only after settlement is persisted, and never touches other live runs', async () => {
    const harness = await makeRunHarness({ label: 'order-release', members: [ticketA()] })
    try {
      const events: string[] = []
      craftWorkingAttempt(harness, {
        parkInstead: true,
        processes: [craftProcessGroup(harness, { id: 'pg-live', handle: 'h-live' })],
      })
      // The crash skipped the parked attempt's slot release; another run's
      // reservation is charged alongside it.
      const reserved = await reserveWorkSlot(
        harness.repositoryHome,
        { runId: 'run-crafted', encodedMapIssueId: ENCODED_MAP, workAttemptId: 'wa-w1-t1' },
        4,
      )
      assert.equal(reserved.kind, 'ok')
      const foreign = await reserveWorkSlot(
        harness.repositoryHome,
        { runId: 'run-other', encodedMapIssueId: 'I_other-map', workAttemptId: 'wa-other' },
        4,
      )
      assert.equal(foreign.kind, 'ok')

      const outcome = await runToCompletion(harness, {
        record: events,
        runnerScript: {
          liveHandles: new Set(['h-live']),
          waitForExit: 'exited',
          terminate: 'terminated',
        },
      })
      assert.equal(outcome.kind, 'blocked')
      assert.equal(outcome.code, 'no-eligible-frontier')

      // Settlement preceded the stale release; the release followed it.
      const settledAt = events.indexOf('wait:h-live')
      const releasedAt = events.indexOf('release:wa-w1-t1')
      assert.ok(settledAt !== -1 && releasedAt !== -1)
      assert.ok(settledAt < releasedAt, 'the stale release follows the persisted settlement')

      // The parked attempt's workspace was never inspected. The other run's
      // reservation has no Run State at all — no matching recorded attempt,
      // no recorded process groups — so §16 permits its release once this
      // run's settlement ordering is proven. (A foreign reservation that
      // DOES match a recorded working attempt stays charged — covered by the
      // cross-map slot tests.)
      assert.ok(
        !events.some((entry) => entry.startsWith('git:')),
        'no workspace of the parked attempt was inspected',
      )
      assert.deepEqual(reservedIds(harness), [])

      const state = harness.runState()!
      assert.equal(state.activeProcesses[0]?.state, 'settled')
    } finally {
      harness.cleanup()
    }
  })

  it('keeps the slot charged and stops before any workspace step when termination cannot be proven', async () => {
    const harness = await makeRunHarness({ label: 'order-terminate', members: [ticketA()] })
    try {
      const events: string[] = []
      craftWorkingAttempt(harness, {
        processes: [craftProcessGroup(harness, { id: 'pg-stuck', handle: 'h-stuck', state: 'running' })],
      })
      const reserved = await reserveWorkSlot(
        harness.repositoryHome,
        { runId: 'run-crafted', encodedMapIssueId: ENCODED_MAP, workAttemptId: 'wa-w1-t1' },
        4,
      )
      assert.equal(reserved.kind, 'ok')

      const attempt = await runOnce(harness, {
        record: events,
        runnerScript: {
          liveHandles: new Set(['h-stuck']),
          waitForExit: 'timeout',
          terminate: 'terminate-failed',
        },
      })
      assert.ok('outcome' in attempt)
      assert.equal(attempt.outcome.kind, 'error')
      assert.equal(attempt.outcome.code, 'adapter-failure')

      // Nothing else happened: no workspace inspection, no release, the
      // reservation stays charged, and the group is still recorded unsettled.
      assert.ok(!events.some((entry) => entry.startsWith('git:')))
      assert.ok(!events.some((entry) => entry.startsWith('release:')))
      assert.deepEqual(reservedIds(harness), ['wa-w1-t1'])
      const state = harness.runState()!
      assert.equal(state.activeProcesses[0]?.state, 'running')
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Work-phase fault injection
// ---------------------------------------------------------------------------

describe('work-phase fault injection', () => {
  it('converges after a death between the attempt record and the workspace creation', async () => {
    const label = 'work-attempt-recorded'
    const members = [ticketA({ worker: FILE_BEHAVIOR })]
    const reference = await referenceOutcome({ label: `${label}-ref`, members })

    const harness = await makeRunHarness({ label, members })
    try {
      const wraps: ScenarioWraps = {
        fault: {
          label,
          seam: 'work-git',
          armed: { fired: false },
          // The attempt-owned branch creation inside workspace creation —
          // the persisted attempt already names branch and workspace.
          match: (detail) => {
            const { args, cwd } = detail as { args: readonly string[]; cwd: string }
            return args[0] === 'branch' && cwd === harness.repo.root
          },
        },
      }
      const died = await runOnce(harness, wraps)
      assert.ok('died' in died, 'the coordinator died at the workspace creation')

      const state = harness.runState()!
      assert.equal(state.status, 'running')
      assert.equal(state.tickets.I_A!.phase, 'working')

      const outcome = await runToCompletion(harness, wraps)
      assert.equal(outcome.kind, 'ok')
      // The same run ID resumed and recreated its workspace from the
      // attempt-owned branch.
      assert.equal(harness.runState()!.runId, 'run-1')
      assertConverged(reference, safeOutcomeOf(harness, outcome), label)
    } finally {
      harness.cleanup()
    }
  })

  it('converges after a death mid-round, resuming from the persisted round counter', async () => {
    const label = 'work-mid-round'
    const members = [ticketA()]
    const reference = await referenceOutcome({ label: `${label}-ref`, members })

    const harness = await makeRunHarness({ label, members })
    try {
      let commandCalls = 0
      const wraps: ScenarioWraps = {
        fault: {
          label,
          seam: 'command',
          armed: { fired: false },
          // The round-1 test list: the worker settled and the persisted
          // round counter reads 1, but nothing is sealed yet.
          match: () => {
            commandCalls += 1
            return commandCalls === 1
          },
        },
      }
      const died = await runOnce(harness, wraps)
      assert.ok('died' in died)

      let state = harness.runState()!
      assert.equal(state.status, 'running')
      const working = state.tickets.I_A!
      assert.ok(working.phase === 'working')
      assert.equal(working.phase === 'working' ? working.attempt.round : 0, 1)

      const outcome = await runToCompletion(harness, wraps)
      assert.equal(outcome.kind, 'ok')

      // The resumed attempt continued from its persisted round and sealed a
      // change in its remaining round: the same safe delivery established.
      state = harness.runState()!
      assert.equal(state.runId, 'run-1')
      assertConverged(reference, safeOutcomeOf(harness, outcome), label)
    } finally {
      harness.cleanup()
    }
  })

  it('converges to a byte-identical delivery when the resumed round reworks a zero-delta candidate', async () => {
    const label = 'work-mid-round-zero'
    const members = [ticketA({ worker: { kind: 'zero-delta' } })]
    const reference = await referenceOutcome({ label: `${label}-ref`, members })

    const harness = await makeRunHarness({ label, members })
    try {
      let commandCalls = 0
      const wraps: ScenarioWraps = {
        fault: {
          label,
          seam: 'command',
          armed: { fired: false },
          match: () => {
            commandCalls += 1
            return commandCalls === 1
          },
        },
      }
      const died = await runOnce(harness, wraps)
      assert.ok('died' in died)
      const outcome = await runToCompletion(harness, wraps)
      assert.equal(outcome.kind, 'ok')
      assertConverged(reference, safeOutcomeOf(harness, outcome), label)
      // Zero-delta delivery: the remote target never gained a commit in
      // either world, and both runs completed the same ticket.
      assert.equal(harness.remoteLog().length, reference.remoteLog.length)
    } finally {
      harness.cleanup()
    }
  })

  it('converges after a death at the wave barrier, building the ship queue on resume', async () => {
    const label = 'work-barrier'
    const members = [ticketA({ worker: FILE_BEHAVIOR })]
    const reference = await referenceOutcome({ label: `${label}-ref`, members })

    const harness = await makeRunHarness({ label, members })
    try {
      const wraps: ScenarioWraps = {
        fault: {
          label,
          seam: 'map-read',
          armed: { fired: false },
          // The barrier's stable read, after the work reviewer settled and
          // before the ship queue persisted.
          match: () => harness.store.observed.workReviewerLaunches >= 1,
        },
      }
      const died = await runOnce(harness, wraps)
      assert.ok('died' in died)

      const state = harness.runState()!
      assert.equal(state.status, 'running')
      assert.equal(state.tickets.I_A!.phase, 'shippable')
      assert.deepEqual(state.activeWave?.shipQueueTicketIssueIds, [])

      const outcome = await runToCompletion(harness, wraps)
      assert.equal(outcome.kind, 'ok')
      assertConverged(reference, safeOutcomeOf(harness, outcome), label)
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Ship fault injection (§13.3)
// ---------------------------------------------------------------------------

describe('ship fault injection (§13.3)', () => {
  it('treats a death around the push call as a consumed attempt and pushes once on resume', async () => {
    const label = 'ship-push-crash'
    const members = [ticketA({ worker: FILE_BEHAVIOR })]
    const reference = await referenceOutcome({ label: `${label}-ref`, members })

    const harness = await makeRunHarness({ label, members })
    try {
      const events: string[] = []
      const wraps: ScenarioWraps = {
        record: events,
        pushPlan: (call) => (call === 1 ? 'die' : 'delegate'),
        pushState: { count: 0 },
      }
      const died = await runOnce(harness, wraps)
      assert.ok('died' in died)

      // The attempt counter was persisted before the call: one attempt is
      // conservatively consumed while the integration is provably absent.
      const state = harness.runState()!
      assert.equal(state.status, 'running')
      const shipping = state.tickets.I_A!
      assert.ok(shipping.phase === 'shipping')
      assert.equal(shipping.phase === 'shipping' ? shipping.checkpoint.pushAttempts : 0, 1)
      assert.equal(shipping.phase === 'shipping' ? shipping.checkpoint.stage : '', 'prepared')

      const outcome = await runToCompletion(harness, wraps)
      assert.equal(outcome.kind, 'ok')
      assertConverged(reference, safeOutcomeOf(harness, outcome), label)

      // Probes were free; the resumed invocation performed exactly one push.
      assert.equal(events.filter((entry) => entry.startsWith('push:')).length, 1)
      assert.equal(harness.runState()!.runId, 'run-1')
    } finally {
      harness.cleanup()
    }
  })

  it('delivers from a free remote probe after a death post-verification, without a second push', async () => {
    const label = 'ship-verified-crash'
    const members = [ticketA({ worker: FILE_BEHAVIOR })]
    const reference = await referenceOutcome({ label: `${label}-ref`, members })

    const harness = await makeRunHarness({ label, members })
    try {
      const events: string[] = []
      const wraps: ScenarioWraps = {
        record: events,
        fault: {
          label,
          seam: 'comment',
          armed: { fired: false },
          // The Delivery Record comment write of ticket #1 — after the push
          // was remotely verified.
          match: (detail) => (detail as { number: number }).number === 1,
        },
      }
      const died = await runOnce(harness, wraps)
      assert.ok('died' in died)

      const state = harness.runState()!
      assert.equal(state.status, 'running')
      const shipping = state.tickets.I_A!
      assert.equal(shipping.phase === 'shipping' ? shipping.checkpoint.stage : '', 'push-verified')
      assert.equal(harness.remoteLog().length, 2) // the integration landed

      const outcome = await runToCompletion(harness, wraps)
      assert.equal(outcome.kind, 'ok')
      assertConverged(reference, safeOutcomeOf(harness, outcome), label)

      // The resumed invocation pushed nothing: the recorded integration
      // shape was proved present by free probes alone (§13.3 step 1).
      assert.equal(events.filter((entry) => entry.startsWith('push:')).length, 1)
      assert.equal(harness.store.observed.pushes, 1)
      assert.equal(ticketPhaseOf(harness, 'I_A'), 'completed')
    } finally {
      harness.cleanup()
    }
  })

  it('writes the record exactly once and closes after a death at the close call', async () => {
    const label = 'ship-recorded-crash'
    const members = [ticketA({ worker: FILE_BEHAVIOR })]
    const reference = await referenceOutcome({ label: `${label}-ref`, members })

    const harness = await makeRunHarness({ label, members })
    try {
      const wraps: ScenarioWraps = {
        fault: {
          label,
          seam: 'close',
          armed: { fired: false },
          match: (detail) => (detail as { number: number }).number === 1,
        },
      }
      const died = await runOnce(harness, wraps)
      assert.ok('died' in died)

      const state = harness.runState()!
      const shipping = state.tickets.I_A!
      assert.equal(shipping.phase === 'shipping' ? shipping.checkpoint.stage : '', 'delivery-recorded')
      assert.equal(harness.store.issues.get(1)!.state, 'OPEN')
      assert.equal(harness.store.issues.get(1)!.comments.length, 1)

      const outcome = await runToCompletion(harness, wraps)
      assert.equal(outcome.kind, 'ok')
      assertConverged(reference, safeOutcomeOf(harness, outcome), label)

      // The record was reused, never duplicated; the close happened once.
      assert.equal(harness.store.issues.get(1)!.comments.length, 1)
      assert.equal(harness.store.observed.closeCalls, 1)
      assert.equal(harness.runState()!.runId, 'run-1')
    } finally {
      harness.cleanup()
    }
  })

  it('performs the full post-close validation after a death between close and completion', async () => {
    const label = 'ship-closed-crash'
    const members = [ticketA({ worker: FILE_BEHAVIOR })]
    const reference = await referenceOutcome({ label: `${label}-ref`, members })

    const harness = await makeRunHarness({ label, members })
    try {
      const wraps: ScenarioWraps = {
        fault: {
          label,
          seam: 'evidence-read',
          armed: { fired: false },
          // The post-close evidence read of ticket #1, after its close.
          match: (detail) =>
            (detail as { number: number }).number === 1 &&
            harness.store.observed.closeCalls >= 1,
        },
      }
      const died = await runOnce(harness, wraps)
      assert.ok('died' in died)

      const state = harness.runState()!
      const shipping = state.tickets.I_A!
      assert.equal(shipping.phase === 'shipping' ? shipping.checkpoint.stage : '', 'ticket-closed')
      assert.equal(harness.store.issues.get(1)!.state, 'CLOSED')
      assert.equal(ticketPhaseOf(harness, 'I_A'), 'shipping') // not yet completed

      const outcome = await runToCompletion(harness, wraps)
      assert.equal(outcome.kind, 'ok')
      assertConverged(reference, safeOutcomeOf(harness, outcome), label)

      // The ticket was closed exactly once: the resume took the skip-close
      // window and validated §14 from fresh remote reads (§13.3 step 5).
      assert.equal(harness.store.observed.closeCalls, 1)
      assert.equal(ticketPhaseOf(harness, 'I_A'), 'completed')
    } finally {
      harness.cleanup()
    }
  })

  it('parks with the exhausted budget after a death, converging with the exhausted reference', async () => {
    const label = 'ship-exhausted-crash'
    const members = [ticketA({ worker: FILE_BEHAVIOR })]
    // The reference never dies but loses optimistic concurrency until the
    // persisted budget is spent: it parks exactly as the recovered run must.
    const reference = await referenceOutcome(
      { label: `${label}-ref`, members },
      { pushPlan: () => 'advance-then-delegate', pushState: { count: 0 } },
    )
    assert.equal(reference.label, 'blocked')
    assert.equal(reference.code, 'no-eligible-frontier')
    assert.equal(reference.tickets[0]?.state, 'parked')
    assert.equal(reference.tickets[0]?.code, 'target-advanced')

    const harness = await makeRunHarness({ label, members })
    try {
      const wraps: ScenarioWraps = {
        pushPlan: (call) => (call === 2 ? 'advance-then-die' : 'advance-then-delegate'),
        pushState: { count: 0 },
      }
      const died = await runOnce(harness, wraps)
      assert.ok('died' in died)

      // Two attempts persisted, the integration provably absent, the target
      // moved: the resume must park rather than guess or over-retry.
      const state = harness.runState()!
      const shipping = state.tickets.I_A!
      assert.ok(shipping.phase === 'shipping')
      assert.equal(shipping.phase === 'shipping' ? shipping.checkpoint.pushAttempts : 0, 2)
      assert.equal(state.status, 'running')

      const outcome = await runToCompletion(harness, wraps)
      assert.equal(outcome.kind, 'blocked')
      assertConverged(reference, safeOutcomeOf(harness, outcome), label)
      assert.equal(harness.store.observed.pushes, 0)
    } finally {
      harness.cleanup()
    }
  })

  it('leaves the run recoverable after an unknown record write, then converges', async () => {
    const label = 'ship-unknown-write'
    const members = [ticketA({ worker: FILE_BEHAVIOR }), ticketB({ worker: FILE_BEHAVIOR })]
    const reference = await referenceOutcome({ label: `${label}-ref`, members })

    const harness = await makeRunHarness({ label, members })
    try {
      // After ticket #1 closes, every later record write returns an unknown
      // result: a recoverable interruption after a confirmed shared write.
      harness.store.changes.push({
        when: (observed) => observed.closeCalls >= 1,
        apply: (store) => {
          store.script.writeCommentFails = 'scripted unknown comment result'
        },
      })

      const first = await runOnce(harness)
      assert.ok('outcome' in first)
      assert.equal(first.outcome.kind, 'error')
      assert.equal(first.outcome.code, 'comment-write')
      assert.equal(first.outcome.sharedWrite, 'unknown')

      // Recoverable: the same run ID, queue, and persisted counters remain.
      const interrupted = harness.runState()!
      assert.equal(interrupted.status, 'running')
      assert.equal(interrupted.runId, 'run-1')

      harness.store.script.writeCommentFails = undefined
      const outcome = await runToCompletion(harness, {})
      assert.equal(outcome.kind, 'ok')
      assertConverged(reference, safeOutcomeOf(harness, outcome), label)
      assert.equal(harness.runState()!.runId, 'run-1')
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Map-completion fault injection (§13.4)
// ---------------------------------------------------------------------------

describe('map-completion fault injection (§13.4)', () => {
  it('retries the close from the persisted gated checkpoint without re-running any gate', async () => {
    const label = 'completion-gated-crash'
    const members = [ticketA({ worker: FILE_BEHAVIOR })]
    const reference = await referenceOutcome({ label: `${label}-ref`, members })

    const harness = await makeRunHarness({ label, members })
    try {
      const wraps: ScenarioWraps = {
        fault: {
          label,
          seam: 'close',
          armed: { fired: false },
          match: (detail) => (detail as { number: number }).number === MAP_NUMBER,
        },
      }
      const died = await runOnce(harness, wraps)
      assert.ok('died' in died)

      const state = harness.runState()!
      assert.equal(state.status, 'running')
      assert.equal(state.mapCompletion?.stage, 'gated')
      assert.equal(harness.store.issues.get(MAP_NUMBER)!.state, 'OPEN')
      const gateRuns = harness.store.observed.completionReviewerLaunches

      const outcome = await runToCompletion(harness, wraps)
      assert.equal(outcome.kind, 'ok')
      assertConverged(reference, safeOutcomeOf(harness, outcome), label)

      // The resume closed from the persisted gates: no fresh completion
      // gates ran and the map closed exactly once.
      assert.equal(harness.store.observed.completionReviewerLaunches, gateRuns)
      assert.equal(harness.store.observed.mapCloseCalls, 1)
      assert.equal(harness.runState()!.runId, 'run-1')
    } finally {
      harness.cleanup()
    }
  })

  it('binds a close the crash interrupted before confirmation, without reclosing', async () => {
    const label = 'completion-close-crash'
    const members = [ticketA({ worker: FILE_BEHAVIOR })]
    const reference = await referenceOutcome({ label: `${label}-ref`, members })

    const harness = await makeRunHarness({ label, members })
    try {
      const wraps: ScenarioWraps = {
        fault: {
          label,
          seam: 'evidence-read',
          armed: { fired: false },
          // The close-window evidence read of the map issue, after its close
          // succeeded but before the checkpoint confirmed it.
          match: (detail) =>
            (detail as { number: number }).number === MAP_NUMBER &&
            harness.store.observed.mapCloseCalls >= 1,
        },
      }
      const died = await runOnce(harness, wraps)
      assert.ok('died' in died)

      const state = harness.runState()!
      assert.equal(state.status, 'running')
      assert.equal(state.mapCompletion?.stage, 'gated')
      assert.equal(state.mapCompletion?.closingEventId, undefined)
      assert.equal(harness.store.issues.get(MAP_NUMBER)!.state, 'CLOSED')

      const outcome = await runToCompletion(harness, wraps)
      assert.equal(outcome.kind, 'ok')
      assertConverged(reference, safeOutcomeOf(harness, outcome), label)

      // The close bound through the actor's first close after the anchor;
      // the map was never closed twice.
      assert.equal(harness.store.observed.mapCloseCalls, 1)
      assert.equal(harness.runState()!.status, 'terminal')
    } finally {
      harness.cleanup()
    }
  })

  it('writes the sealed record verbatim after a death at the record write', async () => {
    const label = 'completion-record-crash'
    const members = [ticketA({ worker: FILE_BEHAVIOR })]
    const reference = await referenceOutcome({ label: `${label}-ref`, members })

    const harness = await makeRunHarness({ label, members })
    try {
      const wraps: ScenarioWraps = {
        fault: {
          label,
          seam: 'comment',
          armed: { fired: false },
          match: (detail) => (detail as { number: number }).number === MAP_NUMBER,
        },
      }
      const died = await runOnce(harness, wraps)
      assert.ok('died' in died)

      const state = harness.runState()!
      assert.equal(state.status, 'running')
      assert.equal(state.mapCompletion?.stage, 'map-closed')
      assert.ok(
        state.mapCompletion?.record !== undefined,
        'the sealed record was persisted before the write',
      )
      assert.equal(harness.store.issues.get(MAP_NUMBER)!.comments.length, 0)

      const outcome = await runToCompletion(harness, wraps)
      assert.equal(outcome.kind, 'ok')
      assertConverged(reference, safeOutcomeOf(harness, outcome), label)

      // One record comment, byte-identical to the sealed one (§15).
      assert.equal(harness.store.issues.get(MAP_NUMBER)!.comments.length, 1)
      assert.equal(harness.runState()!.status, 'terminal')
    } finally {
      harness.cleanup()
    }
  })

  it('terminalizes from the validating record — never from the checkpoint stage alone', async () => {
    const label = 'completion-recorded-crash'
    const members = [ticketA({ worker: FILE_BEHAVIOR })]
    const reference = await referenceOutcome({ label: `${label}-ref`, members })

    const harness = await makeRunHarness({ label, members })
    try {
      const wraps: ScenarioWraps = {
        fault: {
          label,
          seam: 'evidence-read',
          armed: { fired: false },
          // The final-validation evidence read of the map, after the record
          // comment was written and confirmed.
          match: (detail) =>
            (detail as { number: number }).number === MAP_NUMBER &&
            harness.store.observed.mapCommentCalls >= 1,
        },
      }
      const died = await runOnce(harness, wraps)
      assert.ok('died' in died)

      const state = harness.runState()!
      assert.equal(state.status, 'running')
      assert.equal(state.mapCompletion?.stage, 'recorded')
      assert.equal(harness.store.issues.get(MAP_NUMBER)!.comments.length, 1)
      const gateRuns = harness.store.observed.completionReviewerLaunches

      const outcome = await runToCompletion(harness, wraps)
      assert.equal(outcome.kind, 'ok')
      assertConverged(reference, safeOutcomeOf(harness, outcome), label)
      assert.equal(harness.store.observed.completionReviewerLaunches, gateRuns)
      assert.equal(harness.store.observed.mapCommentCalls, 1)
      assert.equal(harness.runState()!.status, 'terminal')

      // The decisive proof is remote, not the persisted stage: delete the
      // record comment after the same death and recovery re-writes it
      // instead of trusting the `recorded` checkpoint.
      const replay = await makeRunHarness({ label: `${label}-replay`, members })
      try {
        const wraps2: ScenarioWraps = {
          fault: {
            label,
            seam: 'evidence-read',
            armed: { fired: false },
            match: (detail) =>
              (detail as { number: number }).number === MAP_NUMBER &&
              replay.store.observed.mapCommentCalls >= 1,
          },
        }
        const died2 = await runOnce(replay, wraps2)
        assert.ok('died' in died2)
        const map = replay.store.issues.get(MAP_NUMBER)!
        assert.equal(map.comments.length, 1)
        // The operator removes the record comment after the crash.
        const removed = map.comments.pop()!
        map.timeline = map.timeline.filter(
          (event) => !(event.kind === 'commented' && event.commentId === removed.commentId),
        )
        const recovered = await runToCompletion(replay, wraps2)
        assert.equal(recovered.kind, 'ok')
        assert.equal(replay.store.issues.get(MAP_NUMBER)!.comments.length, 1)
        assertConverged(reference, safeOutcomeOf(replay, recovered), `${label} (deleted record)`)
      } finally {
        replay.cleanup()
      }
    } finally {
      harness.cleanup()
    }
  })

  it('discards the gates and restarts full completion after an operator reopen, never silently reclosing', async () => {
    const label = 'completion-reopen-crash'
    const members = [ticketA({ worker: FILE_BEHAVIOR })]
    const reference = await referenceOutcome({ label: `${label}-ref`, members })

    const harness = await makeRunHarness({ label, members })
    try {
      const wraps: ScenarioWraps = {
        fault: {
          label,
          seam: 'evidence-read',
          armed: { fired: false },
          match: (detail) =>
            (detail as { number: number }).number === MAP_NUMBER &&
            harness.store.observed.mapCloseCalls >= 1,
        },
      }
      const died = await runOnce(harness, wraps)
      assert.ok('died' in died)

      // The operator reopens the closed map while the coordinator is down.
      const map = harness.store.issues.get(MAP_NUMBER)!
      map.state = 'OPEN'
      map.timeline.push({ kind: 'reopened', eventId: 'E-operator', actorId: 'I_actor' })
      const gateRuns = harness.store.observed.completionReviewerLaunches

      const outcome = await runToCompletion(harness, wraps)
      assert.equal(outcome.kind, 'ok')
      assertConverged(reference, safeOutcomeOf(harness, outcome), label)

      // The detected close-then-reopen discarded the old gates: a fresh
      // completion attempt ran against the current facts.
      assert.ok(
        harness.store.observed.completionReviewerLaunches > gateRuns,
        'full completion gates re-ran after the reopen',
      )
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Resume snapshot classification (§13.2)
// ---------------------------------------------------------------------------

describe('resume snapshot classification (§13.2)', () => {
  it('settles the recorded processes, then terminates the run on an incompatible change', async () => {
    const harness = await makeRunHarness({ label: 'resume-incompatible', members: [ticketA()] })
    try {
      const events: string[] = []
      craftWorkingAttempt(harness, {
        processes: [craftProcessGroup(harness, { id: 'pg-live', handle: 'h-live' })],
      })
      // While the coordinator is down, the accepted member's specification
      // changes incompatibly.
      harness.store.editMember('I_A', { title: 'Edited while down' })

      const outcome = await runToCompletion(harness, {
        record: events,
        runnerScript: {
          liveHandles: new Set(['h-live']),
          waitForExit: 'exited',
          terminate: 'terminated',
        },
      })
      assert.equal(outcome.kind, 'blocked')
      assert.equal(outcome.code, 'changed-input')

      // Settlement happened first and is persisted; only then did the run
      // terminalize blocked against the incompatible snapshot.
      assert.ok(events.indexOf('wait:h-live') !== -1)
      const state = harness.runState()!
      assert.equal(state.status, 'terminal')
      assert.equal(state.activeProcesses[0]?.state, 'settled')
      assert.equal(state.report?.label, 'blocked')
      assert.equal(state.report?.code, 'changed-input')
    } finally {
      harness.cleanup()
    }
  })

  it('adopts a Compatible Map Extension observed between death and resume', async () => {
    const label = 'resume-extension'
    const reference = await referenceOutcome({
      label: `${label}-ref`,
      members: [ticketA({ worker: FILE_BEHAVIOR }), ticket9()],
    })

    const harness = await makeRunHarness({ label, members: [ticketA({ worker: FILE_BEHAVIOR })] })
    try {
      const wraps: ScenarioWraps = {
        fault: {
          label,
          seam: 'map-read',
          armed: { fired: false },
          match: () => harness.store.observed.workReviewerLaunches >= 1,
        },
      }
      const died = await runOnce(harness, wraps)
      assert.ok('died' in died)

      // While the coordinator is down, the map grows a new direct member.
      harness.store.addMember(ticket9())

      const outcome = await runToCompletion(harness, wraps)
      assert.equal(outcome.kind, 'ok')
      assertConverged(reference, safeOutcomeOf(harness, outcome), label)

      const state = harness.runState()!
      assert.equal(state.runId, 'run-1')
      assert.equal(state.acceptedMapRevisions.length, 2)
      assert.deepEqual(state.acceptedMapRevisions[1]?.extension?.addedTicketIssueIds, ['I_9'])
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Total local state loss (§13.3)
// ---------------------------------------------------------------------------

describe('total local state loss (§13.3)', () => {
  it('gives a still-open Ticket fresh Work and converges on the same delivery', async () => {
    const label = 'state-loss-open'
    const members = [ticketA({ worker: FILE_BEHAVIOR })]
    const reference = await referenceOutcome({ label: `${label}-ref`, members })

    const harness = await makeRunHarness({ label, members })
    try {
      // Crash after the push was verified but before any GitHub write: the
      // Ticket stays OPEN with its commit on the target.
      const wraps: ScenarioWraps = {
        fault: {
          label,
          seam: 'comment',
          armed: { fired: false },
          match: (detail) => (detail as { number: number }).number === 1,
        },
      }
      const died = await runOnce(harness, wraps)
      assert.ok('died' in died)
      assert.equal(harness.store.issues.get(1)!.state, 'OPEN')
      assert.equal(harness.remoteLog().length, 2)
      const deliveredSha = harness.remoteMainSha()

      // The entire local state directory is lost: run state, run-owned
      // workspaces, the slot registry, and every lock.
      rmSync(join(harness.repositoryHome, 'maps'), { recursive: true, force: true })
      rmSync(join(harness.repositoryHome, 'runs'), { recursive: true, force: true })
      rmSync(join(harness.repositoryHome, 'locks'), { recursive: true, force: true })

      // With no local state, only fresh Work may take the still-open Ticket
      // to delivery — here a fresh zero-delta test and review over the
      // already-delivered target (§13.3).
      harness.store.behaviors.I_A = { kind: 'zero-delta' }
      const attempt = await runOnce(harness)
      assert.ok('outcome' in attempt)
      assert.equal(attempt.outcome.kind, 'ok')

      // Fresh Work on the still-open Ticket re-derived the same delivered
      // tree: the target neither moved nor needed a second commit, and the
      // run passed under a new run ID.
      const state = harness.runState()!
      assert.equal(state.runId, 'run-2')
      assert.equal(harness.remoteMainSha(), deliveredSha)
      assertConverged(reference, safeOutcomeOf(harness, attempt.outcome), label)
    } finally {
      harness.cleanup()
    }
  })

  it('integrity-blocks a closed Ticket without valid remote delivery evidence', async () => {
    const harness = await makeRunHarness({ label: 'state-loss-closed', members: [ticketA()] })
    try {
      // A closed member with no Delivery Record: preflight blocks it rather
      // than letting fresh Work silently take credit (§13.3, §14).
      harness.store.issues.get(1)!.state = 'CLOSED'

      const attempt = await runOnce(harness)
      assert.ok('outcome' in attempt)
      assert.equal(attempt.outcome.kind, 'blocked')
      assert.equal(attempt.outcome.code, 'check-findings')
      assert.ok(
        JSON.stringify(attempt.outcome.evidence).includes('delivery-evidence'),
        'the finding names the invalid delivery evidence',
      )

      // No run was created, nothing was worked, nothing shipped.
      assert.equal(harness.runState(), undefined)
      assert.equal(harness.store.observed.workerLaunches, 0)
      assert.equal(harness.store.observed.pushes, 0)
      assert.equal(harness.remoteLog().length, 1)
    } finally {
      harness.cleanup()
    }
  })
})
