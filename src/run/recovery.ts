/**
 * Recovery and resume — the §13.2 entry (design.md §13.2–§13.4, ticket #15).
 *
 * When Run State remains `running` because the coordinator exited
 * unexpectedly or `run` returned a recoverable shared-write error, the next
 * compatible invocation resumes the *same* run ID with its parked set,
 * accepted revision lineage, exact persisted Wave queue, and persisted retry
 * counters. This module owns the ordered resume reconciliation that precedes
 * every other step of a resumed coordinator:
 *
 * ```text
 * the executor gate (§13.2): the persisted configRevision and Norn version
 * must equal this invocation's — a mismatch refuses, it never mixes evidence
 * produced by different executors (the same gate runs in preflight, §2.3)
 *     ↓
 * process-group reconciliation FIRST (§13.2, §16, §17): every recorded,
 * not-yet-settled group is reattached and waited for, or terminated and
 * settled, and the settlement is persisted — before any workspace is
 * inspected, any Work attempt resumes, and any Work slot changes hands
 *     ↓
 * stale-reservation reconciliation (§8, §16): only now may recovery release
 * a Work-slot reservation of this run whose attempt is no longer `working`;
 * the release itself re-proves settlement from the persisted checkpoints,
 * so a group that is still live keeps its slot charged
 *     ↓
 * the wave loop reloads a stable Map snapshot and classifies it against the
 * accepted lineage (§7.4, §12): an identical revision continues; a Compatible
 * Map Extension is appended atomically under the repository control lock; an
 * incompatible change — arriving only after settlement — terminates the run
 * `blocked(changed-input)`. A CLOSED Map with a pending map-completion
 * checkpoint routes through the §13.4 recovery reconciliation before the
 * ordinary OPEN-state planning rule applies; a persisted Ship queue routes
 * through the §13.3 reconciliation of `src/ship/` (free remote probes against
 * the recorded integration shape; pushes consume the persisted attempt
 * budget; record write-or-locate; open/closed close windows; unclassifiable
 * remote state is a recoverable error, never a guess).
 * ```
 *
 * The §13.3 ship recovery and §13.4 completion recovery themselves live in
 * `src/ship/push.ts`, `src/ship/close.ts`, and `src/run/completion.ts`, and
 * are driven by `src/run/lifecycle.ts` immediately after this module returns;
 * every decision there re-reads remote truth rather than trusting a
 * checkpoint stage or a timeout.
 */
import { error, ok } from '../core/outcome.ts'
import type { Evidence, Outcome } from '../core/outcome.ts'
import type { VisibleAgentRunner } from '../agents/runner.ts'
import {
  defaultProcessGroupLivenessProbe,
  readWorkSlotRegistry,
  releaseWorkSlot,
} from '../runstate/slot-registry.ts'
import type {
  ProcessGroupLivenessProbe,
  ReleaseOutcome,
} from '../runstate/slot-registry.ts'
import { loadRunState, saveRunState } from '../runstate/run-state-store.ts'
import type { ProcessGroupCheckpoint, RunState } from '../runstate/types.ts'

// ---------------------------------------------------------------------------
// The executor gate (§13.2)
// ---------------------------------------------------------------------------

/** Which executor identity a persisted running state disagrees on. */
export type ResumeMismatch = 'configRevision' | 'nornVersion'

/**
 * The resume executor gate: a persisted `running` state may be resumed only
 * under the same `configRevision` and Norn version that produced its
 * evidence. A mismatch refuses the resume — it never mixes executors (§13.2).
 */
export function resumeExecutorMismatches(
  state: RunState,
  configRevision: string,
  nornVersion: string,
): readonly ResumeMismatch[] {
  const mismatches: ResumeMismatch[] = []
  if (state.configRevision !== configRevision) mismatches.push('configRevision')
  if (state.nornVersion !== nornVersion) mismatches.push('nornVersion')
  return mismatches
}

// ---------------------------------------------------------------------------
// The injected seams
// ---------------------------------------------------------------------------

/** Closed error codes of the resume reconciliation; all run-scoped (§9). */
export type RecoveryErrorCode =
  /** Terminating a recovered process group failed; its slot stays charged. */
  | 'adapter-failure'
  /** Run State persistence during reconciliation failed. */
  | 'control-store'
  /** The persisted Run State or registry contradicts this reconciliation. */
  | 'state-integrity'
  /** The Work-slot registry failed, or refuses an unproven release. */
  | 'slot-registry'

