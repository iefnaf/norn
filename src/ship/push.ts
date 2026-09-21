/**
 * Ship push, remote verification, and the retry protocol (design.md §11.3,
 * §13.3 steps 1–2, ticket #11).
 *
 * The guarded shared write. One sealed `ShippableChange` becomes one verified
 * remote integration through this protocol:
 *
 * ```text
 * acquire the target lock (§16) — held through remote verification
 *     ↓
 * reconcile any persisted Ship Checkpoint (§13.3: free remote probes decide
 * presence against the recorded integration shape; absence falls to budget)
 *     ↓
 * loop:
 *     stable Map read; classify; Compatible Map Extension observed while
 *     holding the target lock → release, adopt under the control lock,
 *     reacquire, re-read Map and target (§11.3, §16)
 *     ↓
 *     final target read under the lock
 *     ↓
 *     candidate current? reuse the recorded one : reconcile fresh gates
 *     (§11.2 through `reconcileFinalCandidate`, invoked under the lock)
 *     ↓
 *     atomically store candidate + gate evidence + sealed Delivery Record +
 *     current attempt count in the Ship Checkpoint — before any push
 *     ↓
 *     zero-delta? no push, no attempt : increment and persist the attempt
 *     counter BEFORE the call, then push the exact integration commit
 *     without force
 *     ↓
 *     map the typed push outcome:
 *       pushed       → verify integrated SHA, parent, tree, and ancestry
 *       target-advanced → fetch and repeat reconciliation + fresh gates
 *                         while budget remains; else ticket-scoped
 *                         blocked(target-advanced)
 *       rejected     → run-scoped blocked(push-rejected); stops the queue
 *       unknown      → bounded stable fetches; continue only on proven
 *                      presence of the exact integration shape; proven
 *                      absence follows the remaining budget; persistent
 *                      ambiguity is a recoverable run-scoped error with
 *                      sharedWrite 'unknown' — never a guess
 * ```
 *
 * Ordering invariants enforced here and under test:
 *
 * - the Ship Checkpoint (exact candidate, gate evidence, sealed Delivery
 *   Record, attempt count) is persisted atomically BEFORE any push, so every
 *   push outcome remains classifiable from persisted state alone (§13.3);
 * - the push-attempt counter increments and persists before each push call
 *   and is never reset by recovery — an invocation interrupted around the
 *   call conservatively consumed one attempt (§11.3). Remote probes
 *   (fetch / rev-parse / merge-base) are free; only actual pushes consume
 *   budget. The budget is `1 + maxPushRetries` total attempts;
 * - the target lock is held from the final target read through remote
 *   verification and released on every exit path; extension adoption under
 *   the repository control lock happens only with the target lock released
 *   (§16), inside the release-adopt-reacquire dance;
 * - reconciliation against a new target atomically replaces the prepared
 *   candidate and sealed Delivery Record while carrying the counter forward.
 *
 * Orchestration composes the earlier tickets' seams: the #10 reconciliation
 * (`reconcileFinalCandidate` and its deps), the Run State store (Ship
 * Checkpoint persistence), the sealed `DeliveryRecordV1` + `deliveryId`
 * computation, the Git delivery facts, the new Git push seam, and the §9
 * outcome model.
 */
import { blocked, error, ok } from '../core/outcome.ts'
import type { Evidence, Outcome } from '../core/outcome.ts'
import { canonicalJson } from '../core/canonical-json.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'
import { agentRecordedAt } from '../agents/completion.ts'
import type { GitObjectOid } from '../agents/completion.ts'
import type { GitPushSeam } from '../adapters/git-repository.ts'
import { computeDeliveryId } from '../evidence/delivery.ts'
import { classifyMapChange } from '../map/map-extension.ts'
import type { MapRef } from '../map/snapshot.ts'
import { reconcileFinalCandidate } from './reconcile.ts'
import type {
  FinalCandidate,
  ShipExtensionAdoption,
  ShipReconcileBlockCode,
  ShipReconcileDeps,
  ShipReconcileErrorCode,

  ShipReconcileParams,
} from './reconcile.ts'
import { acceptedSnapshotFrom, evaluateBlockerCompletion, snapshotMapPayload } from './reconcile.ts'
import type { AcquireOptions } from '../runstate/locks.ts'
import { acquireTargetLock } from '../runstate/locks.ts'
import type { LockOutcome } from '../runstate/locks.ts'
import { loadRunState, saveRunState } from '../runstate/run-state-store.ts'
import type {
  AcceptedMapRevision,
  DeliveryRecordV1,
  EvidenceGateV1,
  ReviewEvidence,
  RunState,
  ShippableChange,
  ShipCheckpoint,
  TestEvidence,
  TicketRef,
  WorkspaceRef,
} from '../runstate/types.ts'
import { formatGitObjectOid, parseGitObjectOid } from '../work/workspace.ts'
import type { GitObjectFormat } from '../work/workspace.ts'

// ---------------------------------------------------------------------------
// Outcome vocabulary (§9, §11.3, §13.3)
// ---------------------------------------------------------------------------

/**
 * Closed block codes of the push stage. Ticket-scoped codes
 * (`integration-conflict`, `ship-gate-failed`, `user-abort`,
 * `target-advanced`, `push-retries-exhausted`) always carry
 * `sharedWrite: 'none'`; `changed-input` and `push-rejected` are run-scoped
 * and stop the shipping queue.
 */
export type ShipPushBlockCode =
  | ShipReconcileBlockCode
  /** Retry budget exhausted while the target kept moving (§11.3). */
  | 'target-advanced'
  /** Retry budget exhausted without target movement (§13.3). */
  | 'push-retries-exhausted'
  /** Authentication or branch policy refused every push (§11.3). */
  | 'push-rejected'

/** Closed error codes of the push stage; scope is fixed per code (§9). */
export type ShipPushErrorCode =
  | ShipReconcileErrorCode
  /** The target lock could not be acquired, released, or reacquired. */
  | 'lock-failed'
  /** The persisted Ship Checkpoint contradicts this shipment. */
  | 'state-integrity'
  /** Remote state stayed ambiguous after bounded stable fetches (§11.3). */
  | 'push-unknown'

/** One Compatible Map Extension adopted during this push (§7.4, §11.3). */
export type PushAdoptedExtension = {
  readonly revision: string
  readonly fromRevision: string
  readonly addedTicketIssueIds: readonly string[]
}

/** The verified result of one push protocol run. */
export type ShipPushVerified = {
  readonly ticket: TicketRef
  /** The persisted checkpoint at stage `push-verified`. */
  readonly checkpoint: ShipCheckpoint
  /** The exact candidate whose integration the remote now provably contains. */
  readonly candidate: FinalCandidate
  /** The fetched remote target tip at verification. */
  readonly remoteTargetSha: string
  /** Compatible Map Extensions adopted during this push, in order. */
  readonly adoptedExtensions: readonly PushAdoptedExtension[]
  /** Actual pushes executed in this invocation; probes are free (§13.3). */
  readonly pushes: number
}

export type ShipPushOutcome = Outcome<
  ShipPushVerified,
  ShipPushBlockCode,
  ShipPushErrorCode
>

