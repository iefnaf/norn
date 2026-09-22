/**
 * Abort and handled coordinator interrupts (design.md §2.3, §2.5, §13.2 —
 * ticket #16).
 *
 * Ending a run on purpose. `/norn abort <map-url>` requires the operator to
 * confirm the exact run ID, stops or reconciles every run-owned process and
 * any possibly-successful shared write, and records `aborted` without
 * deleting Run State. It never rolls back a pushed commit or removes remote
 * evidence. The ordered protocol:
 *
 * ```text
 * locate the run through Norn home (the same routing as /norn status);
 * a mismatched or unconfirmed run ID aborts nothing; a run that already
 * reached a terminal or aborted state aborts nothing
 *     ↓
 * acquire the map lock (§16): a second live coordinator owns the run — the
 * operator interrupts that coordinator itself, which follows this same
 * protocol; then re-verify the run ID against the reloaded state
 *     ↓
 * process-group settlement FIRST (§13.2, §16, §17): every recorded,
 * not-yet-settled group is reattached and waited for, or terminated and
 * settled, and the settlement is persisted — the `reconcileResumedRun`
 * settlement engine of ticket #15, reused unchanged
 *     ↓
 * possibly-successful shared-write reconciliation (§13.3, §13.4): every
 * shipping checkpoint beyond `prepared` is a confirmed write by its
 * persisted stage; a `prepared` checkpoint whose persisted push-attempt
 * counter is positive is probed against the fetched target through the same
 * §13.3 classification the push recovery uses (`probeRecordedIntegration`)
 * — presence with the exact integration shape is confirmed, proven absence
 * is none, and persistent ambiguity FAILS the abort with
 * `sharedWrite: 'unknown'`, leaving the run `running` and recoverable
 *     ↓
 * a persisted map-completion checkpoint carries possibly-successful map
 * close and record-comment writes: the timeline after the anchor is read
 * and every close or comment by the authenticated actor is a confirmed
 * write. When the close is bound to the checkpoint (§13.4) and the complete
 * §15 record predicate holds, terminal `passed` takes precedence over abort
 *     ↓
 * release this run's Work-slot reservations — only after settlement is
 * persisted (§16)
 *     ↓
 * record `status: 'aborted'` (Run State retained, never deleted; no
 * terminal report — §9: `aborted` is a lifecycle decision, not an outcome
 * kind); remote evidence is never touched or rolled back
 * ```
 *
 * A handled operator interrupt of the coordinator routes through the same
 * protocol (`runAbortProtocol` over the coordinator's own run context in
 * `src/run/lifecycle.ts`); the outcomes are identical. After `aborted`, the
 * next `run` starts fresh: a new run ID, an empty parked set, and planning
 * from current trustworthy facts — valid Completed Tickets established by
 * remote Delivery Records are retained, while unshipped Work results,
 * evidence, branches, and workspaces of the aborted run are never reused
 * (§2.5; the fresh-run path of `runMap` already guarantees this because it
 * plans from an empty ticket map over re-validated remote facts).
 */
import { blocked, error, ok } from '../core/outcome.ts'
import type { Evidence, Outcome } from '../core/outcome.ts'
import type { GitRepositoryAdapter } from '../adapters/git-repository.ts'
import type { GitHubGatewayAdapter } from '../adapters/github-gateway.ts'
import type { VisibleAgentRunner } from '../agents/runner.ts'
import type { RunConfigResolution } from '../config/run-config.ts'
import type { LocalControlStore } from '../control/control-store.ts'
import { loadRunConfig } from '../control/control-store.ts'
import type { TaskMapLoader } from '../map/loader.ts'
import { parseIssueUrl } from '../map/issue-url.ts'
import { stableReadTaskMap } from '../map/stable-read.ts'
import type { StableSnapshotOutcome } from '../map/stable-read.ts'
import type { TaskMapSnapshot } from '../map/snapshot.ts'
import type { IssueEvidenceReader } from '../evidence/read.ts'
import type { DeliveryEvidenceFinding } from '../evidence/delivery.ts'
import { plausibleRemoteIdentities } from '../runner/init.ts'
import { findRepositoryHome, findRunStateForMap } from '../runner/status.ts'
import { bindFacts, buildRunReport } from './lifecycle.ts'
import { reconcileResumedRun, settlementProbe } from './recovery.ts'
import type { ProcessGroupLivenessProbe } from '../runstate/slot-registry.ts'
import type { ReleaseOutcome } from '../runstate/slot-registry.ts'
import { readWorkSlotRegistry, releaseWorkSlot } from '../runstate/slot-registry.ts'
import { acquireMapLock } from '../runstate/locks.ts'
import { loadRunState, saveRunState } from '../runstate/run-state-store.ts'
import type {
  MapCompletionCheckpoint,
  MapCompletionRecordV1,
  RunReport,
  RunState,
  ShipCheckpoint,
} from '../runstate/types.ts'
import { probeRecordedIntegration } from '../ship/push.ts'
import type { StableProbe } from '../ship/push.ts'
import type { ShipFacts } from '../ship/reconcile.ts'
import {
  closingEventBinding,
  collectMemberCompletion,
  evaluateMapCompletionRecord,
  timelineAnchorIndex,
} from './completion.ts'

