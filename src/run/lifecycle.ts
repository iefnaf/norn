/**
 * Wave execution and run lifecycle (design.md §2.3, §12, §13, ticket #13).
 *
 * The coordinator. `runMap` performs the full `/norn check` preflight,
 * creates or resumes exactly one run for the whole Task Map under the map
 * lock, and repeatedly executes Waves:
 *
 * ```text
 * load and validate map
 *     ↓
 * validate all previously completed members (§14 evidence)
 *     ↓
 * compute frontier (open tickets whose blockers are all Completed)
 *     ↓
 * capture map and target snapshot; persist the Wave (claims first)
 *     ↓
 * parallel Work(frontier), bounded by repository-wide concurrency
 *     ↓
 * barrier: re-read Map; classify and adopt any Compatible Map Extension
 *     ↓
 * serial Ship(the Wave's successes) in issue-number order from the
 * persisted queue — the queue survives restart and later extensions
 *     ↓
 * reload facts and repeat until no frontier remains
 * ```
 *
 * Barrier policy (§12): a map that is no longer OPEN or changed
 * incompatibly ships nothing further — every remaining unshipped result is
 * invalidated (parked `changed-input`) and the run terminalizes
 * `blocked(changed-input)` with exact shared-write accounting. A Compatible
 * Map Extension is adopted atomically — the revision lineage entry, the
 * added Tickets' claims, and per-member preflight all commit in one Run
 * State update — and its added Tickets enter frontier computation in the
 * next Wave, never reordering a persisted queue. Blocked and ticket-scoped
 * error Tickets park for the run; descendants stay waiting; independent
 * branches continue.
 *
 * Terminal RunReports (`passed`, `blocked`, `error`) carry revision lineage,
 * per-Ticket states, accepted extensions, shared-write accounting, and
 * warnings (§13.1). A run-scoped error after a confirmed or unknown shared
 * write is a recoverable interruption (§13.2): the checkpoint is already
 * persisted, Run State stays `running`, nothing later ships, and the next
 * compatible `run` invocation resumes the same run ID.
 *
 * Orchestration composes the earlier tickets' modules unchanged — the full
 * preflight (`src/runner/check.ts`), the Work round gate
 * (`src/work/round-gate.ts`), Ship reconciliation, push, and close
 * (`src/ship/`), the stable read and extension classifier (`src/map/`), and
 * Run State, locks, and slots (`src/runstate/`) — over the five seam
 * adapters (map loader, gateway, git, agents, catalog).
 */
import { randomBytes } from 'node:crypto'

import { blocked, error, ok } from '../core/outcome.ts'
import type { Evidence, Outcome } from '../core/outcome.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'
import type {
  GitCommandRunner,
  GitFactsCommandRunner,
  GitPushSeam,
} from '../adapters/git-repository.ts'
import type { GitHubIssueWriter } from '../adapters/github-gateway.ts'
import { GIT_OBJECT_OID_PATTERN } from '../agents/completion.ts'
import type { GitObjectOid } from '../agents/completion.ts'
import type { VisibleAgentRunner } from '../agents/runner.ts'
import type { RunConfigAgentRole, RunConfigResolution, ResolvedRunConfig } from '../config/run-config.ts'
import { encodePathSegment } from '../config/paths.ts'
import type { DeliveryTargetFacts } from '../evidence/delivery.ts'
import { evaluateDeliveryEvidence } from '../evidence/delivery.ts'
import type { MapIssueLocator } from '../map/issue-url.ts'
import { classifyMapChange } from '../map/map-extension.ts'
import type { TaskMapSnapshot, TicketRef } from '../map/snapshot.ts'
import { stableReadTaskMap } from '../map/stable-read.ts'
import type { StableSnapshotOutcome } from '../map/stable-read.ts'
import { checkMap } from '../runner/check.ts'
import type { CheckMapDeps } from '../runner/check.ts'
import { plausibleRemoteIdentities } from '../runner/init.ts'
import { acquireControlLock, acquireMapLock } from '../runstate/locks.ts'
import { loadAllRunStates, loadRunState, saveRunState } from '../runstate/run-state-store.ts'
import type {
  EvidenceGateV1,
  ProcessGroupCheckpoint,
  RunReport,
  RunState,
  TicketRunState,
  WaveState,
  WorkspaceRef,
} from '../runstate/types.ts'
import { fsWorkspaceCleanup, shipClose } from '../ship/close.ts'
import type { ShipCloseDeps, ShipCloseParams } from '../ship/close.ts'
import { osTargetLock, runStateShipCheckpointStore, shipPush } from '../ship/push.ts'
import type { ShipPushDeps, ShipPushParams, ShipTargetLock } from '../ship/push.ts'
import { acceptedSnapshotFrom, snapshotMapPayload } from '../ship/reconcile.ts'
import type { ShipExtensionAdoption, ShipFacts } from '../ship/reconcile.ts'
import { NORN_VERSION } from '../version.ts'
import {
  completionsDirFor,
  modelProvider,
  runStateWorkAttemptStore,
  runWorkAttempt,
  workAttemptReservation,
  workSlotSeam,
} from '../work/round-gate.ts'
import type {
  AgentLaunchPlan,
  ReviewerLaunchPlanner,
  RoundGateDeps,
  WorkAttemptParams,
  WorkerLaunchPlanner,
} from '../work/round-gate.ts'
import type { CommandRunner } from '../work/command-runner.ts'
import { formatGitObjectOid } from '../work/workspace.ts'

// ---------------------------------------------------------------------------
// Outcome vocabulary (§9, §13)
// ---------------------------------------------------------------------------

/**
 * Closed block codes of `/norn run`. The first three are operation-scoped
 * (discovered before run ownership was acquired or resumed, §9); the rest
 * are run-scoped terminal blocks and share the code recorded in the
 * persisted RunReport.
 */
export type RunBlockCode =
  | 'check-findings'
  | 'lock-held'
  | 'state-not-resumable'
  | 'changed-input'
  | 'push-rejected'
  | 'no-eligible-frontier'

/**
 * Closed error codes of `/norn run`. Infrastructure and adapter failures
 * from preflight, Work, Ship, and the control surfaces map onto these; a
 * recoverable error carries `sharedWrite` `confirmed` or `unknown`.
 */
export type RunErrorCode =
  | 'git-unavailable'
  | 'git-failed'
  | 'github-unavailable'
  | 'model-catalog-unavailable'
  | 'control-store'
  | 'state-integrity'
  | 'lock-failed'
  | 'slot-registry'
  | 'map-read'
  | 'target-read'
  | 'evidence-read'
  | 'push-unknown'
  | 'comment-write'
  | 'issue-close'
  | 'issue-reopen'
  | 'adapter-failure'

export type RunMapOutcome = Outcome<RunReport, RunBlockCode, RunErrorCode>

// ---------------------------------------------------------------------------
// The injected seams
// ---------------------------------------------------------------------------

/** Agent launch planning for Work and Ship reviewers (§10.2, §11.2). */
export type RunLaunchPlans = {
  /** The worker launch planner of one Work attempt, for the configured role. */
  readonly planWorkerFor: (
    workAttemptId: string,
    worker: RunConfigAgentRole,
  ) => WorkerLaunchPlanner
  /** The Work reviewer launch planner of one Work attempt. */
  readonly planWorkReviewerFor: (
    workAttemptId: string,
    reviewer: RunConfigAgentRole & { readonly family: string },
  ) => ReviewerLaunchPlanner
  /** The Ship reviewer launch planner for the resolved reviewer (§11.2). */
  readonly planShipReviewer: (
    reviewer: RunConfigAgentRole & { readonly family: string },
  ) => ReviewerLaunchPlanner
  /** Validates reviewer plans; defaults to the argv allowlist check. */
  readonly reviewerPlanIsReadOnly?: (plan: AgentLaunchPlan) => boolean
  /** Unique ship-reviewer invocation IDs. */
  readonly newShipInvocationId: () => string
}

/**
 * Everything `/norn run` needs beyond the preflight seams of
 * `CheckMapDeps`: the Visible Agent Runner, the Command runner, the git
 * command seams Work and Ship use, the push and issue-write seams, agent
 * launch planning, and injectable time, run IDs, and interruption.
 */
export type RunLifecycleDeps = CheckMapDeps & {
  /** The Visible Agent Runner seam for workers and reviewers (§6, §17). */
  readonly runner: VisibleAgentRunner
  /** The Command runner seam for gate commands (§6, §10.2). */
  readonly commands: CommandRunner
  /** The git command seam for candidate verification and integration. */
  readonly workGit: GitCommandRunner
  /** The exit-code-aware git seam for replay plumbing (`merge-tree`). */
  readonly gitDetailed: GitFactsCommandRunner
  /** The non-force push seam (§11.3). */
  readonly push: GitPushSeam
  /** The GitHub issue-write seam: record comment, close, reopen (§11.3). */
  readonly writer: GitHubIssueWriter
  /** Agent launch planning per role. */
  readonly launches: RunLaunchPlans
  /** The target lock per repository home and branch; default: OS-backed. */
  readonly targetLockFor?: (repositoryHome: string, branch: string) => ShipTargetLock
  /** Workspace cleanup of completed shipments; default: recursive deletion. */
  readonly cleanup?: (workspace: WorkspaceRef) => Promise<Outcome<void, never, 'cleanup-failed'>>
  /** Unique run IDs for new runs; default: `run-<random hex>`. */
  readonly newRunId?: () => string
  /** Sealed-record timestamps; defaults to the §14 format now. */
  readonly now?: () => string
  /** Operator interruption, forwarded to Work attempts (§9, §17). */
  readonly signal?: AbortSignal
  /** Budget for settling one recovered live process group (§13.2). */
  readonly agentSettleTimeoutMs?: number
}

/** The bound target and delivery facts of one run's repository (§14). */
type BoundFacts = ShipFacts & DeliveryTargetFacts