// ---------------------------------------------------------------------------
// The target-lock seam (§16)
// ---------------------------------------------------------------------------

/** One held target lock; `isHeld` is false once released. */
export type ShipTargetLockHandle = {
  readonly release: () => Promise<Outcome<void, never, 'lock-failed'>>
  readonly isHeld: () => boolean
}

/** The injectable target-lock seam; production uses the OS-backed lock. */
export type ShipTargetLock = {
  readonly acquire: () => Promise<Outcome<ShipTargetLockHandle, 'lock-held', 'lock-failed'>>
}

/**
 * The production target lock: the OS-backed advisory lock under
 * `<repository-home>/locks/target-<branch>.lock` (§16). Ship waits for a
 * current holder — the lock serializes Ship across every active map — and
 * auto-releases when the owning process exits, however it dies.
 */
export function osTargetLock(
  repositoryHome: string,
  branch: string,
  options: AcquireOptions = { waitMs: 60_000 },
): ShipTargetLock {
  return {
    async acquire() {
      const outcome: LockOutcome = await acquireTargetLock(repositoryHome, branch, options)
      if (outcome.kind === 'ok') {
        let held = true
        const handle: ShipTargetLockHandle = {
          release: async () => {
            const released = await outcome.value.release()
            if (released.kind === 'ok') held = false
            return released
          },
          isHeld: () => held,
        }
        return ok(handle)
      }
      return outcome
    },
  }
}

// ---------------------------------------------------------------------------
// The Ship Checkpoint seam (§13.1, §13.3)
// ---------------------------------------------------------------------------

export type ShipStoreErrorCode = 'control-store' | 'state-integrity'

/** The persisted shipping state of one ticket. */
export type LoadedShipState = {
  readonly wave: number
  readonly change: ShippableChange
  readonly checkpoint: ShipCheckpoint
}

/** The persisted `completed` state of one ticket (§13.1). */
export type LoadedCompletedTicket = {
  readonly deliveryId: string
  readonly integratedSha: string
  readonly cleanupWorkspace?: WorkspaceRef
}

/** Everything the atomic `completed` update of §11.3 persists. */
export type ShipCompleteInput = {
  readonly deliveryId: string
  readonly integratedSha: string
  /** Retained until cleanup succeeded or its failure was warned (§13.1). */
  readonly cleanupWorkspace?: WorkspaceRef
}

/** Everything one `prepare` atomically persists as stage `prepared`. */
export type ShipPrepareInput = {
  readonly wave: number
  readonly change: ShippableChange
  readonly zeroDelta: boolean
  readonly baseSha: string
  readonly integratedSha: string
  readonly treeOid: string
  readonly tests: readonly TestEvidence[]
  readonly review: ReviewEvidence
  readonly delivery: DeliveryRecordV1
}

/**
 * The injectable Ship Checkpoint store. Every operation loads the Run State
 * document, mutates the ticket's shipping checkpoint, and persists it through
 * the atomic write protocol — so a crash between any two operations leaves
 * the previous or the complete new checkpoint, never a torn one.
 */
export type ShipCheckpointStore = {
  /** The persisted shipping state of the ticket, or `undefined` when none. */
  load(): Promise<Outcome<LoadedShipState | undefined, never, ShipStoreErrorCode>>
  /**
   * Atomically store the exact shipping candidate, gate evidence, sealed
   * Delivery Record, and current attempt count as stage `prepared`. A
   * previous `prepared` checkpoint of the same ticket is replaced while its
   * attempt counter is carried forward (§11.3).
   */
  prepare(input: ShipPrepareInput): Promise<Outcome<ShipCheckpoint, never, ShipStoreErrorCode>>
  /**
   * Increment and persist the push-attempt counter, returning the new count.
   * Called immediately before each push; never resets (§11.3, §13.3).
   */
  incrementPushAttempts(): Promise<Outcome<number, never, ShipStoreErrorCode>>
  /** Persist a remotely confirmed stage transition of the checkpoint. */
  markStage(stage: ShipCheckpoint['stage']): Promise<Outcome<ShipCheckpoint, never, ShipStoreErrorCode>>
  /** The persisted `completed` state of the ticket, or `undefined` (§13.1). */
  loadCompleted(): Promise<Outcome<LoadedCompletedTicket | undefined, never, ShipStoreErrorCode>>
  /**
   * Atomically persist the post-close-validated Completed Ticket (§11.3,
   * §13.1): only a successfully persisted validation may complete the
   * Ticket, and the sealed `deliveryId` and `integratedSha` must mirror the
   * checkpoint that was validated.
   */
  complete(input: ShipCompleteInput): Promise<Outcome<void, never, ShipStoreErrorCode>>
  /** Drop the retained cleanup workspace after successful cleanup (§13.1). */
  markCleanedUp(): Promise<Outcome<void, never, ShipStoreErrorCode>>
}

/**
 * The production Ship Checkpoint store over one Run State document (§13.1).
 * The document's integrity rules re-validate every checkpoint before any
 * byte is written; only the coordinator (map-lock protected) writes it.
 */