// ---------------------------------------------------------------------------
// Outcome vocabulary (§9, §2.3, §13.2)
// ---------------------------------------------------------------------------

/** Closed block codes of `/norn abort`; all operation-scoped. */
export type AbortBlockCode =
  | 'invalid-map-url'
  | 'no-repository-home'
  | 'ambiguous-repository-home'
  | 'no-run'
  | 'run-not-running'
  | 'run-id-mismatch'
  | 'unconfirmed-run-id'
  | 'no-config'
  | 'invalid-config'
  | 'map-repository-mismatch'
  /** The invocation directory is inside no Git repository (init's code). */
  | 'not-a-repository'
  | 'lock-held'

/** Closed error codes of `/norn abort`; all operation-scoped (§9). */
export type AbortErrorCode =
  | 'git-unavailable'
  | 'git-failed'
  | 'github-unavailable'
  | 'control-store'
  | 'state-integrity'
  | 'lock-failed'
  /** Terminating a run-owned process group failed; its slot stays charged. */
  | 'adapter-failure'
  | 'slot-registry'
  /** The map snapshot read needed by the passed-precedence check failed. */
  | 'map-read'
  /** A remote probe failed while a possibly-successful push is unexcluded. */
  | 'target-read'
  /** The map issue timeline could not be read to classify completion writes. */
  | 'evidence-read'
  /** The recorded integration stayed unclassifiable after bounded fetches (§13.3). */
  | 'push-unknown'
  /** The map close/record state stayed unclassifiable (§13.4). */
  | 'issue-close'

/** One confirmed shared write the abort reconciliation recorded exactly (§9). */
export type ConfirmedWrite =
  | {
      readonly kind: 'integration'
      readonly ticketIssueId: string
      readonly stage: ShipCheckpoint['stage']
      readonly integratedSha: string
      readonly provenBy: 'persisted-checkpoint' | 'remote-probe'
      readonly targetSha?: string
    }
  | { readonly kind: 'map-close'; readonly eventId: string }
  | { readonly kind: 'map-comment'; readonly commentId: string }

/** The `ok` value: the run was recorded `aborted`, or completion won. */
export type AbortResult =
  | {
      readonly kind: 'aborted'
      readonly runId: string
      readonly sharedWrite: 'none' | 'confirmed'
      readonly settledProcessGroupIds: readonly string[]
      readonly releasedSlots: readonly string[]
      readonly confirmedWrites: readonly ConfirmedWrite[]
      readonly warnings: readonly string[]
    }
  | {
      /** Reconciliation proved map completion finalized: `passed` wins (§13.2). */
      readonly kind: 'passed'
      readonly runId: string
      readonly report: RunReport
    }

export type AbortOutcome = Outcome<AbortResult, AbortBlockCode, AbortErrorCode>

/** The internal protocol outcome; block codes never occur mid-protocol. */
export type AbortProtocolOutcome = Outcome<AbortResult, never, AbortErrorCode>

// ---------------------------------------------------------------------------
// The typed operator interaction (§2.3)
// ---------------------------------------------------------------------------

/** The persisted facts the operator confirms against before any effect. */
export type AbortRunSummary = {
  readonly runId: string
  readonly status: RunState['status']
  readonly mapUrl: string
  readonly wave: number
  readonly parkedTickets: readonly number[]
  /** Whether persisted state already proves a confirmed shared write (§13.2). */
  readonly pendingSharedWrite: boolean
}

/**
 * The typed abort interaction: the runner asks for the exact run ID and the
 * operator's typed answer crosses the seam. `undefined` is a cancelled
 * dialog; a string that differs from the persisted run ID is a mismatch —
 * either way nothing is aborted (§2.3).
 */
export type AbortInteraction = {
  readonly confirmRunId: (summary: AbortRunSummary) => Promise<string | undefined>
}

/** The persisted-facts summary of one running state (§2.3 confirmation). */
export function abortRunSummary(state: RunState): AbortRunSummary {
  return {
    runId: state.runId,
    status: state.status,
    mapUrl: state.map.url,
    wave: state.wave,
    parkedTickets: state.parkedTickets.map((ref) => ref.number),
    pendingSharedWrite: persistedSharedWrite(state),
  }
}