/** Per-invocation run context shared by every wave. */
type RunContext = {
  readonly deps: RunLifecycleDeps
  readonly locator: MapIssueLocator
  readonly repositoryHome: string
  readonly encodedMapIssueId: string
  readonly repositoryRoot: string
  readonly remote: string
  readonly branch: string
  readonly config: ResolvedRunConfig
  readonly configRevision: string
  readonly gate: EvidenceGateV1
  readonly actorId: string
  readonly reviewerFamily: string
  readonly facts: BoundFacts
  /** Whether this run has performed (or provably attempted) a shared write. */
  sharedWrite: boolean
  readonly warnings: string[]
  /** Ticket references by issue ID, accumulated across every snapshot read. */
  readonly ticketRefs: Map<string, TicketRef>
  /** The most recent stable snapshot read, for terminal report building. */
  lastSnapshot: TaskMapSnapshot | undefined
}

/** Internal step result: continue with the next state, or stop with an outcome. */
type Step<T> =
  | { readonly kind: 'next'; readonly state: RunState; readonly value: T }
  | { readonly kind: 'stop'; readonly outcome: RunMapOutcome }

type StepResult = Step<null>

// ---------------------------------------------------------------------------
// OID normalization for the bound facts seam
// ---------------------------------------------------------------------------

function stripOid(oid: string): string {
  const separator = oid.indexOf(':')
  return separator === -1 ? oid : oid.slice(separator + 1)
}

function objectFormatOf(oid: string): 'sha1' | 'sha256' {
  return stripOid(oid).length === 64 ? 'sha256' : 'sha1'
}

function normalizeOid(format: 'sha1' | 'sha256', value: string): string {
  if (GIT_OBJECT_OID_PATTERN.test(value)) return value
  return formatGitObjectOid(format, value) ?? value
}

/**
 * Bind the read-only Git delivery facts to one repository root and remote,
 * normalizing OIDs: inputs accept either raw hex or object-format-prefixed
 * OIDs (records store prefixed OIDs per §10.3), and `commitFacts` returns
 * prefixed OIDs so §14 record comparisons match exactly.
 */
function bindFacts(
  gitFacts: CheckMapDeps['gitFacts'],
  root: string,
  remote: string,
): BoundFacts {
  return {
    fetchTarget: (branch) => gitFacts.fetchTarget(root, remote, branch),
    targetSha: async (branch) => {
      const read = await gitFacts.targetSha(root, remote, branch)
      if (read.kind !== 'ok') return read
      return ok(normalizeOid(read.value.length === 64 ? 'sha256' : 'sha1', read.value))
    },
    commitFacts: async (sha) => {
      const read = await gitFacts.commitFacts(root, stripOid(sha))
      if (read.kind !== 'ok' || read.value === undefined) return read
      const format = objectFormatOf(sha)
      return ok({
        treeOid: normalizeOid(format, read.value.treeOid),
        parents: read.value.parents.map((parent) => normalizeOid(format, parent)),
      })
    },
    isAncestorOfTarget: (sha, branch) =>
      gitFacts.isAncestorOfTarget(root, remote, branch, stripOid(sha)),
  }
}

// ---------------------------------------------------------------------------
// The run operation (§2.3, §13.2)
// ---------------------------------------------------------------------------

/**
 * Execute `/norn run <map-url>`: preflight, then create or resume one run
 * for the complete Task Map under the map lock, and drive Waves until a
 * terminal `RunReport` or a recoverable interruption. A second live
 * coordinator for the same map is refused by the OS-backed map lock; a
 * persisted `running` state is resumed only under the same `configRevision`
 * and Norn version; terminal and aborted runs are followed by a fresh run
 * ID with an empty parked set.
 */
export async function runMap(deps: RunLifecycleDeps, mapUrl: string): Promise<RunMapOutcome> {
  // --- preflight: exactly the `/norn check` protocol (§2.3) -----------------

  const preflight = await checkMap(
    {
      cwd: deps.cwd,
      git: deps.git,
      gateway: deps.gateway,
      loader: deps.loader,
      store: deps.store,
      catalog: deps.catalog,
      evidence: deps.evidence,
      gitFacts: deps.gitFacts,
    },
    mapUrl,
  )
  if (preflight.kind === 'error') {
    return error({
      scope: 'operation',
      code: preflight.code as never,
      reason: preflight.reason,
      evidence: [...preflight.evidence],
    })
  }
  if (preflight.kind === 'blocked') {
    return blocked({
      scope: 'operation',
      code: 'check-findings',
      reason: preflight.reason,
      sharedWrite: 'none',
      evidence: [...preflight.evidence],
    })
  }
  const checked = preflight.value
  const locator = checked.locator!
  const snapshot = checked.snapshot!
  const config: RunConfigResolution = checked.config!
  const repositoryHome = checked.repositoryHome!
  const encodedMapIssueId = encodePathSegment(snapshot.ref.issueId)

  // --- repository root and matching remote (preflight proved they exist) ---

  const rootRead = await deps.git.resolveRoot(deps.cwd)
  if (rootRead.kind !== 'ok') {
    return error({ scope: 'operation', code: rootRead.code as never, reason: rootRead.reason })
  }
  const remotesRead = await deps.git.listRemotes(rootRead.value)
  if (remotesRead.kind !== 'ok') {
    return error({ scope: 'operation', code: remotesRead.code as never, reason: remotesRead.reason })
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
      code: 'check-findings',
      reason: 'the map repository no longer matches a plausible local remote',
      sharedWrite: 'none',
      evidence: [{ mapUrl }],
    })
  }
  const remote = match.remoteNames[0]!

  // --- the authenticated actor must be a trusted evidence author (§8) ------

  const actorRead = await deps.gateway.authenticatedActor(locator.githubHost)
  if (actorRead.kind !== 'ok') {
    return error({ scope: 'operation', code: 'github-unavailable', reason: actorRead.reason })
  }
  if (!config.config.trustedEvidenceAuthorIds.includes(actorRead.value.id)) {
    return blocked({
      scope: 'operation',
      code: 'check-findings',
      reason:
        `the authenticated GitHub actor (${actorRead.value.login}) is not in ` +
        'trustedEvidenceAuthorIds; delivery evidence this run writes could never validate',
      sharedWrite: 'none',
      evidence: [{ actorId: actorRead.value.id }],
    })
  }

  // --- model families for the sealed gate (§14) ----------------------------

  const modelsRead = await deps.catalog.listModels()
  if (modelsRead.kind !== 'ok') {
    return error({ scope: 'operation', code: modelsRead.code as never, reason: modelsRead.reason })
  }
  const families = new Map(modelsRead.value.map((model) => [model.id, model.family]))
  const workerFamily = families.get(config.config.worker.model)
  const reviewerFamily = families.get(config.config.reviewer.model)
  if (workerFamily === undefined || reviewerFamily === undefined) {
    return blocked({
      scope: 'operation',
      code: 'check-findings',
      reason: 'a configured model disappeared from the catalog between checks',
      sharedWrite: 'none',
      evidence: [{ worker: config.config.worker.model, reviewer: config.config.reviewer.model }],
    })
  }
  const gate: EvidenceGateV1 = {
    worker: {
      provider: modelProvider(config.config.worker.model),
      model: config.config.worker.model,
      family: workerFamily,
      thinking: config.config.worker.thinking,
    },
    reviewer: {
      provider: modelProvider(config.config.reviewer.model),
      model: config.config.reviewer.model,
      family: reviewerFamily,
      thinking: config.config.reviewer.thinking,
    },
    tests: config.config.tests.map((test) => ({ argv: [...test.argv], timeoutMs: test.timeoutMs })),
  }

  // --- the map lock: one live coordinator per Task Map (§16) ----------------

  const mapLock = await acquireMapLock(repositoryHome, encodedMapIssueId)
  if (mapLock.kind === 'blocked') {
    return blocked({
      scope: 'operation',
      code: 'lock-held',
      reason:
        `another live coordinator holds the map lock for ${snapshot.ref.url}; ` +
        'a second run for the same map starts only after the previous run is terminal or aborted',
      sharedWrite: 'none',
      evidence: [{ mapUrl }],
    })
  }
  if (mapLock.kind === 'error') {
    return error({ scope: 'operation', code: 'lock-failed', reason: mapLock.reason })
  }

  try {
    // --- create or resume the one Run State document (§13.2) ----------------

    const existingRead = loadRunState(repositoryHome, encodedMapIssueId)
    if (existingRead.kind !== 'ok') {
      return error({ scope: 'operation', code: existingRead.code as never, reason: existingRead.reason })
    }

    let state: RunState
    if (existingRead.value !== undefined && existingRead.value.status === 'running') {
      const mismatches: string[] = []
      if (existingRead.value.configRevision !== config.configRevision) mismatches.push('configRevision')
      if (existingRead.value.nornVersion !== NORN_VERSION) mismatches.push('nornVersion')
      if (mismatches.length > 0) {
        return blocked({
          scope: 'operation',
          code: 'state-not-resumable',
          reason:
            `the running state for this map (run ${existingRead.value.runId}) is not resumable: ` +
            `${mismatches.join(' and ')} differ; restore them or abort the run before starting a new one`,
          sharedWrite: 'none',
          evidence: [{ runId: existingRead.value.runId, mismatches }],
        })
      }
      state = existingRead.value
    } else {
      const payload = snapshotMapPayload(snapshot)
      if (payload.revision !== snapshot.mapRevision) {
        return error({
          scope: 'operation',
          code: 'state-integrity',
          reason: 'the preflight snapshot does not re-hash to its own map revision',
        })
      }
      const newRunId = deps.newRunId?.() ?? defaultRunId()
      if (!isTameId(newRunId)) {
        return error({
          scope: 'operation',
          code: 'state-integrity',
          reason: `the generated run ID "${newRunId}" is not run-qualified`,
        })
      }
      state = {
        schema: 'norn-run-state:v1',
        runId: newRunId,
        map: snapshot.ref,
        acceptedMapRevisions: [{ revision: snapshot.mapRevision, payload: payload.payload }],
        configRevision: config.configRevision,
        nornVersion: NORN_VERSION,
        status: 'running',
        wave: 0,
        parkedTickets: [],
        tickets: {},
        activeProcesses: [],
      }
      const saved = saveRunState(repositoryHome, encodedMapIssueId, state)
      if (saved.kind !== 'ok') {
        return error({ scope: 'operation', code: saved.code as never, reason: saved.reason })
      }
    }

    const ctx: RunContext = {
      deps,
      locator,
      repositoryHome,
      encodedMapIssueId,
      repositoryRoot: rootRead.value,
      remote,
      branch: config.config.targetBranch,
      config: config.config,
      configRevision: config.configRevision,
      gate,
      actorId: actorRead.value.id,
      reviewerFamily,
      facts: bindFacts(deps.gitFacts, rootRead.value, remote),
      sharedWrite: persistedSharedWrite(state),
      warnings: [],
      ticketRefs: new Map(snapshot.tickets.map((ticket) => [ticket.ref.issueId, ticket.ref])),
      lastSnapshot: snapshot,
    }

    return await executeWaves(ctx, state)
  } finally {
    // The OS-backed lock auto-releases with the process; a release failure
    // after an outcome was chosen cannot change that outcome.
    await mapLock.value.release()
  }
}