export function runStateShipCheckpointStore(options: {
  readonly repositoryHome: string
  readonly encodedMapIssueId: string
  readonly ticketIssueId: string
}): ShipCheckpointStore {
  const { repositoryHome, encodedMapIssueId, ticketIssueId } = options
  return {
    async load() {
      const loaded = loadRunState(repositoryHome, encodedMapIssueId)
      if (loaded.kind !== 'ok') return loaded
      if (loaded.value === undefined) return ok(undefined)
      const ticket = loaded.value.tickets[ticketIssueId]
      if (ticket === undefined || ticket.phase !== 'shipping') return ok(undefined)
      return ok({ wave: ticket.wave, change: ticket.change, checkpoint: ticket.checkpoint })
    },

    async loadCompleted() {
      const loaded = loadRunState(repositoryHome, encodedMapIssueId)
      if (loaded.kind !== 'ok') return loaded
      if (loaded.value === undefined) return ok(undefined)
      const ticket = loaded.value.tickets[ticketIssueId]
      if (ticket === undefined || ticket.phase !== 'completed') return ok(undefined)
      return ok({
        deliveryId: ticket.deliveryId,
        integratedSha: ticket.integratedSha,
        ...(ticket.cleanupWorkspace !== undefined
          ? { cleanupWorkspace: ticket.cleanupWorkspace }
          : {}),
      })
    },

    async prepare(input) {
      return updateCheckpoint(repositoryHome, encodedMapIssueId, (state) => {
        const existing = state.tickets[ticketIssueId]
        let pushAttempts = 0
        if (existing !== undefined) {
          if (existing.phase === 'completed') {
            return integrityError(`ticket ${ticketIssueId} is already completed and cannot ship again`)
          }
          if (existing.phase === 'shipping') {
            if (existing.checkpoint.stage !== 'prepared') {
              return integrityError(
                `the shipping checkpoint is already at stage "${existing.checkpoint.stage}" ` +
                  'and cannot be re-prepared',
              )
            }
            // Reconciliation against a new target replaces the prepared
            // candidate while carrying the counter forward (§11.3).
            pushAttempts = existing.checkpoint.pushAttempts
          } else if (existing.phase !== 'shippable') {
            return integrityError(
              `ticket ${ticketIssueId} is in phase "${existing.phase}" and cannot enter shipping`,
            )
          }
        } else {
          return integrityError(`ticket ${ticketIssueId} has no shippable change to ship`)
        }
        const checkpoint: ShipCheckpoint = {
          stage: 'prepared',
          pushAttempts,
          zeroDelta: input.zeroDelta,
          baseSha: input.baseSha,
          integratedSha: input.integratedSha,
          treeOid: input.treeOid,
          tests: [...input.tests],
          review: input.review,
          delivery: input.delivery,
        }
        return ok({
          state: {
            ...state,
            tickets: {
              ...state.tickets,
              [ticketIssueId]: {
                phase: 'shipping' as const,
                wave: input.wave,
                change: input.change,
                checkpoint,
              },
            },
          },
          result: checkpoint,
        })
      })
    },

    async incrementPushAttempts() {
      return updateCheckpoint(repositoryHome, encodedMapIssueId, (state) => {
        const ticket = state.tickets[ticketIssueId]
        if (ticket === undefined || ticket.phase !== 'shipping') {
          return integrityError(`ticket ${ticketIssueId} has no shipping checkpoint to count attempts for`)
        }
        if (ticket.checkpoint.stage !== 'prepared') {
          return integrityError(
            `the shipping checkpoint of ticket ${ticketIssueId} is at stage ` +
              `"${ticket.checkpoint.stage}"; attempts increment only before pushes`,
          )
        }
        const checkpoint: ShipCheckpoint = {
          ...ticket.checkpoint,
          pushAttempts: ticket.checkpoint.pushAttempts + 1,
        }
        return ok({
          state: {
            ...state,
            tickets: {
              ...state.tickets,
              [ticketIssueId]: { ...ticket, checkpoint },
            },
          },
          result: checkpoint.pushAttempts,
        })
      })
    },

    async markStage(stage) {
      return updateCheckpoint(repositoryHome, encodedMapIssueId, (state) => {
        const ticket = state.tickets[ticketIssueId]
        if (ticket === undefined || ticket.phase !== 'shipping') {
          return integrityError(`ticket ${ticketIssueId} has no shipping checkpoint to advance`)
        }
        const order = ['prepared', 'push-verified', 'delivery-recorded', 'ticket-closed'] as const
        if (order.indexOf(ticket.checkpoint.stage) > order.indexOf(stage)) {
          return integrityError(
            `the shipping checkpoint of ticket ${ticketIssueId} is already at stage ` +
              `"${ticket.checkpoint.stage}" and cannot move back to "${stage}"`,
          )
        }
        const checkpoint: ShipCheckpoint = { ...ticket.checkpoint, stage }
        return ok({
          state: {
            ...state,
            tickets: {
              ...state.tickets,
              [ticketIssueId]: { ...ticket, checkpoint },
            },
          },
          result: checkpoint,
        })
      })
    },

    async complete(input) {
      return updateCheckpoint(repositoryHome, encodedMapIssueId, (state) => {
        const ticket = state.tickets[ticketIssueId]
        if (ticket === undefined || ticket.phase !== 'shipping') {
          return integrityError(`ticket ${ticketIssueId} has no shipping checkpoint to complete`)
        }
        if (ticket.checkpoint.stage !== 'ticket-closed') {
          return integrityError(
            `the shipping checkpoint of ticket ${ticketIssueId} is at stage ` +
              `"${ticket.checkpoint.stage}"; only a post-close validation (§11.3) may complete`,
          )
        }
        if (
          input.deliveryId !== ticket.checkpoint.delivery.deliveryId ||
          input.integratedSha !== ticket.checkpoint.integratedSha
        ) {
          return integrityError(
            `the completed ticket ${ticketIssueId} must mirror the validated checkpoint`,
          )
        }
        return ok({
          state: {
            ...state,
            tickets: {
              ...state.tickets,
              [ticketIssueId]: {
                phase: 'completed' as const,
                deliveryId: input.deliveryId,
                integratedSha: input.integratedSha,
                ...(input.cleanupWorkspace !== undefined
                  ? { cleanupWorkspace: input.cleanupWorkspace }
                  : {}),
              },
            },
          },
          result: undefined,
        })
      })
    },

    async markCleanedUp() {
      return updateCheckpoint(repositoryHome, encodedMapIssueId, (state) => {
        const ticket = state.tickets[ticketIssueId]
        if (ticket === undefined || ticket.phase !== 'completed') {
          return integrityError(`ticket ${ticketIssueId} is not completed and has no cleanup record`)
        }
        if (ticket.cleanupWorkspace === undefined) {
          return integrityError(`completed ticket ${ticketIssueId} retains no cleanup workspace`)
        }
        const { cleanupWorkspace: _retained, ...completed } = ticket
        return ok({
          state: {
            ...state,
            tickets: { ...state.tickets, [ticketIssueId]: completed },
          },
          result: undefined,
        })
      })
    },
  }
}

/**
 * Load the Run State document, apply one checkpoint mutation, and persist
 * the next document atomically. The mutation returns either a typed failure
 * or the next document plus its result; `saveRunState` re-validates every
 * integrity rule before any byte is written.
 */
function updateCheckpoint<T>(
  repositoryHome: string,
  encodedMapIssueId: string,
  mutate: (
    state: RunState,
  ) => Outcome<{ readonly state: RunState; readonly result: T }, never, ShipStoreErrorCode>,
): Outcome<T, never, ShipStoreErrorCode> {
  const loaded = loadRunState(repositoryHome, encodedMapIssueId)
  if (loaded.kind !== 'ok') return loaded
  if (loaded.value === undefined) {
    return controlStoreError('no run state exists for this map')
  }
  const result = mutate(loaded.value)
  if (result.kind !== 'ok') return result
  const saved = saveRunState(repositoryHome, encodedMapIssueId, result.value.state)
  if (saved.kind !== 'ok') return saved
  return ok(result.value.result)
}

function integrityError(reason: string): Outcome<never, never, ShipStoreErrorCode> {
  return error({
    scope: 'run',
    code: 'state-integrity',
    reason,
    sharedWrite: 'none',
    evidence: [],
  })
}

function controlStoreError(reason: string): Outcome<never, never, ShipStoreErrorCode> {
  return error({
    scope: 'run',
    code: 'control-store',
    reason,
    sharedWrite: 'none',
    evidence: [],
  })
}

// ---------------------------------------------------------------------------
// The injected seams and parameters
// ---------------------------------------------------------------------------

/** The push stage composes every §11.1–§11.2 seam plus its own. */
export type ShipPushDeps = ShipReconcileDeps & {
  /** The non-force push seam; each actual call consumes one persisted attempt. */
  readonly push: GitPushSeam
  /** Atomic Ship Checkpoint persistence over the Run State store. */
  readonly checkpoint: ShipCheckpointStore
  /** The target lock serializing Ship per repository and branch (§16). */
  readonly lock: ShipTargetLock
  /** Sealed-record timestamps; defaults to the §14 format now. */
  readonly now?: () => string
  /** Bounded stable-fetch cycle cap for `unknown` pushes; default 3. */
  readonly stableFetchMax?: number
}