/**
 * Whether the persisted state already proves this run attempted or performed
 * a shared write (§13.2): a Ship checkpoint beyond `prepared`, or a
 * map-completion close or record beyond `gated`. A `prepared` checkpoint
 * with a positive push-attempt counter is *possibly* successful — the probe
 * decides — and does not count as proven here.
 */
export function persistedSharedWrite(state: RunState): boolean {
  for (const ticket of Object.values(state.tickets)) {
    if (ticket.phase !== 'shipping') continue
    if (ticket.checkpoint.stage !== 'prepared') return true
  }
  const completion = state.mapCompletion
  if (completion !== undefined && completion.stage !== 'gated') return true
  return false
}

// ---------------------------------------------------------------------------
// The injected seams
// ---------------------------------------------------------------------------

/** Everything `/norn abort` needs; the extension constructs the built-ins. */
export type AbortDeps = {
  /** Working directory the operator invoked `/norn abort` from. */
  readonly cwd: string
  /** Norn home (`<pi-agent-dir>/norn`), where repository homes live. */
  readonly nornHome: string
  readonly git: GitRepositoryAdapter
  readonly gateway: GitHubGatewayAdapter
  readonly loader: TaskMapLoader
  readonly store: LocalControlStore
  readonly evidence: IssueEvidenceReader
  readonly gitFacts: AbortDepsGitFacts
  /** The Visible Agent Runner seam: reattach, wait, terminate (§6, §17). */
  readonly runner: VisibleAgentRunner
  /** The typed operator interaction (run-ID confirmation). */
  readonly interaction: AbortInteraction
  /** Budget for settling one live process group (§13.2). */
  readonly agentSettleTimeoutMs?: number
  /** Liveness probe for the settlement proof; default: §16's. */
  readonly probe?: ProcessGroupLivenessProbe
  /** Overrides the slot release for tests; default: the registry (§16). */
  readonly releaseReservation?: (
    repositoryHome: string,
    workAttemptId: string,
  ) => Promise<ReleaseOutcome>
  /** Bounded stable-fetch cycle cap for remote probes; default: §11.3's. */
  readonly stableFetchMax?: number
}

/** The git facts adapter shape abort binds to one root and remote. */
type AbortDepsGitFacts = Parameters<typeof bindFacts>[0]

/**
 * The narrow seams the abort protocol core composes. `/norn abort` builds
 * them after preflight; the coordinator's handled-interrupt path builds them
 * from its own run context — both drive the identical protocol.
 */
export type AbortCoreDeps = {
  readonly runner: VisibleAgentRunner
  readonly repositoryHome: string
  readonly encodedMapIssueId: string
  readonly targetBranch: string
  readonly trustedEvidenceAuthorIds: readonly string[]
  /** The authenticated GitHub actor whose writes are reconciled (§13.4). */
  readonly actorId: string
  /** The OID-normalized remote target and commit facts, fetch included. */
  readonly facts: ShipFacts
  /** One stable read of the current Task Map snapshot (§7.3). */
  readonly readMap: () => Promise<StableSnapshotOutcome>
  readonly readIssueEvidence: IssueEvidenceReader['loadIssueEvidence']
  readonly agentSettleTimeoutMs?: number
  readonly probe?: ProcessGroupLivenessProbe
  readonly releaseReservation?: (
    repositoryHome: string,
    workAttemptId: string,
  ) => Promise<ReleaseOutcome>
  readonly stableFetchMax?: number
}

// ---------------------------------------------------------------------------
// `/norn abort <map-url>` (§2.3)
// ---------------------------------------------------------------------------

/**
 * Execute `/norn abort <map-url>`: locate the run, require the exact run ID,
 * then — under the map lock — run the ordered §13.2 abort protocol. A
 * mismatched or unconfirmed run ID, a run that already ended, or a map owned
 * by a live coordinator aborts nothing.
 */