function defaultRunId(): string {
  return `run-${randomBytes(8).toString('hex')}`
}

function isTameId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,127}$/.test(value)
}

/**
 * Whether the persisted state already proves this run attempted or performed
 * a shared write (§13.2): a push attempt was counted, or a checkpoint stage
 * beyond `prepared` was remotely confirmed.
 */
function persistedSharedWrite(state: RunState): boolean {
  for (const ticket of Object.values(state.tickets)) {
    if (ticket.phase !== 'shipping') continue
    if (ticket.checkpoint.pushAttempts > 0 || ticket.checkpoint.stage !== 'prepared') return true
  }
  return false
}

// ---------------------------------------------------------------------------
// The wave loop (§12)
// ---------------------------------------------------------------------------

async function executeWaves(ctx: RunContext, initial: RunState): Promise<RunMapOutcome> {
  const reconciled = await reconcileActiveProcesses(ctx, initial)
  if (reconciled.kind === 'stop') return reconciled.outcome
  let state = reconciled.state

  for (;;) {
    // --- resume a persisted ship queue before anything else (§13.2) ---------

    if (state.activeWave !== undefined && state.activeWave.shipQueueTicketIssueIds.length > 0) {
      const shipped = await shipWaveQueue(ctx, state)
      if (shipped.kind === 'stop') return shipped.outcome
      const cleared = clearActiveWave(ctx, shipped.state)
      if (cleared.kind === 'stop') return cleared.outcome
      state = cleared.state
      continue
    }

    // --- wave start: read, classify, adopt, validate members (§12) ----------

    const planned = await planWave(ctx, state)
    if (planned.kind === 'stop') return planned.outcome
    state = planned.state
    const snapshot = planned.value

    if (state.activeWave === undefined) {
      const frontier = computeFrontier(state, snapshot)
      if (frontier.length === 0) {
        const finished = await finishRun(ctx, state, snapshot)
        if (finished.kind === 'stop') return finished.outcome
        state = finished.state // an extension was adopted; the frontier repeats
        continue
      }
      const begun = await beginWave(ctx, state, frontier)
      if (begun.kind === 'stop') return begun.outcome
      state = begun.state
    }

    // --- parallel Work, bounded by repository-wide concurrency (§12) --------

    const worked = await runFrontierWork(ctx, state, snapshot)
    if (worked.kind === 'stop') return worked.outcome
    state = worked.state

    // --- barrier: re-read, classify, adopt or invalidate (§12) --------------

    const barrier = await waveBarrier(ctx, state)
    if (barrier.kind === 'stop') return barrier.outcome
    state = barrier.state

    // --- the persisted ship queue, in issue-number order (§12) --------------

    const queued = persistShipQueue(ctx, state)
    if (queued.kind === 'stop') return queued.outcome
    state = queued.state
    if (state.activeWave!.shipQueueTicketIssueIds.length === 0) {
      const cleared = clearActiveWave(ctx, state)
      if (cleared.kind === 'stop') return cleared.outcome
      state = cleared.state
      continue
    }

    const shipped = await shipWaveQueue(ctx, state)
    if (shipped.kind === 'stop') return shipped.outcome
    const cleared = clearActiveWave(ctx, shipped.state)
    if (cleared.kind === 'stop') return cleared.outcome
    state = cleared.state
  }
}

// ---------------------------------------------------------------------------
// Wave start: stable read, classification, extension adoption, member validation
// ---------------------------------------------------------------------------

/**
 * The wave-start protocol: one stable read of the map, §7.4 classification
 * against the latest accepted revision (adopting Compatible Map Extensions
 * atomically), and §14 validation of every member that is not mid-flight.
 */
async function planWave(ctx: RunContext, state: RunState): Promise<Step<TaskMapSnapshot>> {
  const stabilized = await stabilizeMap(ctx, state)
  if (stabilized.kind === 'stop') return stabilized
  const validated = await validateMembers(ctx, stabilized.state, stabilized.value)
  if (validated.kind === 'stop') return { kind: 'stop', outcome: validated.outcome }
  return { kind: 'next', state: validated.state, value: stabilized.value }
}

/** One stable read of the current Task Map snapshot (§7.3). */
function readMapSnapshot(ctx: RunContext): Promise<StableSnapshotOutcome> {
  return stableReadTaskMap(() => ctx.deps.loader.loadTaskMap(ctx.locator))
}

/** Map one stable-read failure onto the run outcome (§7.4: unstable is incompatible). */
function mapReadFailure(
  ctx: RunContext,
  read: Extract<StableSnapshotOutcome, { readonly kind: 'blocked' | 'error' }>,
): RunMapOutcome {
  if (read.kind === 'error') {
    return runFailure(ctx, normalizeErrorCode(read.code), `the stable Task Map read failed: ${read.reason}`, [
      ...read.evidence,
    ])
  }
  return terminalFailure(ctx, undefined, 'blocked', 'changed-input',
    `the Task Map can no longer be read stably (${read.code})`, [...read.evidence])
}

/** One stable read plus §7.4 classification and extension adoption. */
async function stabilizeMap(ctx: RunContext, state: RunState): Promise<Step<TaskMapSnapshot>> {
  const read = await readMapSnapshot(ctx)
  if (read.kind !== 'ok') return { kind: 'stop', outcome: mapReadFailure(ctx, read) }
  const snapshot = read.value
  ctx.lastSnapshot = snapshot
  for (const ticket of snapshot.tickets) ctx.ticketRefs.set(ticket.ref.issueId, ticket.ref)

  if (snapshot.state !== 'OPEN') {
    // §12: a Task Map that is no longer OPEN ships nothing further.
    return {
      kind: 'stop',
      outcome: terminalFailure(ctx, state, 'blocked', 'changed-input',
        `the Task Map is no longer OPEN (state: ${snapshot.state}); no remaining result ships`,
        [{ mapState: snapshot.state, mapRevision: snapshot.mapRevision }]),
    }
  }

  const latest = state.acceptedMapRevisions.at(-1)!
  const classification = classifyMapChange(acceptedSnapshotFrom(latest, snapshot.ref), snapshot)
  if (classification.kind === 'incompatible') {
    return {
      kind: 'stop',
      outcome: terminalFailure(ctx, state, 'blocked', 'changed-input',
        'the Task Map changed incompatibly against the accepted revision; ' +
          'no remaining result from this run ships',
        [{ kind: 'incompatible', reasons: classification.reasons }]),
    }
  }
  if (classification.kind === 'compatible-extension') {
    const adopted = await adoptExtension(ctx, state, snapshot, classification.addedTicketIssueIds)
    if (adopted.kind === 'stop') return { kind: 'stop', outcome: adopted.outcome }
    state = adopted.state
  }
  return { kind: 'next', state, value: snapshot }
}

/**
 * Validate every member that is not mid-flight (§12 "validate all previously
 * completed members"): each member's complete §14 evidence is re-evaluated
 * against current remote truth. A valid Completed Ticket is recorded (or
 * confirmed); an open member without a record stays workable; anything else
 * is an integrity or operator-decision block (§14) and ends the run.
 */