export type ShipPushParams = ShipReconcileParams & {
  /** The map issue reference, for §7.4 classification and record sealing. */
  readonly map: MapRef
  /** The Wave whose persisted queue this shipment belongs to (§12). */
  readonly wave: number
  /** Resolved Run Config revision, sealed into the Delivery Record (§14). */
  readonly configRevision: string
  readonly nornVersion: string
  /** The remote name pushes and fetches address (e.g. `origin`). */
  readonly remote: string
  /** Additional attempts allowed after the initial push (§8, §11.3). */
  readonly maxPushRetries: number
  /** The sealed evidence gate from the resolved Run Config (§14). */
  readonly gate: EvidenceGateV1
  /** The authenticated GitHub actor that will author the record (§14). */
  readonly actorId: string
}

/** Default cap on stable-fetch cycles while classifying a remote state. */
export const STABLE_FETCH_MAX_CYCLES = 3

// ---------------------------------------------------------------------------
// The push protocol (§11.3, §13.3 steps 1–2)
// ---------------------------------------------------------------------------

type PushConfig = {
  readonly budget: number
  readonly stableFetchMax: number
  readonly now: () => string
  readonly format: GitObjectFormat
}

type ShipContext = {
  lock: ShipTargetLockHandle | undefined
  accepted: AcceptedMapRevision
  adopted: PushAdoptedExtension[]
  pushes: number
  /** Whether the target ever moved past a gated base during this protocol. */
  targetMoved: boolean
}

/**
 * Push one sealed `ShippableChange` through the guarded shared write of
 * §11.3: checkpoint-then-push under the target lock, typed push outcomes,
 * and bounded stable verification. Returns only after remote verification
 * proved the exact integration shape (stage `push-verified`) or a typed
 * non-success stopped the shipment.
 */
export async function shipPush(deps: ShipPushDeps, params: ShipPushParams): Promise<ShipPushOutcome> {
  const format = parseGitObjectOid(params.change.baseSha)?.objectFormat
  if (format === undefined) {
    return pushError('ticket', 'integration-shape', 'the sealed change carries a malformed base OID', [
      { baseSha: params.change.baseSha },
    ])
  }
  const config: PushConfig = {
    budget: 1 + params.maxPushRetries,
    stableFetchMax: deps.stableFetchMax ?? STABLE_FETCH_MAX_CYCLES,
    now: deps.now ?? (() => agentRecordedAt()),
    format,
  }

  const acquired = await deps.lock.acquire()
  if (acquired.kind !== 'ok') {
    return pushError(
      'run',
      'lock-failed',
      `acquiring the target lock for ${params.targetBranch} failed: ${acquired.reason}`,
      [],
    )
  }
  const ctx: ShipContext = {
    lock: acquired.value,
    accepted: params.accepted,
    adopted: [],
    pushes: 0,
    targetMoved: false,
  }
  try {
    return await runPushProtocol(deps, params, ctx, config)
  } finally {
    // Every exit path releases the lock; the OS-backed lock also dies with
    // the process, so a release failure here cannot strand Ship forever.
    const lock = ctx.lock
    ctx.lock = undefined
    if (lock !== undefined) await lock.release()
  }
}

async function runPushProtocol(
  deps: ShipPushDeps,
  params: ShipPushParams,
  ctx: ShipContext,
  config: PushConfig,
): Promise<ShipPushOutcome> {
  // --- §13.3 entry: reconcile a persisted checkpoint with free probes ------

  const loaded = await deps.checkpoint.load()
  if (loaded.kind !== 'ok') return storeFailure('loading the ship checkpoint', loaded)
  let current: LoadedShipState | undefined
  if (loaded.value !== undefined) {
    const persisted = loaded.value
    if (canonicalJson(persisted.change as unknown as CanonicalJsonValue) !== canonicalJson(params.change as unknown as CanonicalJsonValue)) {
      return pushError(
        'run',
        'state-integrity',
        'the persisted Ship Checkpoint binds a different shippable change than this shipment',
        [{ persistedTicket: persisted.change.ticket.issueId }],
      )
    }
    current = persisted
    const pendingWrite = persisted.checkpoint.pushAttempts > 0
    const probe = await stableProbe(deps, params, persisted.checkpoint, config)
    if (probe.kind === 'decided') {
      if (probe.result === 'present') {
        // The recorded integration is provably on the target: the push stage
        // is conclusively past, whatever a crash interrupted locally.
        if (persisted.checkpoint.stage === 'prepared') {
          const marked = await deps.checkpoint.markStage('push-verified')
          if (marked.kind !== 'ok') {
            return storeFailure(
              'persisting push verification',
              marked,
              persisted.checkpoint.pushAttempts > 0 ? 'confirmed' : 'none',
            )
          }
          return verifiedOutcome(params, ctx, { ...persisted, checkpoint: marked.value }, probe.targetSha)
        }
        return verifiedOutcome(params, ctx, persisted, probe.targetSha)
      }
      if (persisted.checkpoint.stage !== 'prepared') {
        return error({
          scope: 'run',
          code: 'state-integrity',
          reason:
            `a shipping checkpoint at stage "${persisted.checkpoint.stage}" is persisted but its ` +
            'recorded integration is absent from the fetched target',
          sharedWrite: 'confirmed',
          evidence: [
            { stage: persisted.checkpoint.stage, integratedSha: persisted.checkpoint.integratedSha },
          ],
        })
      }
      // Proven absence: push only after revalidation and while the budget
      // remains (§13.3 step 2). A remote probe consumed no budget.
      if (persisted.checkpoint.pushAttempts >= config.budget) {
        ctx.targetMoved = probe.targetSha !== persisted.checkpoint.baseSha
        return exhaustedBlocked(persisted.checkpoint, probe.targetSha, ctx)
      }
    } else {
      return probeFailure(probe, pendingWrite)
    }
  }

  return pushLoop(deps, params, ctx, config, current)
}