export type RecoveryOutcome = Outcome<RunState, never, RecoveryErrorCode>

/** Everything the §13.2 resume reconciliation needs. */
export type RecoveryDeps = {
  /** The Visible Agent Runner seam: reattach, wait, terminate (§6, §17). */
  readonly runner: VisibleAgentRunner
  readonly repositoryHome: string
  readonly encodedMapIssueId: string
  /** Budget for settling one recovered live process group (§13.2). */
  readonly agentSettleTimeoutMs?: number
  /**
   * Liveness probe for the stale-release settlement proof. The default
   * honors a persisted `settled` checkpoint — settlement is persisted only
   * after reattachment proved exit or termination — and otherwise falls back
   * to the POSIX process-group probe.
   */
  readonly probe?: ProcessGroupLivenessProbe
  /**
   * Overrides the stale-reservation release for tests; the default releases
   * through the repository-wide Work-slot registry (§16).
   */
  readonly releaseReservation?: (
    repositoryHome: string,
    workAttemptId: string,
  ) => Promise<ReleaseOutcome>
}

/**
 * The settlement probe of the resume reconciliation: a checkpoint already
 * persisted `settled` is proof (§16 — settlement persists only after
 * reattach-and-wait or terminate-and-settle proved the group gone); any
 * other recorded state falls back to the OS-level probe.
 */
export function settlementProbe(
  fallback: ProcessGroupLivenessProbe = defaultProcessGroupLivenessProbe,
): ProcessGroupLivenessProbe {
  return (checkpoint) =>
    checkpoint.state === 'settled' ? false : fallback(checkpoint)
}

// ---------------------------------------------------------------------------
// Process-group reconciliation (§13.2, §16, §17) — first, before anything else
// ---------------------------------------------------------------------------

/**
 * Settle every recorded, not-yet-settled process group of the resumed run:
 * reattach through the persisted adapter handle, wait for a live group to
 * exit within the budget, terminate it after the budget, and persist every
 * proven settlement. No workspace is inspected, no Work attempt resumes, and
 * no slot is released before this returns `ok` — the ordering the design
 * demands of recovery (§13.2).
 */
export async function settleRecordedProcessGroups(
  deps: RecoveryDeps,
  state: RunState,
): Promise<RecoveryOutcome> {
  const pending: readonly ProcessGroupCheckpoint[] = state.activeProcesses.filter(
    (group) => group.state !== 'settled',
  )
  if (pending.length === 0) return ok(state)
  const budget = deps.agentSettleTimeoutMs ?? 60_000

  const settledIds: string[] = []
  for (const group of pending) {
    let attached: ReturnType<VisibleAgentRunner['attach']>
    let live: boolean
    try {
      attached = deps.runner.attach(group.adapterHandle)
      live = await deps.runner.isLive(attached)
    } catch (cause) {
      return recoveryError('adapter-failure', describeAdapterFailure(group, cause), [
        { processGroupId: group.id, adapterHandle: group.adapterHandle },
      ])
    }
    if (!live) {
      settledIds.push(group.id)
      continue
    }
    let exit: 'exited' | 'timeout'
    try {
      exit = await deps.runner.waitForExit(attached, budget)
    } catch (cause) {
      return recoveryError('adapter-failure', describeAdapterFailure(group, cause), [
        { processGroupId: group.id, adapterHandle: group.adapterHandle },
      ])
    }
    if (exit === 'exited') {
      settledIds.push(group.id)
      continue
    }
    let termination: 'terminated' | 'terminate-failed'
    try {
      termination = await deps.runner.terminate(attached)
    } catch {
      termination = 'terminate-failed'
    }
    if (termination !== 'terminated') {
      return recoveryError(
        'adapter-failure',
        `terminating the recovered process group ${group.id} failed; its slot stays charged`,
        [{ processGroupId: group.id, adapterHandle: group.adapterHandle }],
      )
    }
    settledIds.push(group.id)
  }

  const loaded = loadRunState(deps.repositoryHome, deps.encodedMapIssueId)
  if (loaded.kind !== 'ok') return loaded
  if (loaded.value === undefined) {
    return recoveryError('control-store', 'the run state to settle vanished during reconciliation', [
      { settledProcessGroupIds: settledIds },
    ])
  }
  const next: RunState = {
    ...loaded.value,
    activeProcesses: loaded.value.activeProcesses.map((group) =>
      group.state === 'settled' ? group : { ...group, state: 'settled' },
    ),
  }
  const saved = saveRunState(deps.repositoryHome, deps.encodedMapIssueId, next)
  if (saved.kind !== 'ok') return saved
  return ok(next)
}