async function validateMembers(
  ctx: RunContext,
  state: RunState,
  snapshot: TaskMapSnapshot,
): Promise<StepResult> {
  let fetched = false
  const facts: DeliveryTargetFacts = {
    async targetSha(branch) {
      if (!fetched) {
        const fetch = await ctx.facts.fetchTarget(branch)
        if (fetch.kind !== 'ok') return fetch
        fetched = true
      }
      return ctx.facts.targetSha(branch)
    },
    commitFacts: (sha) => ctx.facts.commitFacts(sha),
    isAncestorOfTarget: (sha, branch) => ctx.facts.isAncestorOfTarget(sha, branch),
  }

  let next = state
  let mutated = false
  for (const ticket of snapshot.tickets) {
    ctx.ticketRefs.set(ticket.ref.issueId, ticket.ref)
    const record = next.tickets[ticket.ref.issueId]
    if (
      record !== undefined &&
      (record.phase === 'working' || record.phase === 'shipping' || record.phase === 'shippable')
    ) {
      continue // mid-flight: owned by the active wave
    }

    const read = await ctx.deps.evidence.loadIssueEvidence({
      githubHost: ticket.ref.githubHost,
      number: ticket.ref.number,
      url: ticket.ref.url,
    })
    if (read.kind === 'error') {
      return {
        kind: 'stop',
        outcome: runFailure(ctx, 'evidence-read',
          `reading delivery evidence of member #${ticket.ref.number} failed: ${read.reason}`,
          [{ ticketIssueId: ticket.ref.issueId }]),
      }
    }
    if (read.kind === 'blocked') {
      return {
        kind: 'stop',
        outcome: terminalFailure(ctx, next, 'blocked', 'changed-input',
          `delivery evidence of member #${ticket.ref.number} could not be read: ${read.reason}`,
          [{ ticketIssueId: ticket.ref.issueId, code: read.code }]),
      }
    }
    const evaluation = await evaluateDeliveryEvidence({
      map: { issueId: snapshot.ref.issueId, repositoryId: snapshot.ref.repositoryId },
      ticket: {
        issueId: ticket.ref.issueId,
        state: ticket.state,
        ticketRevision: ticket.ticketRevision,
      },
      targetBranch: ctx.branch,
      trustedEvidenceAuthorIds: ctx.config.trustedEvidenceAuthorIds,
      evidence: read.value,
      facts,
    })
    if (evaluation.status === 'error') {
      return {
        kind: 'stop',
        outcome: runFailure(ctx, 'target-read',
          `validating member #${ticket.ref.number} failed: ${evaluation.reason}`,
          [{ ticketIssueId: ticket.ref.issueId, code: evaluation.code }]),
      }
    }
    if (evaluation.status === 'completed') {
      if (evaluation.record.run.id === next.runId) ctx.sharedWrite = true
      next = withCompletedTicket(next, ticket.ref.issueId, {
        deliveryId: evaluation.record.deliveryId,
        integratedSha: evaluation.record.target.integratedSha,
      })
      mutated = true
      continue
    }
    if (evaluation.status === 'no-record' && ticket.state === 'OPEN') {
      if (record === undefined) {
        next = withTicket(next, ticket.ref.issueId, { phase: 'waiting' })
        mutated = true
      }
      continue
    }
    // A closed member without a valid record, or an open member carrying
    // otherwise-valid evidence, is integrity- or operator-blocked (§14).
    return {
      kind: 'stop',
      outcome: terminalFailure(ctx, next, 'blocked', 'changed-input',
        `member #${ticket.ref.number} fails delivery-evidence validation; ` +
          'the operator must resolve it before Norn continues',
        [
          {
            ticketIssueId: ticket.ref.issueId,
            ticketState: ticket.state,
            status: evaluation.status,
            findings: evaluation.status === 'findings' ? [...evaluation.findings] : [],
          },
        ]),
    }
  }

  if (mutated) {
    const saved = saveRunState(ctx.repositoryHome, ctx.encodedMapIssueId, next)
    if (saved.kind !== 'ok') {
      return {
        kind: 'stop',
        outcome: runFailure(ctx, saved.code as never,
          `persisting member validation failed: ${saved.reason}`),
      }
    }
  }
  return { kind: 'next', state: next, value: null }
}

// ---------------------------------------------------------------------------
// Extension adoption (§7.4, §16)
// ---------------------------------------------------------------------------

/**
 * Adopt one Compatible Map Extension: per-member preflight of every added
 * Ticket (§14 evidence and active-run ownership), then — under the
 * repository control lock, with ownership rechecked — one atomic Run State
 * update appending the revision lineage entry and claiming the added Ticket
 * IDs. A blocked added-Ticket preflight prevents adoption and is treated as
 * an incompatible change; an errored one returns `error`.
 */
async function adoptExtension(
  ctx: RunContext,
  state: RunState,
  snapshot: TaskMapSnapshot,
  addedTicketIssueIds: readonly string[],
): Promise<StepResult> {
  // --- per-member preflight, before any lock (§7.4) -------------------------

  const newRecords: Record<string, TicketRunState> = {}
  for (const issueId of addedTicketIssueIds) {
    const ticket = snapshot.tickets.find((entry) => entry.ref.issueId === issueId)!
    const read = await ctx.deps.evidence.loadIssueEvidence({
      githubHost: ticket.ref.githubHost,
      number: ticket.ref.number,
      url: ticket.ref.url,
    })
    if (read.kind === 'error') {
      return {
        kind: 'stop',
        outcome: runFailure(ctx, 'evidence-read',
          `reading delivery evidence of added ticket #${ticket.ref.number} failed: ${read.reason}`,
          [{ ticketIssueId: issueId }]),
      }
    }
    if (read.kind === 'blocked') {
      return {
        kind: 'stop',
        outcome: terminalFailure(ctx, state, 'blocked', 'changed-input',
          `delivery evidence of added ticket #${ticket.ref.number} could not be read: ${read.reason}`,
          [{ ticketIssueId: issueId, code: read.code }]),
      }
    }
    const fetched = await ctx.facts.fetchTarget(ctx.branch)
    if (fetched.kind !== 'ok') {
      return {
        kind: 'stop',
        outcome: runFailure(ctx, 'target-read',
          `fetching the target while preflighting an added ticket failed: ${fetched.reason}`),
      }
    }
    const evaluation = await evaluateDeliveryEvidence({
      map: { issueId: snapshot.ref.issueId, repositoryId: snapshot.ref.repositoryId },
      ticket: { issueId, state: ticket.state, ticketRevision: ticket.ticketRevision },
      targetBranch: ctx.branch,
      trustedEvidenceAuthorIds: ctx.config.trustedEvidenceAuthorIds,
      evidence: read.value,
      facts: ctx.facts,
    })
    if (evaluation.status === 'error') {
      return {
        kind: 'stop',
        outcome: runFailure(ctx, 'target-read',
          `validating added ticket #${ticket.ref.number} failed: ${evaluation.reason}`,
          [{ ticketIssueId: issueId, code: evaluation.code }]),
      }
    }
    if (evaluation.status === 'completed') {
      if (evaluation.record.run.id === state.runId) ctx.sharedWrite = true
      newRecords[issueId] = {
        phase: 'completed',
        deliveryId: evaluation.record.deliveryId,
        integratedSha: evaluation.record.target.integratedSha,
      }
      continue
    }
    if (evaluation.status === 'no-record' && ticket.state === 'OPEN') {
      newRecords[issueId] = { phase: 'waiting' }
      continue
    }
    return {
      kind: 'stop',
      outcome: terminalFailure(ctx, state, 'blocked', 'changed-input',
        `added ticket #${ticket.ref.number} fails per-member preflight; ` +
          'adoption is prevented and the change is incompatible',
        [
          {
            ticketIssueId: issueId,
            ticketState: ticket.state,
            status: evaluation.status,
            findings: evaluation.status === 'findings' ? [...evaluation.findings] : [],
          },
        ]),
    }
  }

  // --- active-run ownership of the added Ticket IDs (§7.4, §16) -------------

  const overlap = await claimedByOtherRun(ctx, state.runId, addedTicketIssueIds)
  if (overlap.kind !== 'ok') {
    return { kind: 'stop', outcome: runFailure(ctx, overlap.code, overlap.reason) }
  }
  if (overlap.value !== undefined) {
    return {
      kind: 'stop',
      outcome: terminalFailure(ctx, state, 'blocked', 'changed-input',
        `added ticket(s) ${overlap.value.join(', ')} are already claimed by another active run; ` +
          'adoption is prevented',
        [{ claimedTicketIssueIds: overlap.value }]),
    }
  }

  // --- the repository control lock: recheck, then one atomic update --------

  const payload = snapshotMapPayload(snapshot)
  const extension: ShipExtensionAdoption = {
    revision: snapshot.mapRevision,
    payload: payload.payload,
    fromRevision: state.acceptedMapRevisions.at(-1)!.revision,
    addedTicketIssueIds: [...addedTicketIssueIds],
  }
  const adopted = await adoptUnderControlLock(ctx, state.runId, extension, newRecords)
  if (adopted.kind !== 'ok') {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, adopted.code,
        `adopting a Compatible Map Extension failed: ${adopted.reason}`,
        [...adopted.evidence]),
    }
  }
  return { kind: 'next', state: adopted.value, value: null }
}

/** Which of `issueIds` another running run claims, if any. */
async function claimedByOtherRun(
  ctx: RunContext,
  runId: string,
  issueIds: readonly string[],
): Promise<Outcome<string[] | undefined, never, 'control-store' | 'state-integrity'>> {
  const states = await loadAllRunStates(ctx.repositoryHome)
  if (states.kind !== 'ok') return states
  for (const state of states.value.values()) {
    if (state.runId === runId || state.status !== 'running') continue
    const claimed = new Set(
      state.acceptedMapRevisions.at(-1)!.payload.members.map((member) => member.ticketIssueId),
    )
    const overlap = issueIds.filter((id) => claimed.has(id))
    if (overlap.length > 0) return ok(overlap)
  }
  return ok(undefined)
}

/**
 * The §7.4/§16 adoption core, shared by the coordinator and the Ship
 * adoption seam: under the repository control lock, recheck active
 * ownership, then atomically append the lineage entry and claim the added
 * Ticket IDs in one Run State update.
 */
async function adoptUnderControlLock(
  ctx: RunContext,
  runId: string,
  extension: ShipExtensionAdoption,
  newRecords: Record<string, TicketRunState>,
): Promise<Outcome<RunState, never, 'control-store' | 'state-integrity' | 'lock-failed'>> {
  const lock = await acquireControlLock(ctx.repositoryHome)
  if (lock.kind !== 'ok') {
    return error({
      scope: 'run',
      code: 'lock-failed',
      reason: `acquiring the repository control lock failed: ${lock.reason}`,
      sharedWrite: 'none',
    })
  }
  try {
    const overlap = await claimedByOtherRun(ctx, runId, extension.addedTicketIssueIds)
    if (overlap.kind !== 'ok') return overlap
    if (overlap.value !== undefined) {
      return error({
        scope: 'run',
        code: 'control-store',
        reason: `added ticket(s) ${overlap.value.join(', ')} are claimed by another active run`,
        sharedWrite: 'none',
        evidence: [{ claimedTicketIssueIds: overlap.value }],
      })
    }

    const loaded = loadRunState(ctx.repositoryHome, ctx.encodedMapIssueId)
    if (loaded.kind !== 'ok') return loaded
    if (loaded.value === undefined || loaded.value.runId !== runId) {
      return error({
        scope: 'run',
        code: 'control-store',
        reason: 'the run state to adopt the extension into no longer exists',
        sharedWrite: 'none',
      })
    }
    const state = loaded.value
    const latest = state.acceptedMapRevisions.at(-1)!
    if (latest.revision !== extension.fromRevision) {
      return error({
        scope: 'run',
        code: 'state-integrity',
        reason:
          `the persisted latest accepted revision moved to ${latest.revision} ` +
          `while the extension from ${extension.fromRevision} was being adopted`,
        sharedWrite: 'none',
      })
    }
    const next: RunState = {
      ...state,
      acceptedMapRevisions: [
        ...state.acceptedMapRevisions,
        {
          revision: extension.revision,
          payload: extension.payload,
          extension: {
            fromRevision: extension.fromRevision,
            addedTicketIssueIds: [...extension.addedTicketIssueIds],
          },
        },
      ],
      tickets: { ...state.tickets, ...newRecords },
    }
    const saved = saveRunState(ctx.repositoryHome, ctx.encodedMapIssueId, next)
    if (saved.kind !== 'ok') return saved
    return ok(next)
  } finally {
    await lock.value.release()
  }
}