async function pushLoop(
  deps: ShipPushDeps,
  params: ShipPushParams,
  ctx: ShipContext,
  config: PushConfig,
  initial: LoadedShipState | undefined,
): Promise<ShipPushOutcome> {
  let current = initial
  for (;;) {
    // --- §11.1 revalidation under the lock, with the §11.3 dance -----------

    const unstable = await stabilizeMap(deps, params, ctx)
    if (unstable !== undefined) return unstable

    // --- the final target read under the lock (§11.3) ----------------------

    const target = await readTarget(deps, params, config)
    if (target.kind !== 'ok') return target.failure

    let candidate: FinalCandidate
    if (current !== undefined && current.checkpoint.baseSha === target.sha) {
      // The recorded candidate is already gated against the current target:
      // revalidate-only and push the same recorded integration commit
      // (§13.3 step 2 — revalidation, never a fresh guess).
      candidate = candidateFromCheckpoint(current)
    } else {
      // --- §11.2 reconciliation, run under the lock -------------------------

      const reconciled = await runReconcile(deps, params, ctx)
      if (reconciled.kind !== 'ok') return reconciled
      candidate = reconciled.value
      const acceptedAfterReconcile = ctx.accepted

      // --- §11.3 pre-push stable Map re-read --------------------------------

      const prePush = await stabilizeMap(deps, params, ctx)
      if (prePush !== undefined) return prePush
      if (ctx.accepted.revision !== acceptedAfterReconcile.revision) {
        // The dance adopted a further extension after reconciliation: the
        // map and target were re-read, so rebuild the candidate once more
        // against the newest accepted revision and target.
        continue
      }

      // --- the final target read, again under the lock ----------------------

      const target2 = await readTarget(deps, params, config)
      if (target2.kind !== 'ok') return target2.failure
      if (target2.sha !== candidate.baseSha) {
        ctx.targetMoved = true
        if (attemptsOf(current) >= config.budget) {
          return blockedTargetAdvanced(candidate, target2.sha)
        }
        continue
      }

      // --- the Ship Checkpoint precedes any push (§11.3, §13.3) -------------

      const seal = sealDeliveryRecord(params, candidate, config.now())
      if (seal.kind !== 'ok') return seal
      const prepared = await deps.checkpoint.prepare({
        wave: params.wave,
        change: params.change,
        zeroDelta: candidate.zeroDelta,
        baseSha: candidate.baseSha,
        integratedSha: candidate.integratedSha,
        treeOid: candidate.treeOid,
        tests: candidate.tests,
        review: candidate.review,
        delivery: seal.value,
      })
      if (prepared.kind !== 'ok') return storeFailure('persisting the ship checkpoint', prepared)
      current = { wave: params.wave, change: params.change, checkpoint: prepared.value }
    }

    const checkpoint = current.checkpoint

    // --- zero-delta: no push, no attempt (§11.3) -----------------------------

    if (checkpoint.zeroDelta) {
      const probe = await stableProbe(deps, params, checkpoint, config)
      if (probe.kind === 'decided') {
        if (probe.result === 'present') {
          const marked = await markVerified(deps, 'none')
          if (marked.kind !== 'ok') return marked
          return verifiedOutcome(params, ctx, { ...current, checkpoint: marked.value }, probe.targetSha)
        }
        // The gated zero-delta state is gone: the target moved, so the normal
        // fresh gates apply while budget remains.
        ctx.targetMoved = true
        if (checkpoint.pushAttempts >= config.budget) {
          return blockedTargetAdvanced(candidateFromCheckpoint(current), probe.targetSha)
        }
        continue
      }
      return probeFailure(probe, false)
    }

    // --- the push itself ----------------------------------------------------

    if (checkpoint.pushAttempts >= config.budget) {
      // The recorded candidate is current but the budget is spent (§13.3).
      return exhaustedBlocked(checkpoint, target.sha, ctx)
    }
    const attempts = await deps.checkpoint.incrementPushAttempts()
    if (attempts.kind !== 'ok') {
      return storeFailure('persisting the push-attempt counter', attempts)
    }
    current = { ...current, checkpoint: { ...checkpoint, pushAttempts: attempts.value } }
    ctx.pushes += 1

    const pushed = await deps.push({
      root: params.repositoryRoot,
      remote: params.remote,
      branch: params.targetBranch,
      sha: stripOid(checkpoint.integratedSha),
    })

    switch (pushed.kind) {
      case 'pushed': {
        const probe = await stableProbe(deps, params, current.checkpoint, config)
        if (probe.kind === 'decided') {
          if (probe.result === 'present') {
            const marked = await markVerified(deps, 'confirmed')
            if (marked.kind !== 'ok') return marked
            return verifiedOutcome(params, ctx, { ...current, checkpoint: marked.value }, probe.targetSha)
          }
          // The push reported success but the integration is provably
          // absent: a contradictory remote state is unknown, never a guess.
          return probeFailure(
            {
              kind: 'ambiguous',
              reason:
                'the push reported success but the recorded integration is provably absent ' +
                'from the fetched target',
            },
            true,
          )
        }
        return probeFailure(probe, true)
      }
      case 'target-advanced': {
        ctx.targetMoved = true
        if (attempts.value >= config.budget) {
          return blocked({
            scope: 'ticket',
            code: 'target-advanced',
            reason:
              `the push of ticket #${params.change.ticket.number} lost optimistic concurrency ` +
              `${attempts.value} times; the retry budget of ${config.budget} push(es) is exhausted`,
            sharedWrite: 'none',
            evidence: [
              { integratedSha: checkpoint.integratedSha, pushAttempts: attempts.value },
            ],
          })
        }
        continue
      }
      case 'rejected': {
        return blocked({
          scope: 'run',
          code: 'push-rejected',
          reason:
            `the target rejected the push of ticket #${params.change.ticket.number} ` +
            `(${pushed.detail}): ${pushed.message}`,
          sharedWrite: params.alreadyShipped ? 'confirmed' : 'none',
          evidence: [
            { detail: pushed.detail, pushAttempts: attempts.value, integratedSha: checkpoint.integratedSha },
          ],
        })
      }
      case 'unknown': {
        const probe = await stableProbe(deps, params, current.checkpoint, config)
        if (probe.kind === 'decided') {
          if (probe.result === 'present') {
            const marked = await markVerified(deps, 'confirmed')
            if (marked.kind !== 'ok') return marked
            return verifiedOutcome(params, ctx, { ...current, checkpoint: marked.value }, probe.targetSha)
          }
          if (attempts.value >= config.budget) {
            return exhaustedBlocked(current.checkpoint, probe.targetSha, ctx)
          }
          continue
        }
        return probeFailure(probe, true)
      }
    }
  }
}

async function markVerified(
  deps: ShipPushDeps,
  sharedWrite: 'none' | 'confirmed',
): Promise<Outcome<ShipCheckpoint, never, ShipPushErrorCode>> {
  const marked = await deps.checkpoint.markStage('push-verified')
  if (marked.kind !== 'ok') {
    // A persistence failure after the write was proven remote-present is an
    // error following a confirmed shared write — recoverable, never terminal
    // (§9, §13.2).
    return storeFailure('persisting push verification', marked, sharedWrite)
  }
  return ok(marked.value)
}

// ---------------------------------------------------------------------------
// Map stabilization under the lock (§11.1, §11.3 dance, §16 lock order)
// ---------------------------------------------------------------------------

/**
 * Read the stable Map snapshot under the target lock and classify it against
 * the latest accepted revision. A Compatible Map Extension follows the
 * release-adopt-reacquire dance — the target lock is released before the
 * repository control lock is taken for adoption, then reacquired and both
 * Map and target are re-read — until the stable snapshot equals the accepted
 * revision. An incompatible change, a non-OPEN map, or drifted Ticket facts
 * stop the shipment before any push. Returns the non-ok outcome, or
 * `undefined` when stable.
 */