export async function abortMap(deps: AbortDeps, mapUrl: string): Promise<AbortOutcome> {
  // --- locate the run through Norn home (the /norn status routing) --------

  const locator = parseIssueUrl(mapUrl)
  if (locator === undefined) {
    return blocked({
      scope: 'operation',
      code: 'invalid-map-url',
      reason:
        `"${mapUrl.trim()}" is not a full GitHub issue URL of the form ` +
        'https://<host>/<owner>/<repository>/issues/<number>',
      sharedWrite: 'none',
    })
  }
  const home = findRepositoryHome(deps.nornHome, locator)
  if (home.kind !== 'ok') return home
  const found = findRunStateForMap(home.value, locator)
  if (found.kind !== 'ok') return found

  const state = found.value.state
  if (state === undefined) {
    return blocked({
      scope: 'operation',
      code: 'no-run',
      reason:
        `no Run State exists for ${locator.githubHost}/${locator.owner}/${locator.name}#${locator.number}; ` +
        'there is nothing to abort',
      sharedWrite: 'none',
      evidence: [{ mapUrl }],
    })
  }
  if (state.status !== 'running') {
    return blocked({
      scope: 'operation',
      code: 'run-not-running',
      reason:
        `run ${state.runId} is already ${state.status}` +
        (state.report === undefined ? '' : ` (terminal report: ${state.report.label})`) +
        '; there is nothing to abort',
      sharedWrite: 'none',
      evidence: [{ runId: state.runId, status: state.status }],
    })
  }

  // --- the exact-run-ID confirmation: mismatch or cancellation aborts nothing

  const summary = abortRunSummary(state)
  const typed = await deps.interaction.confirmRunId(summary)
  const trimmed = typed === undefined ? '' : typed.trim()
  if (trimmed === '') {
    return blocked({
      scope: 'operation',
      code: 'unconfirmed-run-id',
      reason:
        `the abort of run ${state.runId} was not confirmed; nothing was stopped, ` +
        'reconciled, or recorded',
      sharedWrite: 'none',
      evidence: [{ runId: state.runId }],
    })
  }
  if (trimmed !== state.runId) {
    return blocked({
      scope: 'operation',
      code: 'run-id-mismatch',
      reason:
        `the confirmed run ID "${trimmed}" does not match the persisted run ${state.runId}; ` +
        'nothing was stopped, reconciled, or recorded',
      sharedWrite: 'none',
      evidence: [{ confirmed: trimmed, persisted: state.runId }],
    })
  }

  // --- repository root, matching remote, config, and actor ----------------

  const rootRead = await deps.git.resolveRoot(deps.cwd)
  if (rootRead.kind !== 'ok') {
    if (rootRead.code === 'not-a-repository') {
      return blocked({
        scope: 'operation',
        code: 'not-a-repository',
        reason: `"${deps.cwd}" is inside no Git repository; run /norn abort from the map's repository`,
        sharedWrite: 'none',
        evidence: [{ cwd: deps.cwd }],
      })
    }
    return error({ scope: 'operation', code: rootRead.code, reason: rootRead.reason })
  }
  const remotesRead = await deps.git.listRemotes(rootRead.value)
  if (remotesRead.kind !== 'ok') {
    // `listRemotes` cannot genuinely report not-a-repository after the
    // root resolved; keep the closed error vocabulary honest (init's code).
    return error({
      scope: 'operation',
      code: remotesRead.code === 'not-a-repository' ? 'git-failed' : remotesRead.code,
      reason: remotesRead.reason,
    })
  }
  const match = plausibleRemoteIdentities(remotesRead.value).find(
    (candidate) =>
      candidate.githubHost === locator.githubHost &&
      candidate.owner === locator.owner &&
      candidate.name === locator.name,
  )
  if (match === undefined) {
    return blocked({
      scope: 'operation',
      code: 'map-repository-mismatch',
      reason:
        `the map repository ${locator.owner}/${locator.name} @ ${locator.githubHost} no longer ` +
        'matches a plausible local remote, so its shared writes cannot be reconciled',
      sharedWrite: 'none',
      evidence: [{ mapUrl }],
    })
  }
  const config = await loadRunConfig(deps.store, home.value)
  if (config.kind === 'blocked') {
    return blocked({
      scope: 'operation',
      code: config.code === 'no-config' ? 'no-config' : 'invalid-config',
      reason: config.reason,
      sharedWrite: 'none',
      evidence: [...config.evidence],
    })
  }
  if (config.kind === 'error') {
    return error({ scope: 'operation', code: 'control-store', reason: config.reason })
  }
  const resolved: RunConfigResolution = config.value
  const actorRead = await deps.gateway.authenticatedActor(locator.githubHost)
  if (actorRead.kind !== 'ok') {
    return error({ scope: 'operation', code: 'github-unavailable', reason: actorRead.reason })
  }

  // --- the map lock: a live coordinator owns the run (§16) -----------------

  const lock = await acquireMapLock(home.value, found.value.encodedIssueId)
  if (lock.kind === 'blocked') {
    return blocked({
      scope: 'operation',
      code: 'lock-held',
      reason:
        'a live coordinator holds the map lock for this run; interrupt that coordinator ' +
        '(the handled interrupt follows the same abort protocol) and abort again once it exits',
      sharedWrite: 'none',
      evidence: [{ runId: state.runId }],
    })
  }
  if (lock.kind === 'error') {
    return error({ scope: 'operation', code: 'lock-failed', reason: lock.reason })
  }

  try {
    // Re-verify against the state as it exists under the lock: a coordinator
    // that terminalized or replaced the run between the summary and the lock
    // changes what the operator confirmed.
    const reloaded = loadRunState(home.value, found.value.encodedIssueId)
    if (reloaded.kind !== 'ok') return reloaded
    if (reloaded.value === undefined) {
      return blocked({
        scope: 'operation',
        code: 'no-run',
        reason: 'the Run State vanished while the abort was being confirmed',
        sharedWrite: 'none',
        evidence: [{ runId: state.runId }],
      })
    }
    if (reloaded.value.runId !== state.runId) {
      return blocked({
        scope: 'operation',
        code: 'run-id-mismatch',
        reason:
          `the persisted run moved to ${reloaded.value.runId} while the abort of ` +
          `${state.runId} was being confirmed; nothing was stopped, reconciled, or recorded`,
        sharedWrite: 'none',
        evidence: [{ confirmed: state.runId, persisted: reloaded.value.runId }],
      })
    }
    if (reloaded.value.status !== 'running') {
      return blocked({
        scope: 'operation',
        code: 'run-not-running',
        reason:
          `run ${reloaded.value.runId} reached ${reloaded.value.status} while the abort ` +
          'was being confirmed; there is nothing to abort',
        sharedWrite: 'none',
        evidence: [{ runId: reloaded.value.runId, status: reloaded.value.status }],
      })
    }

    return await runAbortProtocol(
      {
        runner: deps.runner,
        repositoryHome: home.value,
        encodedMapIssueId: found.value.encodedIssueId,
        targetBranch: resolved.config.targetBranch,
        trustedEvidenceAuthorIds: resolved.config.trustedEvidenceAuthorIds,
        actorId: actorRead.value.id,
        facts: bindFacts(deps.gitFacts, rootRead.value, match.remoteNames[0]!),
        readMap: () => stableReadTaskMap(() => deps.loader.loadTaskMap(locator)),
        readIssueEvidence: deps.evidence.loadIssueEvidence,
        ...(deps.agentSettleTimeoutMs === undefined
          ? {}
          : { agentSettleTimeoutMs: deps.agentSettleTimeoutMs }),
        ...(deps.probe === undefined ? {} : { probe: deps.probe }),
        ...(deps.releaseReservation === undefined
          ? {}
          : { releaseReservation: deps.releaseReservation }),
        ...(deps.stableFetchMax === undefined ? {} : { stableFetchMax: deps.stableFetchMax }),
      },
      reloaded.value,
    )
  } finally {
    await lock.value.release()
  }
}