// ---------------------------------------------------------------------------
// Frontier computation and wave persistence (§12)
// ---------------------------------------------------------------------------

/** The currently eligible Tickets: OPEN, not parked, blockers all Completed. */
function computeFrontier(state: RunState, snapshot: TaskMapSnapshot): readonly TicketRef[] {
  const completed = new Set(
    Object.entries(state.tickets)
      .filter(([, record]) => record.phase === 'completed')
      .map(([issueId]) => issueId),
  )
  return snapshot.tickets
    .filter((ticket) => {
      if (ticket.state !== 'OPEN') return false
      const record = state.tickets[ticket.ref.issueId]
      if (record !== undefined && record.phase !== 'waiting') return false
      return ticket.blockedBy.every((blocker) => completed.has(blocker.issueId))
    })
    .sort((a, b) => a.ref.number - b.ref.number)
    .map((ticket) => ticket.ref)
}

/** Capture the wave's target snapshot: branch, tip commit, and its tree. */
async function captureTarget(
  ctx: RunContext,
): Promise<Outcome<{ readonly sha: GitObjectOid; readonly treeOid: GitObjectOid }, never, RunErrorCode>> {
  const fetched = await ctx.facts.fetchTarget(ctx.branch)
  if (fetched.kind !== 'ok') {
    return error({ scope: 'run', code: 'target-read', reason: `fetching the target branch failed: ${fetched.reason}` })
  }
  const shaRead = await ctx.facts.targetSha(ctx.branch)
  if (shaRead.kind !== 'ok') {
    return error({ scope: 'run', code: 'target-read', reason: `reading the target tip failed: ${shaRead.reason}` })
  }
  const format: 'sha1' | 'sha256' = shaRead.value.length === 64 ? 'sha256' : 'sha1'
  const sha = normalizeOid(format, shaRead.value)
  const commit = await ctx.facts.commitFacts(sha)
  if (commit.kind !== 'ok') {
    return error({ scope: 'run', code: 'target-read', reason: `reading the target commit failed: ${commit.reason}` })
  }
  if (commit.value === undefined) {
    return error({ scope: 'run', code: 'target-read', reason: `the target commit ${sha} is absent after the fetch` })
  }
  return ok({ sha, treeOid: normalizeOid(format, commit.value.treeOid) })
}

/**
 * Begin one Wave: persist the WaveState — the frontier, the wave's captured
 * map revision and target snapshot, and the (still empty) ship queue —
 * before any Work attempt or child process exists (§12, §13.1).
 */
async function beginWave(
  ctx: RunContext,
  state: RunState,
  frontier: readonly TicketRef[],
): Promise<StepResult> {
  const target = await captureTarget(ctx)
  if (target.kind !== 'ok') {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, target.code, `capturing the wave's target snapshot failed: ${target.reason}`),
    }
  }
  const loaded = loadRunState(ctx.repositoryHome, ctx.encodedMapIssueId)
  if (loaded.kind !== 'ok') {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, loaded.code as never,
        `reloading run state to begin the wave failed: ${loaded.reason}`),
    }
  }
  const current = loaded.value!
  const number = current.wave + 1
  const next: RunState = {
    ...current,
    wave: number,
    activeWave: {
      number,
      mapRevision: current.acceptedMapRevisions.at(-1)!.revision,
      target: {
        branch: ctx.branch,
        baseSha: target.value.sha,
        baseTreeOid: target.value.treeOid,
      },
      frontierTicketIssueIds: frontier.map((ref) => ref.issueId),
      shipQueueTicketIssueIds: [],
      nextShipIndex: 0,
    },
  }
  const saved = saveRunState(ctx.repositoryHome, ctx.encodedMapIssueId, next)
  if (saved.kind !== 'ok') {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, saved.code as never, `persisting the new wave failed: ${saved.reason}`),
    }
  }
  return { kind: 'next', state: next, value: null }
}

// ---------------------------------------------------------------------------
// Parallel Work (§12)
// ---------------------------------------------------------------------------

/** One frontier Ticket the wave will Work. */
type WorkEntry = {
  readonly ref: TicketRef
  readonly workAttemptId: string
}

/**
 * Drive the active wave's frontier in parallel, bounded by the configured
 * repository-wide concurrency (§8, §16): each still-eligible Ticket's Work
 * attempt runs (or resumes) through the §10.2 round gate. Ticket-scoped
 * non-success outcomes park the Ticket; descendants stay waiting;
 * independent branches continue. A run-scoped failure stops the run only
 * after every in-flight attempt has settled and persisted its outcome.
 */
async function runFrontierWork(
  ctx: RunContext,
  state: RunState,
  snapshot: TaskMapSnapshot,
): Promise<StepResult> {
  const wave = state.activeWave!
  const entries: WorkEntry[] = wave.frontierTicketIssueIds.flatMap((issueId) => {
    const record = state.tickets[issueId]
    if (record === undefined) return []
    if (record.phase !== 'waiting' && record.phase !== 'working') return []
    const ref =
      snapshot.tickets.find((ticket) => ticket.ref.issueId === issueId)?.ref ??
      ctx.ticketRefs.get(issueId)
    if (ref === undefined) return []
    return [{ ref, workAttemptId: `wa-w${wave.number}-t${ref.number}` }]
  })

  let failure: { readonly code: RunErrorCode; readonly reason: string; readonly evidence: Evidence[] } | undefined

  await runBounded(entries, ctx.config.concurrency, async (entry) => {
    const outcome = await runOneWork(ctx, state, snapshot, wave, entry)
    if (outcome.kind !== 'ok' && outcome.scope === 'run' && failure === undefined) {
      failure = {
        code: normalizeErrorCode(outcome.code),
        reason: outcome.reason,
        evidence: [...outcome.evidence],
      }
    }
  })

  const reloaded = loadRunState(ctx.repositoryHome, ctx.encodedMapIssueId)
  if (reloaded.kind !== 'ok') {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, reloaded.code as never,
        `reloading run state after Work failed: ${reloaded.reason}`),
    }
  }
  if (failure !== undefined) {
    return { kind: 'stop', outcome: runFailure(ctx, failure.code, failure.reason, failure.evidence) }
  }
  return { kind: 'next', state: reloaded.value!, value: null }
}

/** One complete Work attempt through the §10.2 round gate. */
async function runOneWork(
  ctx: RunContext,
  state: RunState,
  snapshot: TaskMapSnapshot,
  wave: WaveState,
  entry: WorkEntry,
) {
  const ticket = snapshot.tickets.find((candidate) => candidate.ref.issueId === entry.ref.issueId)!
  const gateDeps: RoundGateDeps = {
    runner: ctx.deps.runner,
    commands: ctx.deps.commands,
    git: ctx.deps.workGit,
    store: runStateWorkAttemptStore({
      repositoryHome: ctx.repositoryHome,
      encodedMapIssueId: ctx.encodedMapIssueId,
      ticketIssueId: entry.ref.issueId,
      wave: wave.number,
    }),
    slots: workSlotSeam({
      repositoryHome: ctx.repositoryHome,
      reservation: workAttemptReservation({
        runId: state.runId,
        mapIssueId: state.map.issueId,
        workAttemptId: entry.workAttemptId,
      }),
      capacity: ctx.config.concurrency,
    }),
    planWorker: ctx.deps.launches.planWorkerFor(entry.workAttemptId, ctx.config.worker),
    planReviewer: ctx.deps.launches.planWorkReviewerFor(entry.workAttemptId, {
      ...ctx.config.reviewer,
      family: ctx.reviewerFamily,
    }),
    reviewerPlanIsReadOnly: ctx.deps.launches.reviewerPlanIsReadOnly,
  }
  const params: WorkAttemptParams = {
    input: {
      ticket: entry.ref,
      spec: {
        mapTitle: snapshot.title,
        mapBody: snapshot.body,
        mapRevision: wave.mapRevision,
        ticketTitle: ticket.title,
        ticketBody: ticket.body,
        ticketRevision: ticket.ticketRevision,
      },
      target: {
        branch: wave.target.branch,
        baseSha: wave.target.baseSha,
        baseTreeOid: wave.target.baseTreeOid,
      },
    },
    workAttemptId: entry.workAttemptId,
    map: {
      githubHost: state.map.githubHost,
      repositoryId: state.map.repositoryId,
      issueId: state.map.issueId,
    },
    repositoryRoot: ctx.repositoryRoot,
    repositoryHome: ctx.repositoryHome,
    repositoryId: state.map.repositoryId,
    runId: state.runId,
    completionsDir: completionsDirFor(ctx.repositoryHome, state.runId),
    setup: ctx.config.setup,
    tests: ctx.config.tests,
    maxWorkRounds: ctx.config.maxWorkRounds,
    agents: {
      worker: ctx.config.worker,
      reviewer: { ...ctx.config.reviewer, family: ctx.reviewerFamily },
    },
    signal: ctx.deps.signal,
  }
  return runWorkAttempt(gateDeps, params)
}

/** Run `task` over `items` with at most `limit` concurrent executions. */
async function runBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      await task(items[index]!)
    }
  })
  await Promise.all(workers)
}

// ---------------------------------------------------------------------------
// The barrier and the ship queue (§12)
// ---------------------------------------------------------------------------

/**
 * The Wave barrier: re-read the stable Map and classify it against the
 * latest accepted revision. An identical revision continues; a Compatible
 * Map Extension is adopted before Ship (its added Tickets join the next
 * frontier); anything else invalidates every remaining unshipped result and
 * ends the run `blocked(changed-input)` (§12).
 */