async function stabilizeMap(
  deps: ShipPushDeps,
  params: ShipPushParams,
  ctx: ShipContext,
): Promise<ShipPushOutcome | undefined> {
  for (;;) {
    const mapRead = await deps.readMap()
    if (mapRead.kind === 'error') {
      return pushError('run', 'map-read', mapRead.reason, [...mapRead.evidence])
    }
    if (mapRead.kind === 'blocked') {
      return changedInput(params, [
        { stage: 'map-read', code: mapRead.code, reason: mapRead.reason },
        ...mapRead.evidence,
      ])
    }
    const snapshot = mapRead.value
    if (snapshot.state !== 'OPEN') {
      return changedInput(params, [
        { stage: 'map-state', mapState: snapshot.state, mapRevision: snapshot.mapRevision },
      ])
    }

    const classification = classifyMapChange(acceptedSnapshotFrom(ctx.accepted, params.map), snapshot)
    if (classification.kind === 'incompatible') {
      return changedInput(params, [
        { stage: 'map-classification', kind: 'incompatible', reasons: classification.reasons },
      ])
    }
    if (classification.kind === 'compatible-extension') {
      // §7.4 + §11.3 + §16: persist and adopt the extension — with the
      // target lock released — then reacquire and re-read Map and target.
      const payload = snapshotMapPayload(snapshot)
      if (payload.revision !== snapshot.mapRevision) {
        return pushError('run', 'map-read', 'the current snapshot does not re-hash to its revision', [
          { mapRevision: snapshot.mapRevision },
        ])
      }
      const adopted = await adoptWithDance(
        deps,
        {
          revision: snapshot.mapRevision,
          payload: payload.payload,
          fromRevision: ctx.accepted.revision,
          addedTicketIssueIds: classification.addedTicketIssueIds,
        },
        ctx,
      )
      if (adopted !== undefined) return adopted
      continue
    }

    // Identical revision: the shipped Ticket's own facts from this snapshot.
    const ticketIssueId = params.change.ticket.issueId
    const ticket = snapshot.tickets.find((entry) => entry.ref.issueId === ticketIssueId)
    if (ticket === undefined) {
      return changedInput(params, [{ stage: 'ticket-membership', ticketIssueId, present: false }])
    }
    if (ticket.state !== 'OPEN') {
      return changedInput(params, [{ stage: 'ticket-state', ticketIssueId, state: ticket.state }])
    }
    if (ticket.ticketRevision !== params.change.ticketRevision) {
      return changedInput(params, [
        {
          stage: 'ticket-revision',
          ticketIssueId,
          sealed: params.change.ticketRevision,
          current: ticket.ticketRevision,
        },
      ])
    }
    // §11.1: valid Completed Ticket evidence for every blocker. Membership
    // and complete blocker sets of accepted members are guaranteed unchanged
    // by the classification itself (§7.4 rules 2–4).
    for (const blockerRef of ticket.blockedBy) {
      const blocker = snapshot.tickets.find((entry) => entry.ref.issueId === blockerRef.issueId)
      if (blocker === undefined) {
        return changedInput(params, [
          { stage: 'blocker-membership', blockerIssueId: blockerRef.issueId, present: false },
        ])
      }
      const failure = await evaluateBlockerCompletion(deps, { ...params, accepted: ctx.accepted }, blocker)
      if (failure !== undefined) {
        return failure.kind === 'ok'
          ? pushError('run', 'state-integrity', 'blocker evaluation returned an undocumented value', [])
          : failure
      }
    }
    return undefined
  }
}

/**
 * The release-adopt-reacquire dance (§11.3, §16): the target lock is released
 * before the repository control lock is taken for extension adoption, then
 * reacquired. On adoption the caller re-reads both Map and target. Returns
 * the non-ok outcome, or `undefined` on success.
 */
async function adoptWithDance(
  deps: ShipPushDeps,
  extension: ShipExtensionAdoption,
  ctx: ShipContext,
): Promise<ShipPushOutcome | undefined> {
  const lockFailure = await releaseCurrentLock(ctx)
  if (lockFailure !== undefined) return lockFailure
  const adopted = await deps.adoptExtension(extension)
  // Reacquire regardless of the adoption outcome so the protocol either
  // continues under the lock or unwinds with it held-then-released by shipPush.
  const reacquired = await deps.lock.acquire()
  if (reacquired.kind !== 'ok') {
    ctx.lock = undefined
    return pushError(
      'run',
      'lock-failed',
      `reacquiring the target lock after extension adoption failed: ${reacquired.reason}`,
      [],
    )
  }
  ctx.lock = reacquired.value
  if (adopted.kind !== 'ok') {
    return pushError('run', 'control-store', adopted.reason, [...adopted.evidence])
  }
  ctx.accepted = {
    revision: extension.revision,
    payload: extension.payload,
    extension: {
      fromRevision: extension.fromRevision,
      addedTicketIssueIds: [...extension.addedTicketIssueIds],
    },
  }
  ctx.adopted.push({
    revision: extension.revision,
    fromRevision: extension.fromRevision,
    addedTicketIssueIds: [...extension.addedTicketIssueIds],
  })
  return undefined
}

async function releaseCurrentLock(ctx: ShipContext): Promise<ShipPushOutcome | undefined> {
  const lock = ctx.lock
  ctx.lock = undefined
  if (lock === undefined) {
    return pushError('run', 'lock-failed', 'the target lock is not held for the extension dance', [])
  }
  const released = await lock.release()
  if (released.kind !== 'ok') {
    return pushError('run', 'lock-failed', released.reason, [])
  }
  return undefined
}

/**
 * Run the §11.2 reconciliation under the target lock. Reconcile's own
 * extension adoption is wrapped with the same release-adopt-reacquire dance,
 * because it executes while the target lock is held (§16 lock order).
 */
async function runReconcile(
  deps: ShipPushDeps,
  params: ShipPushParams,
  ctx: ShipContext,
): Promise<Outcome<FinalCandidate, ShipPushBlockCode, ShipPushErrorCode>> {
  const dancingDeps: ShipPushDeps = {
    ...deps,
    adoptExtension: (extension) => adoptWithDance(deps, extension, ctx).then(outcomeToAdoption),
  }
  return reconcileFinalCandidate(dancingDeps, { ...params, accepted: ctx.accepted })
}

/** Adapt the dance outcome back to the adoption seam's outcome shape. */
function outcomeToAdoption(
  outcome: ShipPushOutcome | undefined,
): Outcome<void, never, 'control-store'> {
  if (outcome === undefined) return ok(undefined)
  return error({
    scope: 'run',
    code: 'control-store',
    reason: `extension adoption while reconciling under the target lock failed: ${outcome.kind === 'error' || outcome.kind === 'blocked' ? `${outcome.code} — ${outcome.reason}` : 'unknown failure'}`,
    sharedWrite: 'none',
    evidence: [],
  })
}

// ---------------------------------------------------------------------------
// Target reads and bounded stable probes (§11.3)
// ---------------------------------------------------------------------------

type TargetRead =
  | { readonly kind: 'ok'; readonly sha: GitObjectOid; readonly treeOid: GitObjectOid }
  | { readonly kind: 'failure'; readonly failure: ShipPushOutcome }