// ---------------------------------------------------------------------------
// The ordered abort protocol (§13.2)
// ---------------------------------------------------------------------------

/**
 * Run the ordered abort protocol over one `running` state under the map
 * lock: settle every recorded process group, reconcile every
 * possibly-successful shared write, let a proven-finalized map completion
 * terminalize `passed`, release this run's Work slots after settlement, and
 * record `aborted` — Run State retained, remote evidence untouched. Any
 * unreconcilable remote state fails the abort and leaves the run
 * `running` and recoverable (§2.3).
 */
export async function runAbortProtocol(
  deps: AbortCoreDeps,
  initial: RunState,
): Promise<AbortProtocolOutcome> {
  if (initial.status !== 'running') {
    return abortError('state-integrity', `a ${initial.status} run cannot be aborted`, [], 'none')
  }

  // --- process-group settlement FIRST (§13.2, §16, §17) --------------------

  const pendingIds = initial.activeProcesses
    .filter((group) => group.state !== 'settled')
    .map((group) => group.id)
  const reconciled = await reconcileResumedRun(
    {
      runner: deps.runner,
      repositoryHome: deps.repositoryHome,
      encodedMapIssueId: deps.encodedMapIssueId,
      ...(deps.agentSettleTimeoutMs === undefined
        ? {}
        : { agentSettleTimeoutMs: deps.agentSettleTimeoutMs }),
      ...(deps.probe === undefined ? {} : { probe: deps.probe }),
    },
    initial,
  )
  // The settlement engine's stale-reservation pass is correct but incomplete
  // for abort (it never touches a `working` attempt's reservation); the
  // dedicated release below covers every reservation of this run.
  if (reconciled.kind !== 'ok') {
    return abortError(
      reconciled.code,
      `settling the run-owned process groups failed: ${reconciled.reason}`,
      [...reconciled.evidence],
      'none',
    )
  }
  let state = reconciled.value

  // --- possibly-successful shared-write reconciliation (§13.3, §13.4) ------

  const confirmedWrites: ConfirmedWrite[] = []
  const warnings: string[] = []

  const completion = await reconcileCompletionWrites(deps, state)
  if (completion.kind === 'failed') return completion.outcome
  if (completion.kind === 'passed') {
    // `passed` takes precedence (§13.2): settle the slots, persist terminal.
    const released = await releaseRunReservations(deps, state.runId)
    if (released.kind !== 'ok') return released.outcome
    const saved = saveRunState(deps.repositoryHome, deps.encodedMapIssueId, completion.terminal)
    if (saved.kind !== 'ok') {
      return abortError(
        saved.code,
        `persisting the terminal completion report failed: ${saved.reason}`,
        [],
        'confirmed',
      )
    }
    return ok({ kind: 'passed', runId: state.runId, report: completion.report })
  }
  confirmedWrites.push(...completion.writes)

  for (const [issueId, record] of Object.entries(state.tickets)) {
    if (record.phase !== 'shipping') continue
    const checkpoint = record.checkpoint
    if (checkpoint.stage !== 'prepared') {
      // The persisted stage is the last remotely confirmed stage (§13.1):
      // anything beyond `prepared` proves the integration write.
      confirmedWrites.push({
        kind: 'integration',
        ticketIssueId: issueId,
        stage: checkpoint.stage,
        integratedSha: checkpoint.integratedSha,
        provenBy: 'persisted-checkpoint',
      })
      continue
    }
    if (checkpoint.pushAttempts === 0) {
      // The write-ahead attempt counter persists before every push (§11.3):
      // zero attempts prove no push was ever issued for this checkpoint.
      continue
    }
    const probe = await probeRecordedIntegration(
      deps.facts,
      deps.targetBranch,
      checkpoint,
      deps.stableFetchMax === undefined ? {} : { stableFetchMax: deps.stableFetchMax },
    )
    if (probe.kind === 'ambiguous' || probe.kind === 'infra') {
      return probeFailure(probe, checkpoint)
    }
    if (probe.result === 'present') {
      confirmedWrites.push({
        kind: 'integration',
        ticketIssueId: issueId,
        stage: checkpoint.stage,
        integratedSha: checkpoint.integratedSha,
        provenBy: 'remote-probe',
        targetSha: probe.targetSha,
      })
    }
  }

  // --- release this run's Work slots — only after settlement (§16) ---------

  const released = await releaseRunReservations(deps, state.runId)
  if (released.kind !== 'ok') return released.outcome

  // --- record `aborted` (§13.2): retained, never deleted -------------------

  state = { ...state, status: 'aborted' }
  const saved = saveRunState(deps.repositoryHome, deps.encodedMapIssueId, state)
  if (saved.kind !== 'ok') {
    return abortError(
      saved.code,
      `recording the aborted state failed: ${saved.reason}`,
      [...saved.evidence],
      confirmedWrites.length > 0 ? 'confirmed' : 'none',
    )
  }
  return ok({
    kind: 'aborted',
    runId: state.runId,
    sharedWrite: confirmedWrites.length > 0 ? 'confirmed' : 'none',
    settledProcessGroupIds: pendingIds,
    releasedSlots: released.value,
    confirmedWrites,
    warnings,
  })
}