async function waveBarrier(ctx: RunContext, state: RunState): Promise<StepResult> {
  const stabilized = await stabilizeMap(ctx, state)
  if (stabilized.kind === 'stop') return { kind: 'stop', outcome: stabilized.outcome }
  return { kind: 'next', state: stabilized.state, value: null }
}

/**
 * Build and persist the Wave's ship queue: this wave's sealed successes in
 * issue-number order (§12). The persisted queue is the exact execution
 * order; it is built once, before anything ships, and is never rebuilt —
 * not by restart, not by a later Compatible Map Extension.
 */
function persistShipQueue(ctx: RunContext, state: RunState): StepResult {
  const loaded = loadRunState(ctx.repositoryHome, ctx.encodedMapIssueId)
  if (loaded.kind !== 'ok') {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, loaded.code as never,
        `loading run state to persist the ship queue failed: ${loaded.reason}`),
    }
  }
  const current = loaded.value!
  const wave = current.activeWave
  if (wave === undefined || wave.shipQueueTicketIssueIds.length > 0) {
    return { kind: 'next', state: current, value: null }
  }
  const numberByIssueId = new Map(
    [...ctx.ticketRefs.values()].map((ref) => [ref.issueId, ref.number]),
  )
  const queue = wave.frontierTicketIssueIds
    .filter((issueId) => current.tickets[issueId]?.phase === 'shippable')
    .sort((a, b) => (numberByIssueId.get(a) ?? 0) - (numberByIssueId.get(b) ?? 0))
  const next: RunState = {
    ...current,
    activeWave: { ...wave, shipQueueTicketIssueIds: queue, nextShipIndex: 0 },
  }
  const saved = saveRunState(ctx.repositoryHome, ctx.encodedMapIssueId, next)
  if (saved.kind !== 'ok') {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, saved.code as never, `persisting the ship queue failed: ${saved.reason}`),
    }
  }
  return { kind: 'next', state: next, value: null }
}

// ---------------------------------------------------------------------------
// Serial Ship in issue-number order (§12, §11)
// ---------------------------------------------------------------------------

/**
 * Ship the persisted Wave queue serially from `nextShipIndex`. A ticket-
 * scoped Ship failure parks that Ticket and the queue continues (§9);
 * run-scoped blocked outcomes stop the queue and terminalize; errors after
 * a confirmed or unknown shared write leave the run `running` and resumable.
 */
async function shipWaveQueue(ctx: RunContext, state: RunState): Promise<StepResult> {
  let current = state
  for (;;) {
    const wave = current.activeWave!
    if (wave.nextShipIndex >= wave.shipQueueTicketIssueIds.length) {
      return { kind: 'next', state: current, value: null }
    }
    const issueId = wave.shipQueueTicketIssueIds[wave.nextShipIndex]!
    const record = current.tickets[issueId]
    if (record !== undefined && (record.phase === 'completed' || record.phase === 'parked')) {
      const advanced = advanceShipIndex(ctx, current)
      if (advanced.kind === 'stop') return advanced
      current = advanced.state
      continue
    }
    const shipped = await shipOne(ctx, current, issueId)
    if (shipped.kind === 'stop') return shipped
    const advanced = advanceShipIndex(ctx, shipped.state)
    if (advanced.kind === 'stop') return advanced
    current = advanced.state
  }
}

/** Ship exactly one queued Ticket: `shipPush`, then `shipClose` (§11.3). */
async function shipOne(ctx: RunContext, state: RunState, issueId: string): Promise<StepResult> {
  const record = state.tickets[issueId]
  if (record === undefined || (record.phase !== 'shippable' && record.phase !== 'shipping')) {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, 'state-integrity', `queued ticket ${issueId} is not shippable or shipping`),
    }
  }
  const change = record.change
  const wave = state.activeWave!
  const accepted = state.acceptedMapRevisions.at(-1)!
  const ticket = change.ticket
  ctx.ticketRefs.set(issueId, ticket)

  // The §11.3 adoption seam: the control lock, ownership recheck, and one
  // atomic lineage + claims update (§7.4, §16). Called by push/close during
  // their release-adopt-reacquire dance with the target lock released.
  const adoptExtension = async (extension: ShipExtensionAdoption) => {
    const records = Object.fromEntries(
      extension.addedTicketIssueIds.map((id) => [id, { phase: 'waiting' as const }]),
    )
    const adopted = await adoptUnderControlLock(ctx, state.runId, extension, records)
    if (adopted.kind === 'ok') return ok(undefined)
    // The seam's closed error vocabulary is `control-store`; any richer
    // failure keeps its original code as machine evidence.
    return error({
      scope: 'run' as const,
      code: 'control-store' as const,
      reason: adopted.reason,
      sharedWrite: 'none' as const,
      evidence: [...adopted.evidence, { originalCode: adopted.code }],
    })
  }

  const checkpoint = runStateShipCheckpointStore({
    repositoryHome: ctx.repositoryHome,
    encodedMapIssueId: ctx.encodedMapIssueId,
    ticketIssueId: issueId,
  })
  const lock = ctx.deps.targetLockFor?.(ctx.repositoryHome, ctx.branch) ??
    osTargetLock(ctx.repositoryHome, ctx.branch)

  const pushDeps: ShipPushDeps = {
    git: ctx.deps.workGit,
    gitDetailed: ctx.deps.gitDetailed,
    facts: ctx.facts,
    readMap: () => readMapSnapshot(ctx),
    adoptExtension,
    readIssueEvidence: ctx.deps.evidence.loadIssueEvidence,
    runner: ctx.deps.runner,
    commands: ctx.deps.commands,
    planReviewer: ctx.deps.launches.planShipReviewer({
      ...ctx.config.reviewer,
      family: ctx.reviewerFamily,
    }),
    reviewerPlanIsReadOnly: ctx.deps.launches.reviewerPlanIsReadOnly,
    newInvocationId: ctx.deps.launches.newShipInvocationId,
    push: ctx.deps.push,
    checkpoint,
    lock,
    ...(ctx.deps.now === undefined ? {} : { now: ctx.deps.now }),
  }
  const pushParams: ShipPushParams = {
    change,
    accepted,
    runId: state.runId,
    repositoryRoot: ctx.repositoryRoot,
    targetBranch: ctx.branch,
    setup: ctx.config.setup,
    tests: ctx.config.tests,
    reviewer: { ...ctx.config.reviewer, family: ctx.reviewerFamily },
    trustedEvidenceAuthorIds: ctx.config.trustedEvidenceAuthorIds,
    completionsDir: completionsDirFor(ctx.repositoryHome, state.runId),
    alreadyShipped: ctx.sharedWrite,
    map: state.map,
    wave: wave.number,
    configRevision: ctx.configRevision,
    nornVersion: NORN_VERSION,
    remote: ctx.remote,
    maxPushRetries: ctx.config.maxPushRetries,
    gate: ctx.gate,
    actorId: ctx.actorId,
  }

  const pushed = await shipPush(pushDeps, pushParams)
  if (pushed.kind === 'error') {
    return { kind: 'stop', outcome: failureOutcome(ctx, pushed) }
  }
  if (pushed.kind === 'blocked') {
    if (pushed.scope === 'ticket') {
      return parkQueuedTicket(ctx, issueId, pushed)
    }
    return { kind: 'stop', outcome: failureOutcome(ctx, pushed) }
  }
  if (pushed.value.pushes > 0) ctx.sharedWrite = true

  // --- the close: record comment, close, §14 validation (§11.3) ------------

  const reloaded = loadRunState(ctx.repositoryHome, ctx.encodedMapIssueId)
  if (reloaded.kind !== 'ok') {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, reloaded.code as never,
        `reloading run state before the close of #${ticket.number} failed: ${reloaded.reason}`),
    }
  }
  const closeDeps: ShipCloseDeps = {
    readMap: () => readMapSnapshot(ctx),
    readIssueEvidence: ctx.deps.evidence.loadIssueEvidence,
    writer: ctx.deps.writer,
    facts: ctx.facts,
    adoptExtension,
    checkpoint,
    lock,
    cleanup: ctx.deps.cleanup ?? fsWorkspaceCleanup(),
  }
  const closeParams: ShipCloseParams = {
    map: state.map,
    ticket: change.ticket,
    accepted: reloaded.value!.acceptedMapRevisions.at(-1)!,
    runId: state.runId,
    targetBranch: ctx.branch,
    trustedEvidenceAuthorIds: ctx.config.trustedEvidenceAuthorIds,
    alreadyShipped: ctx.sharedWrite,
  }
  const closed = await shipClose(closeDeps, closeParams)
  if (closed.kind === 'error') {
    return { kind: 'stop', outcome: failureOutcome(ctx, closed) }
  }
  if (closed.kind === 'blocked') {
    return { kind: 'stop', outcome: failureOutcome(ctx, closed) }
  }
  ctx.sharedWrite = true
  ctx.warnings.push(...closed.value.warnings)
  return { kind: 'next', state: reloaded.value!, value: null }
}

/** Persist one queued Ticket's ticket-scoped Ship failure as parked (§12). */
function parkQueuedTicket(
  ctx: RunContext,
  issueId: string,
  outcome: {
    readonly kind: 'blocked' | 'error'
    readonly code: string
    readonly reason: string
    readonly evidence: readonly Evidence[]
  },
): StepResult {
  const loaded = loadRunState(ctx.repositoryHome, ctx.encodedMapIssueId)
  if (loaded.kind !== 'ok') {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, loaded.code as never,
        `reloading run state to park ticket ${issueId} failed: ${loaded.reason}`),
    }
  }
  const current = loaded.value!
  const record = current.tickets[issueId]
  const ref = ctx.ticketRefs.get(issueId)
  const workspace =
    record !== undefined && (record.phase === 'shippable' || record.phase === 'shipping')
      ? record.change.workspace
      : record?.phase === 'parked'
        ? record.workspace
        : undefined
  const next: RunState = {
    ...current,
    tickets: {
      ...current.tickets,
      [issueId]: {
        phase: 'parked',
        wave: current.activeWave?.number ?? current.wave,
        ...(workspace === undefined ? {} : { workspace }),
        outcome: {
          kind: outcome.kind,
          code: outcome.code,
          reason: outcome.reason,
          evidence: [...outcome.evidence],
        },
      },
    },
    parkedTickets:
      current.parkedTickets.some((entry) => entry.issueId === issueId) || ref === undefined
        ? current.parkedTickets
        : [...current.parkedTickets, ref],
  }
  const saved = saveRunState(ctx.repositoryHome, ctx.encodedMapIssueId, next)
  if (saved.kind !== 'ok') {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, saved.code as never,
        `persisting the parked ship outcome of ticket ${issueId} failed: ${saved.reason}`),
    }
  }
  return { kind: 'next', state: next, value: null }
}