/** Fetch and read the current remote target commit and its tree (§11.1). */
async function readTarget(
  deps: ShipPushDeps,
  params: ShipPushParams,
  config: PushConfig,
): Promise<TargetRead> {
  const failure = (reason: string, evidence: readonly Evidence[] = []): TargetRead => ({
    kind: 'failure',
    failure: pushError('run', 'target-read', reason, evidence),
  })
  const fetched = await deps.facts.fetchTarget(params.targetBranch)
  if (fetched.kind !== 'ok') return failure(fetched.reason, [...fetched.evidence])
  const shaRead = await deps.facts.targetSha(params.targetBranch)
  if (shaRead.kind !== 'ok') return failure(shaRead.reason, [...shaRead.evidence])
  const sha = toOid(config.format, shaRead.value)
  if (sha === undefined) return failure(`the target SHA is not a ${config.format} object ID`, [
    { targetSha: shaRead.value },
  ])
  const commitRead = await deps.facts.commitFacts(stripOid(sha))
  if (commitRead.kind !== 'ok') return failure(commitRead.reason, [...commitRead.evidence])
  if (commitRead.value === undefined) {
    return failure(`the target commit ${sha} is absent after the fetch`, [{ targetSha: sha }])
  }
  const treeOid = toOid(config.format, commitRead.value.treeOid)
  if (treeOid === undefined) {
    return failure(`the target commit ${sha} carries a tree that is not a ${config.format} object ID`)
  }
  return { kind: 'ok', sha, treeOid }
}

/** One cycle's classification of the recorded integration against the target. */
type RemoteClassification =
  | { readonly kind: 'classified'; readonly result: 'present' | 'absent' }
  | { readonly kind: 'ambiguous'; readonly reason: string }
  | { readonly kind: 'infra'; readonly reason: string }

type StableProbe =
  | { readonly kind: 'decided'; readonly result: 'present' | 'absent'; readonly targetSha: string }
  | { readonly kind: 'ambiguous'; readonly reason: string }
  | { readonly kind: 'infra'; readonly reason: string }

/**
 * Classify the recorded integration shape against the fetched remote target:
 * `present` proves the exact integration shape — recorded SHA, exactly one
 * parent equal to `baseSha`, the recorded tree, and ancestry of the fetched
 * target (for zero-delta: the target still equals `integratedSha` with the
 * recorded tree) — and `absent` proves the delivery is not on the target.
 * Anything else stays unclassified and is never guessed from.
 */
async function classifyRemote(
  deps: ShipPushDeps,
  params: ShipPushParams,
  checkpoint: ShipCheckpoint,
  config: PushConfig,
  targetSha: GitObjectOid,
): Promise<RemoteClassification> {
  if (checkpoint.zeroDelta) {
    if (targetSha !== checkpoint.integratedSha) {
      // The gated zero-delta state is gone: the target moved past it.
      return { kind: 'classified', result: 'absent' }
    }
    const facts = await deps.facts.commitFacts(stripOid(checkpoint.integratedSha))
    if (facts.kind !== 'ok') return { kind: 'infra', reason: facts.reason }
    if (facts.value === undefined) {
      return { kind: 'infra', reason: 'the fetched target commit is absent from the object store' }
    }
    if (toOid(config.format, facts.value.treeOid) !== checkpoint.treeOid) {
      return { kind: 'ambiguous', reason: 'the fetched target commit carries a different tree than recorded' }
    }
    return { kind: 'classified', result: 'present' }
  }
  const facts = await deps.facts.commitFacts(stripOid(checkpoint.integratedSha))
  if (facts.kind !== 'ok') return { kind: 'infra', reason: facts.reason }
  if (facts.value === undefined) {
    return { kind: 'classified', result: 'absent' }
  }
  const tree = toOid(config.format, facts.value.treeOid)
  const parents = facts.value.parents.map((parent) => toOid(config.format, parent))
  if (
    tree !== checkpoint.treeOid ||
    parents.length !== 1 ||
    parents[0] !== checkpoint.baseSha
  ) {
    return {
      kind: 'ambiguous',
      reason: 'the integration commit is present with a different shape than recorded',
    }
  }
  const ancestor = await deps.facts.isAncestorOfTarget(
    stripOid(checkpoint.integratedSha),
    params.targetBranch,
  )
  if (ancestor.kind !== 'ok') return { kind: 'infra', reason: ancestor.reason }
  if (!ancestor.value) {
    // Present in the object database but not on the target branch: the
    // delivery itself is absent (§13.3 — finding the object is insufficient).
    return { kind: 'classified', result: 'absent' }
  }
  return { kind: 'classified', result: 'present' }
}

/**
 * Bounded stable fetches (§11.3): cycles of fetch + target read +
 * classification, until two adjacent cycles agree. A decided classification
 * is proved; persistent disagreement or unclassifiable cycles are ambiguity,
 * never a guess.
 */
async function stableProbe(
  deps: ShipPushDeps,
  params: ShipPushParams,
  checkpoint: ShipCheckpoint,
  config: PushConfig,
): Promise<StableProbe> {
  const observations: string[] = []
  let last: { readonly key: string; readonly decided: StableProbe | undefined } | undefined
  for (let cycle = 1; cycle <= config.stableFetchMax; cycle++) {
    const fetched = await deps.facts.fetchTarget(params.targetBranch)
    if (fetched.kind !== 'ok') {
      observations.push(`fetch failed: ${fetched.reason}`)
      last = { key: `infra|${fetched.reason}`, decided: undefined }
      continue
    }
    const shaRead = await deps.facts.targetSha(params.targetBranch)
    if (shaRead.kind !== 'ok') {
      observations.push(`target read failed: ${shaRead.reason}`)
      last = { key: `infra|${shaRead.reason}`, decided: undefined }
      continue
    }
    const sha = toOid(config.format, shaRead.value)
    if (sha === undefined) {
      observations.push(`the target SHA is not a ${config.format} object ID`)
      last = { key: `infra|malformed`, decided: undefined }
      continue
    }
    const classification = await classifyRemote(deps, params, checkpoint, config, sha)
    if (classification.kind === 'classified') {
      const decided: StableProbe = { kind: 'decided', result: classification.result, targetSha: sha }
      const key = `${classification.result}|${sha}`
      if (last !== undefined && last.key === key) return decided
      last = { key, decided }
      continue
    }
    observations.push(`${classification.kind}: ${classification.reason}`)
    const key = `${classification.kind}|${classification.reason}`
    if (last !== undefined && last.key === key) {
      return { kind: classification.kind, reason: classification.reason }
    }
    last = { key, decided: undefined }
  }
  if (last === undefined) {
    return { kind: 'infra', reason: `every fetch cycle failed: ${observations.join('; ')}` }
  }
  if (last.decided !== undefined) return last.decided
  return {
    kind: 'ambiguous',
    reason:
      `no two adjacent fetch cycles agreed after ${config.stableFetchMax} cycles: ` +
      observations.join('; '),
  }
}

// ---------------------------------------------------------------------------
// The sealed Delivery Record (§14)
// ---------------------------------------------------------------------------

/** Seal the exact Delivery Record of this candidate, `deliveryId` included. */
function sealDeliveryRecord(
  params: ShipPushParams,
  candidate: FinalCandidate,
  recordedAt: string,
): Outcome<DeliveryRecordV1, never, ShipPushErrorCode> {
  const problem = gateMatchesTests(params.gate, candidate.tests)
  if (problem !== undefined) {
    return pushError('run', 'state-integrity', problem, [])
  }
  const record: Omit<DeliveryRecordV1, 'deliveryId'> = {
    schema: 'norn-delivery:v1',
    run: {
      id: params.runId,
      configRevision: params.configRevision,
      nornVersion: params.nornVersion,
    },
    gate: params.gate,
    map: { issueId: params.map.issueId, revision: candidate.mapRevision },
    ticket: { issueId: candidate.ticket.issueId, revision: candidate.ticketRevision },
    target: {
      repositoryId: params.map.repositoryId,
      branch: params.targetBranch,
      baseSha: candidate.baseSha,
      integratedSha: candidate.integratedSha,
      treeOid: candidate.treeOid,
    },
    review: candidate.review,
    tests: [...candidate.tests],
    actorId: params.actorId,
    recordedAt,
  }
  return ok({ ...record, deliveryId: computeDeliveryId(record) })
}