// ---------------------------------------------------------------------------
// Map-completion write reconciliation and passed precedence (§13.4, §13.2)
// ---------------------------------------------------------------------------

type CompletionReconciliation =
  | { readonly kind: 'ok'; readonly writes: readonly ConfirmedWrite[] }
  | { readonly kind: 'passed'; readonly terminal: RunState; readonly report: RunReport }
  | { readonly kind: 'failed'; readonly outcome: AbortProtocolOutcome }

/**
 * Reconcile the possibly-successful map close and record-comment writes of a
 * persisted completion checkpoint (§13.4): the fully-paginated timeline
 * after the anchor attributes every close and comment by the authenticated
 * actor as a confirmed write, and an unlocatable anchor is ambiguity — never
 * permission to guess (§13.1). When the close is bound to the checkpoint and
 * the complete §15 record predicate holds, the run terminalizes `passed`
 * instead of aborting (§13.2).
 */
async function reconcileCompletionWrites(
  deps: AbortCoreDeps,
  state: RunState,
): Promise<CompletionReconciliation> {
  const checkpoint = state.mapCompletion
  if (checkpoint === undefined) return { kind: 'ok', writes: [] }

  // A possibly-successful close can never be excluded for a completion
  // checkpoint — the persisted stage records only the last *confirmed* stage
  // (§13.1) — so an unreadable timeline is unreconcilable (§2.3).
  const evidenceRead = await deps.readIssueEvidence({
    githubHost: state.map.githubHost,
    number: state.map.number,
    url: state.map.url,
  })
  if (evidenceRead.kind !== 'ok') {
    return {
      kind: 'failed',
      outcome: abortError(
        'evidence-read',
        `reading the Task Map timeline to reconcile the completion writes failed: ${evidenceRead.reason}`,
        [...('evidence' in evidenceRead ? [...evidenceRead.evidence] : []), { stage: checkpoint.stage }],
        'unknown',
      ),
    }
  }
  const timeline = evidenceRead.value.timeline
  const anchorIndex = timelineAnchorIndex(timeline, checkpoint.timelineAnchor)
  if (anchorIndex === undefined) {
    return {
      kind: 'failed',
      outcome: abortError(
        'issue-close',
        'the completion checkpoint timeline anchor can no longer be located; the close ' +
          'window is ambiguous and never guessed from (§13.1, §13.4)',
        [{ timelineAnchor: checkpoint.timelineAnchor }],
        'unknown',
      ),
    }
  }

  // Confirmed writes: closes and comments by the authenticated actor after
  // the anchor — each is remotely visible in the fully-paginated timeline.
  // Timeline `commented` events carry no author; the comments list does.
  const commentAuthor = new Map(
    evidenceRead.value.comments.map((comment) => [comment.commentId, comment.authorId]),
  )
  const writes: ConfirmedWrite[] = []
  timeline.forEach((event, index) => {
    if (index <= anchorIndex) return
    if (event.kind === 'closed' && event.actorId === deps.actorId) {
      writes.push({ kind: 'map-close', eventId: event.eventId })
    }
    if (event.kind === 'commented' && commentAuthor.get(event.commentId) === deps.actorId) {
      writes.push({ kind: 'map-comment', commentId: event.commentId })
    }
  })

  // Passed precedence (§13.2): only a close bound to this checkpoint and a
  // currently-valid §15 record proves completion finalized.
  const closing = closingEventBinding(timeline, checkpoint.timelineAnchor, deps.actorId)
  if (!closing.bound) return { kind: 'ok', writes }

  const snapshotRead = await deps.readMap()
  if (snapshotRead.kind !== 'ok') {
    return {
      kind: 'failed',
      outcome: abortError(
        'map-read',
        `reading the Task Map to prove finalized completion failed: ${snapshotRead.reason}`,
        [...snapshotRead.evidence, { closingEventId: closing.closingEventId }],
        'unknown',
      ),
    }
  }
  const snapshot: TaskMapSnapshot = snapshotRead.value
  const members = new Map<string, 'completed' | readonly DeliveryEvidenceFinding[]>()
  const memberFailure = await collectMemberCompletion(
    { readIssueEvidence: deps.readIssueEvidence, facts: deps.facts },
    {
      map: { issueId: snapshot.ref.issueId, repositoryId: snapshot.ref.repositoryId },
      targetBranch: deps.targetBranch,
      trustedEvidenceAuthorIds: deps.trustedEvidenceAuthorIds,
      alreadyShipped: true,
    },
    snapshot,
    members,
  )
  if (memberFailure !== undefined && memberFailure.kind === 'error') {
    // The close is confirmed, so an evaluation the infrastructure cannot
    // complete leaves finalization unprovable — ambiguity, never a guess.
    return {
      kind: 'failed',
      outcome: abortError(
        memberFailure.code as AbortErrorCode,
        `evaluating member completion to prove finalized completion failed: ${memberFailure.reason}`,
        [...memberFailure.evidence, { closingEventId: closing.closingEventId }],
        'unknown',
      ),
    }
  }
  if (memberFailure !== undefined) {
    // Trustworthy member facts prevent a valid record (§15 rule 4): the
    // completion is provably NOT finalized — plain abort continues.
    return { kind: 'ok', writes }
  }

  const evaluation = await evaluateMapCompletionRecord({
    map: {
      issueId: snapshot.ref.issueId,
      repositoryId: snapshot.ref.repositoryId,
      state: snapshot.state,
      mapRevision: snapshot.mapRevision,
    },
    targetBranch: deps.targetBranch,
    trustedEvidenceAuthorIds: deps.trustedEvidenceAuthorIds,
    evidence: evidenceRead.value,
    memberCompletion: members,
    facts: deps.facts,
  })
  if (evaluation.status === 'error') {
    return {
      kind: 'failed',
      outcome: abortError(
        'target-read',
        `validating the completion record to prove finalized completion failed: ${evaluation.reason}`,
        [{ code: evaluation.code }],
        'unknown',
      ),
    }
  }
  if (evaluation.status !== 'valid') return { kind: 'ok', writes }
  if (evaluation.record.run.completionAttemptId !== checkpoint.completionAttemptId) {
    // A valid record of a different attempt finalized this map, not this
    // checkpoint's own close — our run did not pass (§13.4 rule 2/3).
    return { kind: 'ok', writes }
  }

  // Terminal `passed` takes precedence over abort (§13.2): record the
  // recovered checkpoint facts, then terminalize with the passed report.
  const recovered: MapCompletionCheckpoint = {
    ...checkpoint,
    stage: 'recorded',
    closingEventId: closing.closingEventId,
    record: evaluation.record,
  }
  const terminal: RunState = {
    ...state,
    mapCompletion: recovered,
    status: 'terminal',
    report: passedReportOf(state, snapshot, evaluation.record),
  }
  return { kind: 'passed', terminal, report: terminal.report! }
}