/** Advance the persisted ship-queue cursor past the current entry. */
function advanceShipIndex(ctx: RunContext, state: RunState): StepResult {
  const loaded = loadRunState(ctx.repositoryHome, ctx.encodedMapIssueId)
  if (loaded.kind !== 'ok') {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, loaded.code as never,
        `reloading run state to advance the ship queue failed: ${loaded.reason}`),
    }
  }
  const current = loaded.value
  const wave = current?.activeWave
  if (current === undefined || wave === undefined || wave.nextShipIndex >= wave.shipQueueTicketIssueIds.length) {
    return { kind: 'next', state: current ?? state, value: null }
  }
  const next: RunState = {
    ...current,
    activeWave: { ...wave, nextShipIndex: wave.nextShipIndex + 1 },
  }
  const saved = saveRunState(ctx.repositoryHome, ctx.encodedMapIssueId, next)
  if (saved.kind !== 'ok') {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, saved.code as never,
        `persisting the ship queue cursor failed: ${saved.reason}`),
    }
  }
  return { kind: 'next', state: next, value: null }
}

/** Clear the finished Wave so the next one plans from scratch. */
function clearActiveWave(ctx: RunContext, state: RunState): StepResult {
  if (state.activeWave === undefined) return { kind: 'next', state, value: null }
  const loaded = loadRunState(ctx.repositoryHome, ctx.encodedMapIssueId)
  if (loaded.kind !== 'ok') {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, loaded.code as never,
        `reloading run state to close the wave failed: ${loaded.reason}`),
    }
  }
  const current = loaded.value!
  const next: RunState = { ...current, activeWave: undefined }
  const saved = saveRunState(ctx.repositoryHome, ctx.encodedMapIssueId, next)
  if (saved.kind !== 'ok') {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, saved.code as never, `closing the wave failed: ${saved.reason}`),
    }
  }
  return { kind: 'next', state: next, value: null }
}

// ---------------------------------------------------------------------------
// Terminal reports (§12, §13.1, §13.2)
// ---------------------------------------------------------------------------

/**
 * The no-frontier exit (§12): one final stable read and classification — a
 * Compatible Map Extension is adopted and frontier computation repeats —
 * then the terminal RunReport: `passed` iff every member is a valid
 * Completed Ticket, otherwise `blocked(no-eligible-frontier)` listing every
 * parked Ticket and waiting descendant, never claiming completion.
 */
async function finishRun(
  ctx: RunContext,
  state: RunState,
  snapshot: TaskMapSnapshot,
): Promise<Step<TaskMapSnapshot>> {
  const read = await readMapSnapshot(ctx)
  if (read.kind !== 'ok') return { kind: 'stop', outcome: mapReadFailure(ctx, read) }
  const final = read.value
  ctx.lastSnapshot = final
  for (const ticket of final.tickets) ctx.ticketRefs.set(ticket.ref.issueId, ticket.ref)

  if (final.state !== 'OPEN') {
    return {
      kind: 'stop',
      outcome: terminalFailure(ctx, state, 'blocked', 'changed-input',
        `the Task Map is no longer OPEN (state: ${final.state})`, [{ mapState: final.state }]),
    }
  }
  const latest = state.acceptedMapRevisions.at(-1)!
  const classification = classifyMapChange(acceptedSnapshotFrom(latest, final.ref), final)
  if (classification.kind === 'incompatible') {
    return {
      kind: 'stop',
      outcome: terminalFailure(ctx, state, 'blocked', 'changed-input',
        'the final stable read found an incompatible change',
        [{ kind: 'incompatible', reasons: classification.reasons }]),
    }
  }
  if (classification.kind === 'compatible-extension') {
    const adopted = await adoptExtension(ctx, state, final, classification.addedTicketIssueIds)
    if (adopted.kind === 'stop') return { kind: 'stop', outcome: adopted.outcome }
    return { kind: 'next', state: adopted.state, value: final }
  }

  const allCompleted = final.tickets.every(
    (ticket) => state.tickets[ticket.ref.issueId]?.phase === 'completed',
  )
  if (!allCompleted) {
    const invalidated = invalidateRemaining(ctx, state, 'blocked', 'no-eligible-frontier')
    const report = buildReport(ctx, invalidated, final, 'blocked', 'no-eligible-frontier',
      ctx.sharedWrite ? 'confirmed' : 'none', undefined, undefined)
    return {
      kind: 'stop',
      outcome: persistTerminal(ctx, invalidated, report, {
        kind: 'blocked',
        code: 'no-eligible-frontier',
        reason:
          'no unparked frontier remains: every open member is parked for this run or ' +
          'waiting on a member that is not a valid Completed Ticket',
        scope: 'run',
      }),
    }
  }

  // Every member is a valid Completed Ticket. §15's full map-completion
  // protocol (completion review, map close, completion record) is a later
  // ticket; this coordinator records the passed report against the fetched
  // remote target that every member's integration provably builds on.
  const target = await captureTarget(ctx)
  if (target.kind !== 'ok') {
    return { kind: 'stop', outcome: runFailure(ctx, target.code, target.reason) }
  }
  const warnings = [...ctx.warnings]
  if (!ctx.sharedWrite) {
    warnings.push(
      'every member was already a valid Completed Ticket; this run performed no shared write',
    )
  }
  const report = buildReport(ctx, state, final, 'passed', undefined, 'confirmed', target.value.sha, warnings)
  return {
    kind: 'stop',
    outcome: persistTerminal(ctx, state, report, { kind: 'ok' }),
  }
}

/**
 * Assemble the terminal RunReport from the persisted state (§13.1): revision
 * lineage, per-Ticket states with parked codes, accepted extensions,
 * shared-write accounting, warnings, and the retained blocked workspace.
 */
function buildReport(
  ctx: RunContext,
  state: RunState,
  finalSnapshot: TaskMapSnapshot,
  label: RunReport['label'],
  code: string | undefined,
  sharedWrite: 'none' | 'confirmed',
  completionSha: GitObjectOid | undefined,
  warnings: readonly string[] | undefined,
): RunReport {
  const entries: Array<NonNullable<RunReport['tickets'][number]>> = []
  const seen = new Set<string>()
  const push = (ref: TicketRef, record: TicketRunState | undefined): void => {
    if (seen.has(ref.issueId)) return
    seen.add(ref.issueId)
    const phase = record?.phase
    const ticketState =
      phase === 'completed' ? ('completed' as const)
        : phase === 'parked' ? ('parked' as const)
          : ('waiting' as const)
    const parkedCode = record !== undefined && record.phase === 'parked' ? record.outcome.code : undefined
    entries.push({
      ticket: ref,
      state: ticketState,
      ...(parkedCode === undefined ? {} : { code: parkedCode }),
    })
  }
  for (const ticket of finalSnapshot.tickets) {
    push(ticket.ref, state.tickets[ticket.ref.issueId])
  }
  for (const [issueId, record] of Object.entries(state.tickets)) {
    if (seen.has(issueId)) continue
    const ref = ctx.ticketRefs.get(issueId) ?? refOfRecord(state, issueId)
    if (ref !== undefined) push(ref, record)
  }
  entries.sort((a, b) => a.ticket.number - b.ticket.number)

  const retained = Object.values(state.tickets)
    .filter((record): record is Extract<TicketRunState, { readonly phase: 'parked' }> => record.phase === 'parked')
    .filter((record) => record.workspace !== undefined)
    .sort((a, b) => b.wave - a.wave)[0]?.workspace

  return {
    label,
    ...(code === undefined ? {} : { code }),
    runId: state.runId,
    initialMapRevision: state.acceptedMapRevisions[0]!.revision,
    finalMapRevision: state.acceptedMapRevisions.at(-1)!.revision,
    acceptedExtensions: state.acceptedMapRevisions.slice(1).map((entry) => ({
      revision: entry.revision,
      addedTicketIssueIds: [...(entry.extension?.addedTicketIssueIds ?? [])],
    })),
    tickets: entries,
    sharedWrite,
    ...(completionSha === undefined ? {} : { completionSha }),
    warnings: [...(warnings ?? ctx.warnings)],
    ...(retained === undefined ? {} : { retainedWorkspace: retained }),
  }
}

/** The reference of one ticket record, from its own persisted payload. */
function refOfRecord(state: RunState, issueId: string): TicketRef | undefined {
  const record = state.tickets[issueId]
  if (record === undefined) return undefined
  if (record.phase === 'shippable' || record.phase === 'shipping') return record.change.ticket
  if (record.phase === 'working') return record.attempt.input.ticket
  const parked = state.parkedTickets.find((ref) => ref.issueId === issueId)
  return parked
}

/**
 * Persist `status: 'terminal'` with the report and map it to the operation
 * outcome (§13.2): `passed` is the final `ok`; blocked and terminal errors
 * carry the report as machine evidence.
 */