// ---------------------------------------------------------------------------
// Stale-reservation reconciliation (§8, §16) — after settlement is proven
// ---------------------------------------------------------------------------

/** Every work-attempt ID the persisted state still records as `working`. */
function workingAttemptIds(state: RunState): Set<string> {
  const working = new Set<string>()
  for (const ticket of Object.values(state.tickets)) {
    if (ticket.phase === 'working') working.add(ticket.attempt.workAttemptId)
  }
  return working
}

/**
 * Release this run's stale Work-slot reservations: a reservation whose
 * attempt is no longer `working` in the persisted Run State — the outcome of
 * an attempt whose slot release a crash skipped — is released through the
 * registry, whose settlement proof re-reads the recorded process-group
 * checkpoints. Because settlement was persisted first, only a group that is
 * *still* live OS-side can keep the reservation charged, and that refusal is
 * an error, never a silent release (§16). Reservations of other runs are
 * never touched: they remain charged until their own run's reconciliation
 * settles them.
 */
export async function releaseStaleReservations(
  deps: RecoveryDeps,
  state: RunState,
): Promise<RecoveryOutcome> {
  const registry = readWorkSlotRegistry(deps.repositoryHome)
  if (registry.kind !== 'ok') {
    return recoveryError(
      'slot-registry',
      `reading the Work-slot registry during recovery failed: ${registry.reason}`,
      [...registry.evidence],
    )
  }
  if (registry.value === undefined) return ok(state)

  const working = workingAttemptIds(state)
  const stale = registry.value.reserved.filter(
    (reservation) =>
      reservation.runId === state.runId &&
      reservation.encodedMapIssueId === deps.encodedMapIssueId &&
      !working.has(reservation.workAttemptId),
  )
  if (stale.length === 0) return ok(state)

  const release =
    deps.releaseReservation ??
    ((repositoryHome: string, workAttemptId: string) =>
      releaseWorkSlot(repositoryHome, workAttemptId, {
        probe: deps.probe ?? settlementProbe(),
      }))
  const released: string[] = []
  for (const reservation of stale) {
    const outcome = await release(deps.repositoryHome, reservation.workAttemptId)
    if (outcome.kind === 'ok') {
      released.push(reservation.workAttemptId)
      continue
    }
    if (outcome.kind === 'blocked') {
      // `process-groups-live`: the settlement proof refused the release —
      // the reservation stays charged and recovery stops without guessing.
      return recoveryError(
        'slot-registry',
        `the stale reservation of attempt ${reservation.workAttemptId} could not be released: ${outcome.reason}`,
        [
          { workAttemptId: reservation.workAttemptId, code: outcome.code },
          ...('evidence' in outcome ? [...outcome.evidence] : []),
        ],
      )
    }
    return recoveryError(
      'slot-registry',
      `releasing the stale reservation of attempt ${reservation.workAttemptId} failed: ${outcome.reason}`,
      [{ workAttemptId: reservation.workAttemptId }, ...outcome.evidence],
    )
  }
  return ok(state)
}

// ---------------------------------------------------------------------------
// The ordered §13.2 resume reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile one resumed `running` state in the order §13.2 demands: settle
 * every recorded process group and persist the settlements first, then — and
 * only then — release this run's stale Work-slot reservations. The returned
 * state feeds the wave loop, whose stable Map reload classifies identical /
 * Compatible Map Extension / incompatible against the accepted lineage.
 */
export async function reconcileResumedRun(
  deps: RecoveryDeps,
  state: RunState,
): Promise<RecoveryOutcome> {
  const settled = await settleRecordedProcessGroups(deps, state)
  if (settled.kind !== 'ok') return settled
  return releaseStaleReservations(deps, settled.value)
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function recoveryError(
  code: RecoveryErrorCode,
  reason: string,
  evidence: readonly Evidence[] = [],
): RecoveryOutcome {
  return error({ scope: 'run', code, reason, sharedWrite: 'none', evidence: [...evidence] })
}

function describeAdapterFailure(group: ProcessGroupCheckpoint, cause: unknown): string {
  const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  return `reconciling the recorded process group ${group.id} failed: ${detail}`
}