/** The passed terminal report of a recovered completion (§13.1, §15). */
function passedReportOf(
  state: RunState,
  snapshot: TaskMapSnapshot,
  record: MapCompletionRecordV1,
): RunReport {
  const ticketRefs = new Map(snapshot.tickets.map((ticket) => [ticket.ref.issueId, ticket.ref]))
  return buildRunReport({
    state,
    finalSnapshot: snapshot,
    ticketRefs,
    warnings: [],
    label: 'passed',
    code: undefined,
    sharedWrite: 'confirmed',
    completionSha: record.target.completionSha,
  })
}

// ---------------------------------------------------------------------------
// Shipping-checkpoint write classification (§13.3)
// ---------------------------------------------------------------------------

/** A possibly-landed push that stayed unclassifiable fails the abort (§2.3). */
function probeFailure(probe: Exclude<StableProbe, { kind: 'decided' }>, checkpoint: ShipCheckpoint): AbortProtocolOutcome {
  return error({
    scope: 'operation',
    code: probe.kind === 'ambiguous' ? 'push-unknown' : 'target-read',
    reason:
      `the possibly-successful push of the checkpoint at stage "${checkpoint.stage}" ` +
      `(${checkpoint.pushAttempts} persisted attempt(s)) could not be reconciled against the ` +
      `remote target: ${probe.reason}; the abort fails and the run stays recoverable`,
    sharedWrite: 'unknown',
    evidence: [
      { probe: probe.kind, reason: probe.reason, integratedSha: checkpoint.integratedSha },
    ],
  })
}