/**
 * The sealed gate must be realized exactly by the candidate's ordered tests
 * (§14 predicate 8): one entry per gate test at matching index, argv, and
 * timeout. Returns the violation, or `undefined` when consistent.
 */
function gateMatchesTests(
  gate: EvidenceGateV1,
  tests: readonly TestEvidence[],
): string | undefined {
  if (gate.tests.length !== tests.length) {
    return `the sealed gate lists ${gate.tests.length} tests but the candidate carries ${tests.length}`
  }
  for (let index = 0; index < tests.length; index++) {
    const test = tests[index]!
    const gateTest = gate.tests[index]!
    if (test.testIndex !== index) {
      return `candidate test ${index} carries testIndex ${test.testIndex}`
    }
    if (test.argv.join('\u0000') !== gateTest.argv.join('\u0000')) {
      return `candidate test ${index} argv differs from the sealed gate test`
    }
    if (test.timeoutMs !== gateTest.timeoutMs) {
      return `candidate test ${index} timeoutMs differs from the sealed gate test`
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Outcome helpers
// ---------------------------------------------------------------------------

/** The `ok` value once remote verification proved the exact integration. */
function verifiedOutcome(
  params: ShipPushParams,
  ctx: ShipContext,
  current: LoadedShipState,
  remoteTargetSha: string,
): ShipPushOutcome {
  return ok({
    ticket: params.change.ticket,
    checkpoint: current.checkpoint,
    candidate: candidateFromCheckpoint(current),
    remoteTargetSha,
    adoptedExtensions: [...ctx.adopted],
    pushes: ctx.pushes,
  })
}

/** The recorded candidate, reconstructed from a persisted checkpoint. */
function candidateFromCheckpoint(current: LoadedShipState): FinalCandidate {
  const checkpoint = current.checkpoint
  return {
    ticket: current.change.ticket,
    zeroDelta: checkpoint.zeroDelta,
    baseSha: checkpoint.baseSha,
    integratedSha: checkpoint.integratedSha,
    treeOid: checkpoint.treeOid,
    integrationCommit: checkpoint.zeroDelta ? null : checkpoint.integratedSha,
    mapRevision: checkpoint.review.mapRevision,
    ticketRevision: checkpoint.review.ticketRevision,
    tests: checkpoint.tests,
    review: checkpoint.review,
  }
}

function attemptsOf(current: LoadedShipState | undefined): number {
  return current?.checkpoint.pushAttempts ?? 0
}

/**
 * Budget exhaustion (§11.3, §13.3 step 2): `blocked(target-advanced)` when
 * the target moved past a gated base during this protocol — the fetched
 * target now differs from the recorded base, or an earlier attempt lost
 * optimistic concurrency — otherwise `blocked(push-retries-exhausted)`. Both
 * are ticket-scoped with `sharedWrite: 'none'` for this Ticket.
 */
function exhaustedBlocked(
  checkpoint: ShipCheckpoint,
  targetSha: string,
  ctx: { readonly targetMoved: boolean },
): ShipPushOutcome {
  const moved = ctx.targetMoved || targetSha !== checkpoint.baseSha
  return blocked({
    scope: 'ticket',
    code: moved ? 'target-advanced' : 'push-retries-exhausted',
    reason: moved
      ? `the target advanced to ${targetSha} and the push retry budget of ` +
        `${checkpoint.pushAttempts} attempt(s) is exhausted`
      : `the push retry budget of ${checkpoint.pushAttempts} attempt(s) is exhausted ` +
        'while the target stayed at the recorded base',
    sharedWrite: 'none',
    evidence: [
      { baseSha: checkpoint.baseSha, targetSha, pushAttempts: checkpoint.pushAttempts },
    ],
  })
}

function blockedTargetAdvanced(candidate: FinalCandidate, targetSha: string): ShipPushOutcome {
  return blocked({
    scope: 'ticket',
    code: 'target-advanced',
    reason:
      `the target advanced to ${targetSha} past the gated base ${candidate.baseSha} and no ` +
      'push budget remains to repeat reconciliation and fresh gates',
    sharedWrite: 'none',
    evidence: [{ baseSha: candidate.baseSha, targetSha }],
  })
}

/** The run-scoped `blocked(changed-input)` of §11.1, before any push. */
function changedInput(params: ShipPushParams, evidence: readonly Evidence[]): ShipPushOutcome {
  return blocked({
    scope: 'run',
    code: 'changed-input',
    reason:
      'the trustworthy facts the Ship of this Ticket depends on changed; no push occurred ' +
      '(design.md §11.1, §11.3)',
    sharedWrite: params.alreadyShipped ? 'confirmed' : 'none',
    evidence: [...evidence],
  })
}

/**
 * An unclassifiable remote state (§11.3): after a possibly-landed push this
 * is a recoverable run-scoped error carrying `sharedWrite: 'unknown'`; before
 * any write it is an ordinary target-read error.
 */
function probeFailure(
  probe: Exclude<StableProbe, { kind: 'decided' }>,
  pendingWrite: boolean,
): ShipPushOutcome {
  if (pendingWrite) {
    return error({
      scope: 'run',
      code: 'push-unknown',
      reason:
        `the remote state of the pushed integration commit could not be classified after ` +
        `bounded stable fetches: ${probe.reason}`,
      sharedWrite: 'unknown',
      evidence: [{ probe: probe.kind, reason: probe.reason }],
    })
  }
  return pushError('run', 'target-read', probe.reason, [{ probe: probe.kind }])
}

function storeFailure<T>(
  what: string,
  failure: Outcome<never, never, ShipStoreErrorCode>,
  sharedWrite: 'none' | 'confirmed' = 'none',
): Outcome<T, never, ShipPushErrorCode> {
  if (failure.kind === 'ok') return failure
  return error({
    scope: 'run',
    code: failure.code,
    reason: `${what} failed: ${failure.reason}`,
    sharedWrite,
    evidence: [...failure.evidence],
  })
}

function pushError<T>(
  scope: 'ticket' | 'run',
  code: ShipPushErrorCode,
  reason: string,
  evidence: readonly Evidence[],
): Outcome<T, never, ShipPushErrorCode> {
  return error({ scope, code, reason, sharedWrite: 'none', evidence: [...evidence] })
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Strip an object OID to raw hex; identity when already raw. */
function stripOid(oid: string): string {
  const parsed = parseGitObjectOid(oid)
  return parsed === undefined ? oid : parsed.hex
}

/** Normalize a facts-seam value (raw hex or formatted OID) to a formatted OID. */
function toOid(format: GitObjectFormat, value: string): GitObjectOid | undefined {
  const parsed = parseGitObjectOid(value)
  if (parsed !== undefined) return value
  return formatGitObjectOid(format, value)
}