function persistTerminal(
  ctx: RunContext,
  state: RunState,
  report: RunReport,
  as:
    | { readonly kind: 'ok' }
    | {
        readonly kind: 'blocked' | 'error'
        readonly code: string
        readonly reason: string
        readonly scope: 'operation' | 'ticket' | 'run'
      },
): RunMapOutcome {
  const next: RunState = { ...state, status: 'terminal', report }
  const saved = saveRunState(ctx.repositoryHome, ctx.encodedMapIssueId, next)
  if (saved.kind !== 'ok') {
    return error({
      scope: 'operation',
      code: saved.code as never,
      reason: `persisting the terminal report failed: ${saved.reason}`,
      evidence: [report as unknown as CanonicalJsonValue],
    })
  }
  if (as.kind === 'ok') return ok(report)
  if (as.kind === 'blocked') {
    return blocked({
      scope: as.scope,
      code: as.code as never,
      reason: as.reason,
      sharedWrite: report.sharedWrite,
      evidence: [report as unknown as CanonicalJsonValue],
    })
  }
  return error({
    scope: as.scope,
    code: as.code as never,
    reason: as.reason,
    sharedWrite: 'none',
    evidence: [report as unknown as CanonicalJsonValue],
  })
}

/**
 * Invalidate every remaining unshipped or in-flight result of a terminal run
 * (§12): working, shippable, and shipping Tickets become parked carrying the
 * terminal outcome's code, with their workspaces retained for inspection.
 */
function invalidateRemaining(
  ctx: RunContext,
  state: RunState,
  label: 'blocked' | 'error',
  code: string,
): RunState {
  const kind = label === 'error' ? ('error' as const) : ('blocked' as const)
  const reason =
    label === 'error'
      ? 'the run failed with a run-scoped error; this result was invalidated'
      : 'the run ended before this result shipped; it was invalidated'
  let next = state
  for (const [issueId, record] of Object.entries(state.tickets)) {
    if (record.phase !== 'working' && record.phase !== 'shippable' && record.phase !== 'shipping') {
      continue
    }
    const ref =
      record.phase === 'shippable' || record.phase === 'shipping'
        ? record.change.ticket
        : record.attempt.input.ticket
    ctx.ticketRefs.set(issueId, ref)
    const workspace =
      record.phase === 'shippable' || record.phase === 'shipping'
        ? record.change.workspace
        : record.attempt.workspace
    next = withTicket(next, issueId, {
      phase: 'parked',
      wave: record.wave,
      ...(workspace === undefined ? {} : { workspace }),
      outcome: { kind, code, reason, evidence: [{ invalidated: true, label }] },
    })
    if (!next.parkedTickets.some((entry) => entry.issueId === issueId)) {
      next = { ...next, parkedTickets: [...next.parkedTickets, ref] }
    }
  }
  return next
}

// ---------------------------------------------------------------------------
// Failure mapping (§9, §13.2)
// ---------------------------------------------------------------------------

type FailureLike = {
  readonly kind: 'blocked' | 'error'
  readonly code: string
  readonly reason: string
  readonly evidence: readonly Evidence[]
  readonly sharedWrite?: 'none' | 'confirmed' | 'unknown'
}

/**
 * A run-scoped failure: blocked outcomes always terminalize (§9); errors
 * terminalize only with `sharedWrite: 'none'` — an error after a confirmed
 * or unknown shared write is a recoverable interruption that leaves Run
 * State `running` and resumable (§13.2).
 */
function failureOutcome(ctx: RunContext, failure: FailureLike): RunMapOutcome {
  const state = currentStateOf(ctx)
  if (failure.kind === 'error') {
    const sharedWrite =
      failure.sharedWrite === undefined || failure.sharedWrite === 'none'
        ? ctx.sharedWrite ? 'confirmed' : 'none'
        : failure.sharedWrite
    if (sharedWrite !== 'none') {
      return error({
        scope: 'run',
        code: normalizeErrorCode(failure.code),
        reason: failure.reason,
        sharedWrite,
        evidence: [
          ...failure.evidence,
          ...(state === undefined ? [] : [{ runId: state.runId, runState: 'running', recoverable: true }]),
        ],
      })
    }
    return terminalFailure(ctx, state, 'error', normalizeErrorCode(failure.code), failure.reason, [
      ...failure.evidence,
    ])
  }
  const sharedWrite =
    failure.sharedWrite === 'confirmed' || ctx.sharedWrite ? 'confirmed' : 'none'
  return terminalFailure(ctx, state, 'blocked', failure.code, failure.reason, [
    ...failure.evidence,
  ], sharedWrite)
}

/**
 * Terminalize a blocked or terminal-error run: invalidate remaining results,
 * persist `status: 'terminal'` with the report, and return the outcome.
 */
function terminalFailure(
  ctx: RunContext,
  state: RunState | undefined,
  kind: 'blocked' | 'error',
  code: string,
  reason: string,
  evidence: readonly Evidence[],
  sharedWrite?: 'none' | 'confirmed',
): RunMapOutcome {
  const current = state ?? currentStateOf(ctx)
  if (current === undefined) {
    return kind === 'blocked'
      ? blocked({ scope: 'run', code: code as never, reason, sharedWrite: sharedWrite ?? 'none', evidence: [...evidence] })
      : error({ scope: 'run', code: normalizeErrorCode(code), reason, sharedWrite: 'none', evidence: [...evidence] })
  }
  const finalSharedWrite =
    sharedWrite ?? (kind === 'error' ? 'none' : ctx.sharedWrite ? 'confirmed' : 'none')
  const invalidated = invalidateRemaining(ctx, current, kind, code)
  const snapshot = ctx.lastSnapshot ?? emptySnapshotOf(current)
  const report = buildReport(ctx, invalidated, snapshot, kind, code, finalSharedWrite, undefined, undefined)
  return persistTerminal(ctx, invalidated, report, { kind, code, reason, scope: 'run' })
}

/** An empty snapshot fallback when no stable read ever succeeded. */
function emptySnapshotOf(state: RunState): TaskMapSnapshot {
  const latest = state.acceptedMapRevisions.at(-1)!
  return {
    ref: state.map,
    title: '',
    body: '',
    state: 'OPEN',
    mapRevision: latest.revision,
    tickets: [],
  }
}

/** An infrastructure error under this coordinator's own steam (§9). */
function runFailure(
  ctx: RunContext,
  code: RunErrorCode,
  reason: string,
  evidence: readonly Evidence[] = [],
): RunMapOutcome {
  return failureOutcome(ctx, { kind: 'error', code, reason, evidence, sharedWrite: 'none' })
}

/** Map an underlying error code onto the closed run error union. */
function normalizeErrorCode(code: string): RunErrorCode {
  const known: readonly string[] = [
    'git-unavailable', 'git-failed', 'github-unavailable', 'model-catalog-unavailable',
    'control-store', 'state-integrity', 'lock-failed', 'slot-registry',
    'map-read', 'target-read', 'evidence-read', 'push-unknown',
    'comment-write', 'issue-close', 'issue-reopen', 'adapter-failure',
  ]
  return known.includes(code) ? (code as RunErrorCode) : 'control-store'
}

// ---------------------------------------------------------------------------
// Run State helpers
// ---------------------------------------------------------------------------

function withTicket(state: RunState, issueId: string, record: TicketRunState): RunState {
  return { ...state, tickets: { ...state.tickets, [issueId]: record } }
}

/**
 * Record a valid Completed Ticket, dropping any earlier parked entry for it
 * (§13.1: `parkedTickets` must exactly match the parked phases, even when a
 * parked Ticket was completed externally between waves).
 */
function withCompletedTicket(
  state: RunState,
  issueId: string,
  completed: { readonly deliveryId: string; readonly integratedSha: string },
): RunState {
  const next = withTicket(state, issueId, { phase: 'completed', ...completed })
  if (!next.parkedTickets.some((ref) => ref.issueId === issueId)) return next
  return { ...next, parkedTickets: next.parkedTickets.filter((ref) => ref.issueId !== issueId) }
}

/**
 * The freshest persisted state, for failure paths that must terminalize from
 * disk rather than a possibly-stale in-memory copy.
 */
function currentStateOf(ctx: RunContext): RunState | undefined {
  const loaded = loadRunState(ctx.repositoryHome, ctx.encodedMapIssueId)
  return loaded.kind === 'ok' ? loaded.value : undefined
}

// ---------------------------------------------------------------------------
// Resume reconciliation (§13.2)
// ---------------------------------------------------------------------------

/**
 * Reconcile every recorded, not-yet-settled process group of a resumed run:
 * reattach, wait for a live group to exit (terminating it after the budget),
 * then persist `settled`. No Work slot may release and no attempt may resume
 * before every recorded group is settled (§16).
 */
async function reconcileActiveProcesses(ctx: RunContext, state: RunState): Promise<StepResult> {
  const pending: readonly ProcessGroupCheckpoint[] = state.activeProcesses.filter(
    (group) => group.state !== 'settled',
  )
  if (pending.length === 0) return { kind: 'next', state, value: null }
  const budget = ctx.deps.agentSettleTimeoutMs ?? 60_000

  for (const group of pending) {
    const attached = ctx.deps.runner.attach(group.adapterHandle)
    const live = await ctx.deps.runner.isLive(attached)
    if (!live) continue
    const exited = await ctx.deps.runner.waitForExit(attached, budget)
    if (exited === 'timeout') {
      const terminated = await ctx.deps.runner.terminate(attached)
      if (terminated !== 'terminated') {
        return {
          kind: 'stop',
          outcome: runFailure(ctx, 'adapter-failure',
            `terminating the recovered process group ${group.id} failed; its slot stays charged`,
            [{ processGroupId: group.id, adapterHandle: group.adapterHandle }]),
        }
      }
    }
  }

  const loaded = loadRunState(ctx.repositoryHome, ctx.encodedMapIssueId)
  if (loaded.kind !== 'ok') {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, loaded.code as never,
        `reloading run state after process reconciliation failed: ${loaded.reason}`),
    }
  }
  if (loaded.value === undefined) {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, 'control-store',
        'reloading run state after process reconciliation found no document'),
    }
  }
  const next: RunState = {
    ...loaded.value,
    activeProcesses: loaded.value.activeProcesses.map((group) =>
      group.state === 'settled' ? group : { ...group, state: 'settled' },
    ),
  }
  const saved = saveRunState(ctx.repositoryHome, ctx.encodedMapIssueId, next)
  if (saved.kind !== 'ok') {
    return {
      kind: 'stop',
      outcome: runFailure(ctx, saved.code as never,
        `persisting process reconciliation failed: ${saved.reason}`),
    }
  }
  return { kind: 'next', state: next, value: null }
}