// ---------------------------------------------------------------------------
// Work-slot release after settlement (§16)
// ---------------------------------------------------------------------------

type ReleaseResult =
  | { readonly kind: 'ok'; readonly value: readonly string[] }
  | { readonly kind: 'failed'; readonly outcome: AbortProtocolOutcome }

/**
 * Release every Work-slot reservation of this run and map. Called only after
 * process-group settlement is persisted (§16: a reservation remains charged
 * until that run's resume or abort reconciliation settles it); the registry
 * release re-proves settlement from the persisted checkpoints, so a group
 * that is still live keeps its reservation charged and the abort fails.
 */
async function releaseRunReservations(deps: AbortCoreDeps, runId: string): Promise<ReleaseResult> {
  const registry = readWorkSlotRegistry(deps.repositoryHome)
  if (registry.kind !== 'ok') {
    return {
      kind: 'failed',
      outcome: abortError('slot-registry', registry.reason, [...registry.evidence], 'none'),
    }
  }
  if (registry.value === undefined) return { kind: 'ok', value: [] }

  const mine = registry.value.reserved.filter(
    (reservation) =>
      reservation.runId === runId && reservation.encodedMapIssueId === deps.encodedMapIssueId,
  )
  if (mine.length === 0) return { kind: 'ok', value: [] }

  const release =
    deps.releaseReservation ??
    ((repositoryHome: string, workAttemptId: string) =>
      releaseWorkSlot(repositoryHome, workAttemptId, {
        probe: deps.probe !== undefined ? deps.probe : settlementProbe(),
      }))
  const released: string[] = []
  for (const reservation of mine) {
    const outcome = await release(deps.repositoryHome, reservation.workAttemptId)
    if (outcome.kind === 'ok') {
      released.push(reservation.workAttemptId)
      continue
    }
    if (outcome.kind === 'blocked') {
      // `process-groups-live`: the settlement proof refused — the run keeps
      // its reservation and stays running; never a silent release (§16).
      return {
        kind: 'failed',
        outcome: abortError(
          'slot-registry',
          `the reservation of attempt ${reservation.workAttemptId} could not be released: ${outcome.reason}`,
          [{ workAttemptId: reservation.workAttemptId, code: outcome.code }],
          'none',
        ),
      }
    }
    return {
      kind: 'failed',
      outcome: abortError(
        'slot-registry',
        `releasing the reservation of attempt ${reservation.workAttemptId} failed: ${outcome.reason}`,
        [{ workAttemptId: reservation.workAttemptId }, ...outcome.evidence],
        'none',
      ),
    }
  }
  return { kind: 'ok', value: released }
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function abortError(
  code: AbortErrorCode,
  reason: string,
  evidence: readonly Evidence[],
  sharedWrite: 'none' | 'confirmed' | 'unknown',
): AbortProtocolOutcome {
  return error({ scope: 'operation', code, reason, sharedWrite, evidence: [...evidence] })
}
