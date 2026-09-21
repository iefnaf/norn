/**
 * Delivery Record write-or-reuse, Ticket close, and the Completed Ticket
 * (design.md §11.3, §13.3 steps 3–5, §14 — ticket #12).
 *
 * The guarded tail of Ship, entered only from a checkpoint whose push stage
 * was remotely verified (`shipPush`, ticket #11). The sealed record —
 * `recordedAt` sealed, `deliveryId` computed, persisted in the Ship
 * Checkpoint before the push — is reused verbatim on every replay, so an
 * interrupted close re-invoked over the same persisted state reuses the
 * identical record bytes and never writes divergent content under one
 * `deliveryId` (§13.3).
 *
 * ```text
 * acquire the target lock — held through the atomic `completed` update
 *     ↓
 * re-read the stable Map; classify; a Compatible Map Extension observed
 * while holding the lock → release, adopt under the repository control
 * lock, reacquire, re-read Map and target (§11.3, §16)
 *     ↓
 * write or reuse the Delivery Record comment (§14):
 *   scan the fully-paginated comments for the sealed deliveryId — a
 *   byte-identical canonical record is reused (duplicates warn; the
 *   earliest trusted identical copy anchors the close window), while the
 *   same ID with divergent canonical content, or any malformed marked
 *   comment, is integrity-blocking before anything else is written
 *     ↓
 * re-read Ticket state and timeline; a close-then-reopen sequence after the
 * anchor stops this Ship instead of overwriting operator intent; a Ticket
 * already closed with no later reopen skips the close call — a close whose
 * record postdates it is caught by the §14 chronology predicate and repaired
 *     ↓
 * close the still-open Ticket — a close response is not completion evidence
 *     ↓
 * re-read the stable Map, Ticket, blockers, current closing event, and the
 * fetched remote target; evaluate every §14 Completed Ticket predicate
 * through `evaluateDeliveryEvidence` (plus the §11.3 zero-delta rule that
 * the target still equal `integratedSha` at this validation)
 *     ↓
 * only a successfully persisted post-close validation makes the Ticket a
 * Completed Ticket; stale facts reopen-repair the Ticket and end the run
 * `blocked(changed-input)` with the partial shared writes recorded; an
 * unknown close or reopen result is a recoverable run-scoped error
 *     ↓
 * clean up the workspace — a failure is a warning and cannot undo a
 * verified Completed Ticket (§11.3)
 * ```
 *
 * Orchestration composes the earlier tickets' seams: the §14 record grammar
 * and Completed Ticket predicate (`src/evidence/`), the issue-evidence read
 * seam and the GitHub issue-write seam (`src/adapters/github-gateway`), the
 * Run-State-backed Ship Checkpoint store (extended in `src/ship/push`), the
 * map snapshot and §7.4 classifier, the Git delivery facts, the target lock,
 * and the §9 outcome model.
 */
import { rmSync } from 'node:fs'

import { blocked, error, ok } from '../core/outcome.ts'
import type { Evidence, Outcome } from '../core/outcome.ts'
import { canonicalJson } from '../core/canonical-json.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'
import type { GitHubIssueWriter } from '../adapters/github-gateway.ts'
import { evaluateDeliveryEvidence } from '../evidence/delivery.ts'
import type { DeliveryEvidenceFinding } from '../evidence/delivery.ts'
import { formatRecordEnvelope, parseRecordEnvelope } from '../evidence/envelope.ts'
import type {
  EvidenceIssueLocator,
  IssueEvidenceReader,
  IssueEvidenceRead,
} from '../evidence/read.ts'
import { classifyMapChange } from '../map/map-extension.ts'
import type { MapRef, TaskMapSnapshot } from '../map/snapshot.ts'
import type { StableSnapshotOutcome } from '../map/stable-read.ts'
import { acceptedSnapshotFrom, snapshotMapPayload } from './reconcile.ts'
import type { ShipExtensionAdoption, ShipFacts } from './reconcile.ts'
import type {
  LoadedCompletedTicket,
  LoadedShipState,
  PushAdoptedExtension,
  ShipCheckpointStore,
  ShipStoreErrorCode,
  ShipTargetLock,
  ShipTargetLockHandle,
} from './push.ts'
import type {
  AcceptedMapRevision,
  DeliveryRecordV1,
  TicketRef,
  WorkspaceRef,
} from '../runstate/types.ts'

// ---------------------------------------------------------------------------
// Outcome vocabulary (§9, §11.3)
// ---------------------------------------------------------------------------

/**
 * The one block code of the close stage: trustworthy facts the Ship depends
 * on changed (map, ticket, blocker, chronology, record, or target facts).
 * Every occurrence is run-scoped — it stops the shipping queue — and its
 * `sharedWrite` records the partial shipment exactly (§11.3).
 */
export type ShipCloseBlockCode = 'changed-input'

/** Closed error codes of the close stage; every one is run-scoped (§9). */
export type ShipCloseErrorCode =
  /** The stable Map read failed on infrastructure. */
  | 'map-read'
  /** The issue evidence (comments/timeline) could not be read consistently. */
  | 'evidence-read'
  /** The record comment write returned an unknown result. */
  | 'comment-write'
  /** The issue close returned an unknown result. */
  | 'issue-close'
  /** A repair reopen returned an unknown result. */
  | 'issue-reopen'
  /** The remote target could not be fetched or read. */
  | 'target-read'
  /** The Ship Checkpoint store failed. */
  | 'control-store'
  /** The persisted state contradicts this close. */
  | 'state-integrity'
  /** The target lock could not be acquired, released, or reacquired. */
  | 'lock-failed'

/** The verified result of one completed close protocol run. */
export type ShipCloseVerified = {
  readonly ticket: TicketRef
  readonly deliveryId: string
  readonly integratedSha: string
  /** The timeline anchor: the earliest trusted identical record copy. */
  readonly anchorCommentId?: string
  /** Whether this invocation wrote the record comment (false = reused). */
  readonly commentWritten?: boolean
  /** Compatible Map Extensions adopted during this close, in order. */
  readonly adoptedExtensions: readonly PushAdoptedExtension[]
  /** Duplicate-record and cleanup warnings; none can undo completion. */
  readonly warnings: readonly string[]
}

export type ShipCloseOutcome = Outcome<ShipCloseVerified, ShipCloseBlockCode, ShipCloseErrorCode>

// ---------------------------------------------------------------------------
// The injected seams and parameters
// ---------------------------------------------------------------------------

/** The close stage composes the evidence, gateway, and checkpoint seams. */
export type ShipCloseDeps = {
  /** One stable read of the current Task Map snapshot (§7.3). */
  readonly readMap: () => Promise<StableSnapshotOutcome>
  /** One complete comments+timeline read of one issue (§14). */
  readonly readIssueEvidence: IssueEvidenceReader['loadIssueEvidence']
  /** The GitHub issue-write seam: record comment, close, reopen (§11.3). */
  readonly writer: GitHubIssueWriter
  /** The remote target and commit facts seam, fetch included (§14). */
  readonly facts: ShipFacts
  /** Persists a Compatible Map Extension before the close continues (§7.4).
   * `blocked(changed-input)` means another active run claimed an added
   * Ticket under the repository control lock — adoption is prevented and
   * the change is treated as incompatible (§7.4, §16).
   */
  readonly adoptExtension: (
    extension: ShipExtensionAdoption,
  ) => Promise<Outcome<void, 'changed-input', 'control-store'>>
  /** Atomic Ship Checkpoint persistence over the Run State store. */
  readonly checkpoint: ShipCheckpointStore
  /** The target lock serializing Ship per repository and branch (§16). */
  readonly lock: ShipTargetLock
  /** Workspace cleanup; a failure is a warning and never undoes completion. */
  readonly cleanup: (workspace: WorkspaceRef) => Promise<Outcome<void, never, 'cleanup-failed'>>
}

/** Everything one close needs, beyond its injected seams. */
export type ShipCloseParams = {
  /** The map issue reference, for §7.4 classification. */
  readonly map: MapRef
  /** The ticket being closed — the sealed change's ticket. */
  readonly ticket: TicketRef
  /** The latest accepted lineage entry when the close starts (§7.4, §13.1). */
  readonly accepted: AcceptedMapRevision
  readonly runId: string
  readonly targetBranch: string
  readonly trustedEvidenceAuthorIds: readonly string[]
  /** Whether this run already shipped an earlier Ticket (§11.3). */
  readonly alreadyShipped: boolean
}

/** The production workspace cleanup: idempotent recursive deletion (§13.2). */
export function fsWorkspaceCleanup(): (
  workspace: WorkspaceRef,
) => Promise<Outcome<void, never, 'cleanup-failed'>> {
  return async (workspace) => {
    try {
      rmSync(workspace.path, { recursive: true, force: true })
      return ok(undefined)
    } catch (cause) {
      return error({
        scope: 'run',
        code: 'cleanup-failed',
        reason: `deleting the workspace at ${workspace.path} failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        sharedWrite: 'none',
        evidence: [{ path: workspace.path }],
      })
    }
  }
}

// ---------------------------------------------------------------------------
// The close protocol (§11.3, §13.3 steps 3–5)
// ---------------------------------------------------------------------------

type CloseContext = {
  lock: ShipTargetLockHandle | undefined
  accepted: AcceptedMapRevision
  adopted: PushAdoptedExtension[]
  warnings: string[]
  /** The shared-write state proven so far by this run (§9, §11.3). */
  sharedWrite: 'none' | 'confirmed'
  current: LoadedShipState
}

/**
 * Complete one verified shipment: write or reuse the Delivery Record
 * comment, close the Ticket, re-read every fact, evaluate the complete §14
 * predicate, and persist the Completed Ticket. Returns only after the
 * atomic `completed` update (or a typed non-success stopped the close); the
 * target lock is held from entry through that update and released on every
 * exit path.
 */
export async function shipClose(deps: ShipCloseDeps, params: ShipCloseParams): Promise<ShipCloseOutcome> {
  const loaded = await deps.checkpoint.load()
  if (loaded.kind !== 'ok') return entryLoadFailure(loaded)
  if (loaded.value === undefined) {
    // No shipping checkpoint: a completed Ticket with a retained cleanup
    // workspace replays only its cleanup (§13.1); anything else contradicts
    // the close protocol's entry contract.
    const completed = await deps.checkpoint.loadCompleted()
    if (completed.kind !== 'ok') return entryLoadFailure(completed)
    if (completed.value !== undefined && completed.value.cleanupWorkspace !== undefined) {
      return retryCleanup(deps, params, completed.value)
    }
    return closeError(
      'state-integrity',
      `ticket ${params.ticket.issueId} has neither a shipping checkpoint nor a completed cleanup replay`,
      [{ ticketIssueId: params.ticket.issueId }],
      'unknown',
    )
  }
  const current = loaded.value
  if (current.checkpoint.stage === 'prepared') {
    return closeError(
      'state-integrity',
      'the shipping checkpoint is still at stage "prepared"; the push must verify before any close',
      [{ stage: current.checkpoint.stage }],
      'unknown',
    )
  }
  if (current.change.ticket.issueId !== params.ticket.issueId) {
    return closeError(
      'state-integrity',
      'the persisted shipping checkpoint binds a different ticket than this close',
      [{ persisted: current.change.ticket.issueId, close: params.ticket.issueId }],
      'unknown',
    )
  }
  const record = current.checkpoint.delivery
  if (record.ticket.issueId !== params.ticket.issueId || record.map.issueId !== params.map.issueId) {
    return closeError(
      'state-integrity',
      'the sealed Delivery Record does not bind this close ticket and map',
      [
        { recordTicket: record.ticket.issueId, recordMap: record.map.issueId },
        { closeTicket: params.ticket.issueId, closeMap: params.map.issueId },
      ],
      'unknown',
    )
  }

  const acquired = await deps.lock.acquire()
  if (acquired.kind !== 'ok') {
    return closeError(
      'lock-failed',
      `acquiring the target lock for ${params.targetBranch} failed: ${acquired.reason}`,
      [],
    )
  }
  const ctx: CloseContext = {
    lock: acquired.value,
    accepted: params.accepted,
    adopted: [],
    warnings: [],
    // §11.3: a verified non-zero push is a confirmed shared write; a
    // zero-delta shipment is confirmed only if this run already shipped.
    sharedWrite: current.checkpoint.zeroDelta
      ? params.alreadyShipped
        ? 'confirmed'
        : 'none'
      : 'confirmed',
    current,
  }
  try {
    return await runCloseProtocol(deps, params, ctx)
  } finally {
    // Every exit path releases the lock; the OS-backed lock also dies with
    // the process, so a release failure here cannot strand Ship forever.
    const lock = ctx.lock
    ctx.lock = undefined
    if (lock !== undefined) await lock.release()
  }
}

async function runCloseProtocol(
  deps: ShipCloseDeps,
  params: ShipCloseParams,
  ctx: CloseContext,
): Promise<ShipCloseOutcome> {
  // --- §11.1 revalidation under the lock, with the §11.3 dance -----------

  const stabilized = await stabilizeMap(deps, params, ctx)
  if ('failure' in stabilized) return await maybeRepair(deps, params, ctx, stabilized)

  // --- §11.3: write or reuse the Delivery Record comment (§14) -----------

  const recordOutcome = await writeOrReuseRecord(deps, params, ctx, ctx.current.checkpoint.delivery)
  if ('failure' in recordOutcome) return recordOutcome.failure

  // --- §11.3: inspect the timeline after the anchor, then close ----------

  const inspection = await inspectTimeline(deps, params, ctx, recordOutcome.anchor)
  if ('failure' in inspection) return inspection.failure
  if (inspection.action === 'close') {
    const closed = await deps.writer.closeIssue(locatorOf(params.ticket))
    if (closed.kind !== 'ok') {
      return closeError(
        'issue-close',
        `closing ticket #${params.ticket.number} returned an unknown result: ${closed.reason}`,
        [...closed.evidence],
        'unknown',
      )
    }
  }
  // Both paths leave the Ticket remotely closed — the skip-close path
  // observed the close — so the checkpoint confirms stage `ticket-closed`
  // either way (§13.1: the stage is the last remotely confirmed stage).
  const marked = await deps.checkpoint.markStage('ticket-closed')
  if (marked.kind !== 'ok') {
    return storeFailure(ctx, 'persisting the confirmed ticket close', marked)
  }
  ctx.current = { ...ctx.current, checkpoint: marked.value }

  // --- §11.3: the post-close re-read, §14 validation, and completion -----

  return validateAndComplete(deps, params, ctx, {
    anchor: recordOutcome.anchor.commentId,
    written: recordOutcome.written,
  })
}

// ---------------------------------------------------------------------------
// Map stabilization under the lock (§11.1, §11.3 dance, §16 lock order)
// ---------------------------------------------------------------------------

type Stabilized = { readonly snapshot: TaskMapSnapshot }
type StabilizeFailure = {
  readonly failure: ShipCloseOutcome
  /** The ticket state the failing snapshot observed, when it got that far. */
  readonly ticketState: 'OPEN' | 'CLOSED' | undefined
}

/**
 * Read the stable Map snapshot under the target lock and classify it against
 * the latest accepted revision. A Compatible Map Extension follows the
 * release-adopt-reacquire dance; for a zero-delta shipment the reacquired
 * target must still equal `integratedSha` (§11.3). Unlike the push stage,
 * both OPEN and CLOSED ticket states continue — the timeline inspection
 * decides between closing and the skip-close path. Returns the stabilized
 * snapshot, or the non-ok outcome plus the observed ticket state so the
 * caller can decide whether repair applies.
 */
async function stabilizeMap(
  deps: ShipCloseDeps,
  params: ShipCloseParams,
  ctx: CloseContext,
): Promise<Stabilized | StabilizeFailure> {
  for (;;) {
    const mapRead = await deps.readMap()
    if (mapRead.kind === 'error') {
      return {
        failure: closeFailure(ctx, 'map-read', mapRead.reason, [...mapRead.evidence]),
        ticketState: undefined,
      }
    }
    if (mapRead.kind === 'blocked') {
      return {
        failure: changedInput(ctx, [
          { stage: 'map-read', code: mapRead.code, reason: mapRead.reason },
          ...mapRead.evidence,
        ]),
        ticketState: undefined,
      }
    }
    const snapshot = mapRead.value
    const ticketEntry = snapshot.tickets.find((entry) => entry.ref.issueId === params.ticket.issueId)
    const observed: 'OPEN' | 'CLOSED' | undefined = ticketEntry?.state
    if (snapshot.state !== 'OPEN') {
      return {
        failure: changedInput(ctx, [
          { stage: 'map-state', mapState: snapshot.state, mapRevision: snapshot.mapRevision },
        ]),
        ticketState: observed,
      }
    }

    const classification = classifyMapChange(acceptedSnapshotFrom(ctx.accepted, params.map), snapshot)
    if (classification.kind === 'incompatible') {
      return {
        failure: changedInput(ctx, [
          { stage: 'map-classification', kind: 'incompatible', reasons: classification.reasons },
        ]),
        ticketState: observed,
      }
    }
    if (classification.kind === 'compatible-extension') {
      // §7.4 + §11.3 + §16: persist and adopt the extension — with the
      // target lock released — then reacquire and re-read Map and target.
      const payload = snapshotMapPayload(snapshot)
      if (payload.revision !== snapshot.mapRevision) {
        return {
          failure: closeFailure(ctx, 'map-read', 'the current snapshot does not re-hash to its revision', [
            { mapRevision: snapshot.mapRevision },
          ]),
          ticketState: observed,
        }
      }
      const danced = await adoptWithDance(deps, params, ctx, {
        revision: snapshot.mapRevision,
        payload: payload.payload,
        fromRevision: ctx.accepted.revision,
        addedTicketIssueIds: classification.addedTicketIssueIds,
      })
      if (danced !== undefined) return danced
      continue
    }

    // Identical revision: the shipped Ticket's own facts from this snapshot.
    if (ticketEntry === undefined) {
      return {
        failure: changedInput(ctx, [{ stage: 'ticket-membership', ticketIssueId: params.ticket.issueId }]),
        ticketState: undefined,
      }
    }
    if (ticketEntry.ticketRevision !== ctx.current.checkpoint.delivery.ticket.revision) {
      return {
        failure: changedInput(ctx, [
          {
            stage: 'ticket-revision',
            ticketIssueId: params.ticket.issueId,
            sealed: ctx.current.checkpoint.delivery.ticket.revision,
            current: ticketEntry.ticketRevision,
          },
        ]),
        ticketState: observed,
      }
    }
    // §11.1: valid Completed Ticket evidence for every blocker; membership
    // and complete blocker sets of accepted members are guaranteed unchanged
    // by the classification itself (§7.4 rules 2–4).
    const blockerFailure = await evaluateBlockers(deps, params, ctx, snapshot, ticketEntry)
    if (blockerFailure !== undefined) {
      return { failure: blockerFailure, ticketState: observed }
    }
    return { snapshot }
  }
}

/**
 * §11.1 blocker revalidation for the close stage: every declared blocker of
 * the shipped Ticket must currently be a valid Completed Ticket under the
 * complete §14 predicate, evaluated over one complete evidence read per
 * blocker against the fetched remote target.
 */
async function evaluateBlockers(
  deps: ShipCloseDeps,
  params: ShipCloseParams,
  ctx: CloseContext,
  snapshot: TaskMapSnapshot,
  ticket: TaskMapSnapshot['tickets'][number],
): Promise<ShipCloseOutcome | undefined> {
  for (const blockerRef of ticket.blockedBy) {
    const blocker = snapshot.tickets.find((entry) => entry.ref.issueId === blockerRef.issueId)
    if (blocker === undefined) {
      return changedInput(ctx, [
        { stage: 'blocker-membership', blockerIssueId: blockerRef.issueId, present: false },
      ])
    }
    const read = await deps.readIssueEvidence(locatorOf(blocker.ref))
    if (read.kind === 'error') {
      return closeFailure(ctx, 'evidence-read', read.reason, [
        { blockerIssueId: blockerRef.issueId },
        ...read.evidence,
      ])
    }
    if (read.kind === 'blocked') {
      return changedInput(ctx, [
        {
          stage: 'blocker-evidence-read',
          blockerIssueId: blockerRef.issueId,
          code: read.code,
          reason: read.reason,
        },
      ])
    }
    const evaluation = await evaluateDeliveryEvidence({
      map: {
        issueId: ctx.accepted.payload.mapIssueId,
        repositoryId: ctx.accepted.payload.repositoryId,
      },
      ticket: {
        issueId: blocker.ref.issueId,
        state: blocker.state,
        ticketRevision: blocker.ticketRevision,
      },
      targetBranch: params.targetBranch,
      trustedEvidenceAuthorIds: params.trustedEvidenceAuthorIds,
      evidence: read.value,
      facts: deps.facts,
    })
    if (evaluation.status === 'error') {
      return closeFailure(ctx, 'target-read', evaluation.reason, [
        { blockerIssueId: blocker.ref.issueId, code: evaluation.code },
      ])
    }
    if (evaluation.status !== 'completed') {
      return changedInput(ctx, [
        {
          stage: 'blocker-completion',
          blockerIssueId: blocker.ref.issueId,
          status: evaluation.status,
          findings: evaluation.status === 'no-record' ? [] : [...evaluation.findings],
        },
      ])
    }
  }
  return undefined
}

/**
 * The release-adopt-reacquire dance (§11.3, §16): the target lock is released
 * before the repository control lock is taken for extension adoption, then
 * reacquired and both Map and target are re-read. For a zero-delta shipment
 * the reacquired target must still equal `integratedSha`; if it moved, the
 * caller's repair path reopens a Ticket closed against that stale gate.
 * Returns the non-ok outcome, or `undefined` on success.
 */
async function adoptWithDance(
  deps: ShipCloseDeps,
  params: ShipCloseParams,
  ctx: CloseContext,
  extension: ShipExtensionAdoption,
): Promise<StabilizeFailure | undefined> {
  const releaseFailure = await releaseCurrentLock(ctx)
  if (releaseFailure !== undefined) return releaseFailure
  const adopted = await deps.adoptExtension(extension)
  // Reacquire regardless of the adoption outcome so the protocol either
  // continues under the lock or unwinds with it held-then-released by shipClose.
  const reacquired = await deps.lock.acquire()
  if (reacquired.kind !== 'ok') {
    ctx.lock = undefined
    return {
      failure: closeFailure(
        ctx,
        'lock-failed',
        `reacquiring the target lock after extension adoption failed: ${reacquired.reason}`,
        [],
      ),
      ticketState: undefined,
    }
  }
  ctx.lock = reacquired.value
  if (adopted.kind === 'blocked') {
    // §7.4/§16: another active run claimed an added Ticket under the
    // repository control lock — the change is treated as incompatible.
    return {
      failure: changedInput(ctx, [
        { stage: 'extension-adoption', reason: adopted.reason },
        ...adopted.evidence,
      ]),
      ticketState: undefined,
    }
  }
  if (adopted.kind !== 'ok') {
    return {
      failure: storeFailure(ctx, 'adopting the Compatible Map Extension', adopted),
      ticketState: undefined,
    }
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

  // §11.3: a zero-delta shipment requires the target still to equal the
  // recorded integration after the dance.
  if (ctx.current.checkpoint.zeroDelta) {
    const target = await fetchedTargetSha(deps, params, ctx)
    if ('failure' in target) {
      return { failure: target.failure, ticketState: undefined }
    }
    if (target.sha !== ctx.current.checkpoint.integratedSha) {
      return {
        failure: changedInput(ctx, [
          {
            stage: 'zero-delta-target-moved',
            integratedSha: ctx.current.checkpoint.integratedSha,
            targetSha: target.sha,
          },
        ]),
        ticketState: undefined,
      }
    }
  }
  return undefined
}

async function releaseCurrentLock(ctx: CloseContext): Promise<StabilizeFailure | undefined> {
  const lock = ctx.lock
  ctx.lock = undefined
  if (lock === undefined) {
    return {
      failure: closeFailure(ctx, 'lock-failed', 'the target lock is not held for the extension dance', []),
      ticketState: undefined,
    }
  }
  const released = await lock.release()
  if (released.kind !== 'ok') {
    return {
      failure: closeFailure(ctx, 'lock-failed', released.reason, []),
      ticketState: undefined,
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// §11.3: write or reuse the Delivery Record comment (§14 duplicate rules)
// ---------------------------------------------------------------------------

type RecordAnchor = {
  readonly commentId: string
  readonly authorId: string | null
}

type WriteOrReuse =
  | { readonly anchor: RecordAnchor; readonly written: boolean }
  | { readonly failure: ShipCloseOutcome }

/**
 * Write the sealed Delivery Record comment or reuse its byte-identical
 * canonical copy (§14): the fully-paginated comments are scanned for the
 * sealed `deliveryId`; identical canonical records are reused (duplicates
 * warn, and the earliest trusted identical copy anchors the close window),
 * while the same ID with divergent canonical content — or any malformed
 * marked comment, whose content cannot be proved either way — blocks before
 * any further write. Records under other IDs are left to the §14 predicate.
 */
async function writeOrReuseRecord(
  deps: ShipCloseDeps,
  params: ShipCloseParams,
  ctx: CloseContext,
  sealed: DeliveryRecordV1,
): Promise<WriteOrReuse> {
  const scan = await readTicketEvidence(deps, params, ctx, 'record-scan')
  if ('failure' in scan) return { failure: scan.failure }

  const sealedText = canonicalJson(sealed as unknown as CanonicalJsonValue)
  const trusted = new Set(params.trustedEvidenceAuthorIds)
  const identical: RecordAnchor[] = []
  const divergent: string[] = []
  const invalidMarked: { commentId: string; reason: string }[] = []
  for (const comment of scan.read.comments) {
    const envelope = parseRecordEnvelope(comment.body)
    if (envelope.kind === 'unmarked') continue
    if (envelope.kind === 'invalid') {
      invalidMarked.push({ commentId: comment.commentId, reason: envelope.reason })
      continue
    }
    const claimed = (envelope.value as { deliveryId?: unknown }).deliveryId
    if (claimed === sealed.deliveryId) {
      if (envelope.canonicalText === sealedText) {
        identical.push({ commentId: comment.commentId, authorId: comment.authorId })
      } else {
        divergent.push(comment.commentId)
      }
    }
  }
  if (divergent.length > 0 || invalidMarked.length > 0) {
    return {
      failure: changedInput(ctx, [{ stage: 'record-scan', divergent, invalidMarked }]),
    }
  }

  if (identical.length > 0) {
    if (identical.length > 1) {
      ctx.warnings.push(
        `duplicate byte-identical record comments count as one record: ${identical
          .map((copy) => copy.commentId)
          .join(', ')}`,
      )
    }
    // The earliest trusted identical copy anchors the close window (§14);
    // without a trusted copy the §14 author predicate governs the anchor.
    const trustedCopies = identical.filter(
      (copy) => copy.authorId === sealed.actorId && trusted.has(sealed.actorId),
    )
    const anchor = trustedCopies[0] ?? identical[0]!
    const marked = await markDeliveryRecorded(deps, ctx)
    if (marked !== undefined) return { failure: marked }
    ctx.sharedWrite = 'confirmed'
    return { anchor, written: false }
  }

  const written = await deps.writer.writeIssueComment(
    locatorOf(params.ticket),
    formatRecordEnvelope(sealedText),
  )
  if (written.kind !== 'ok') {
    return {
      failure: error({
        scope: 'run',
        code: 'comment-write',
        reason: `writing the Delivery Record comment returned an unknown result: ${written.reason}`,
        sharedWrite: 'unknown',
        evidence: [...written.evidence, { deliveryId: sealed.deliveryId }],
      }),
    }
  }
  ctx.sharedWrite = 'confirmed'
  const marked = await markDeliveryRecorded(deps, ctx)
  if (marked !== undefined) return { failure: marked }
  return { anchor: { commentId: written.value.commentId, authorId: sealed.actorId }, written: true }
}

/** Confirm stage `delivery-recorded` when the comment is remotely present. */
async function markDeliveryRecorded(
  deps: ShipCloseDeps,
  ctx: CloseContext,
): Promise<ShipCloseOutcome | undefined> {
  if (ctx.current.checkpoint.stage !== 'push-verified') return undefined
  const marked = await deps.checkpoint.markStage('delivery-recorded')
  if (marked.kind !== 'ok') {
    return storeFailure(ctx, 'persisting the confirmed Delivery Record comment', marked)
  }
  ctx.current = { ...ctx.current, checkpoint: marked.value }
  return undefined
}

// ---------------------------------------------------------------------------
// §11.3: timeline inspection after the anchor, then the close itself
// ---------------------------------------------------------------------------

type TimelineInspection =
  | { readonly action: 'close' }
  | { readonly action: 'skip-close' }
  | { readonly failure: ShipCloseOutcome }

/**
 * Re-read Ticket state and timeline after the record anchor. A
 * close-then-reopen sequence after the anchor is an operator-visible state
 * change that stops this Ship instead of being silently overwritten (§11.3,
 * §13.3 step 4). A Ticket already closed with no later reopen skips the
 * close call; whether its record predates that close is then judged by the
 * §14 chronology predicate, whose failure follows the reopen repair path.
 */
async function inspectTimeline(
  deps: ShipCloseDeps,
  params: ShipCloseParams,
  ctx: CloseContext,
  anchor: RecordAnchor,
): Promise<TimelineInspection> {
  const read = await readTicketEvidence(deps, params, ctx, 'close-window')
  if ('failure' in read) return { failure: read.failure }
  const timeline = read.read.timeline
  const anchorIndex = timeline.findIndex(
    (event) => event.kind === 'commented' && event.commentId === anchor.commentId,
  )
  if (anchorIndex === -1) {
    return {
      failure: closeFailure(ctx, 'evidence-read', 'the anchor record comment is missing from the issue timeline', [
        { anchorCommentId: anchor.commentId },
      ]),
    }
  }

  let sawCloseAfterAnchor = false
  let closeThenReopen = false
  let state: 'OPEN' | 'CLOSED' = 'OPEN'
  timeline.forEach((event, index) => {
    if (event.kind === 'closed') {
      state = 'CLOSED'
      if (index > anchorIndex) sawCloseAfterAnchor = true
    }
    if (event.kind === 'reopened') {
      state = 'OPEN'
      if (index > anchorIndex && sawCloseAfterAnchor) closeThenReopen = true
    }
  })
  if (closeThenReopen) {
    return {
      failure: blocked({
        scope: 'run',
        code: 'changed-input',
        reason:
          'a close followed by a reopen occurred after the Delivery Record anchor; the operator-visible ' +
          'state change stops this Ship instead of being silently overwritten (design.md §11.3)',
        sharedWrite: 'confirmed',
        evidence: [{ stage: 'close-then-reopen', anchorCommentId: anchor.commentId }],
      }),
    }
  }
  return { action: state === 'OPEN' ? 'close' : 'skip-close' }
}

// ---------------------------------------------------------------------------
// §11.3: the post-close re-read, complete §14 validation, completion
// ---------------------------------------------------------------------------

async function validateAndComplete(
  deps: ShipCloseDeps,
  params: ShipCloseParams,
  ctx: CloseContext,
  record: { readonly anchor: string; readonly written: boolean },
): Promise<ShipCloseOutcome> {
  // --- the stable Map, Ticket, and blocker re-read -------------------------

  const stabilized = await stabilizeMap(deps, params, ctx)
  if ('failure' in stabilized) return await maybeRepair(deps, params, ctx, stabilized)
  const snapshot = stabilized.snapshot
  const ticketEntry = snapshot.tickets.find((entry) => entry.ref.issueId === params.ticket.issueId)!

  // --- §11.3: a zero-delta delivery requires the target still at the gate -

  if (ctx.current.checkpoint.zeroDelta) {
    const target = await fetchedTargetSha(deps, params, ctx)
    if ('failure' in target) return target.failure
    if (target.sha !== ctx.current.checkpoint.integratedSha) {
      return await repairAndBlock(deps, params, ctx, ticketEntry.state, [
        {
          stage: 'zero-delta-target-moved',
          integratedSha: ctx.current.checkpoint.integratedSha,
          targetSha: target.sha,
        },
      ])
    }
  }

  // --- the current closing event and the complete §14 predicate -----------

  const postClose = await readTicketEvidence(deps, params, ctx, 'post-close')
  if ('failure' in postClose) return postClose.failure
  const sealed = ctx.current.checkpoint.delivery
  const evaluation = await evaluateDeliveryEvidence({
    map: {
      issueId: ctx.accepted.payload.mapIssueId,
      repositoryId: ctx.accepted.payload.repositoryId,
    },
    ticket: {
      issueId: params.ticket.issueId,
      state: ticketEntry.state,
      ticketRevision: ticketEntry.ticketRevision,
    },
    targetBranch: params.targetBranch,
    trustedEvidenceAuthorIds: params.trustedEvidenceAuthorIds,
    evidence: postClose.read,
    facts: deps.facts,
  })
  if (evaluation.status === 'error') {
    return closeFailure(ctx, 'target-read', evaluation.reason, [
      { stage: 'post-close-validation', code: evaluation.code },
    ])
  }
  if (evaluation.status !== 'completed') {
    ctx.warnings.push(...('warnings' in evaluation ? evaluation.warnings : []))
    return await repairAndBlock(deps, params, ctx, ticketEntry.state, [
      {
        stage: 'post-close-validation',
        status: evaluation.status,
        findings: findingsOf(evaluation),
      },
    ])
  }

  // --- only a successfully persisted validation completes the Ticket ------

  const completed = await deps.checkpoint.complete({
    deliveryId: sealed.deliveryId,
    integratedSha: ctx.current.checkpoint.integratedSha,
    cleanupWorkspace: ctx.current.change.workspace,
  })
  if (completed.kind !== 'ok') {
    return storeFailure(ctx, 'persisting the Completed Ticket', completed)
  }

  // --- §11.3: workspace cleanup — a failure is a warning only -------------

  const warnings = [...ctx.warnings, ...evaluation.warnings]
  const cleaned = await deps.cleanup(ctx.current.change.workspace)
  if (cleaned.kind !== 'ok') {
    warnings.push(
      'workspace cleanup failed and was recorded as a warning; the verified Completed Ticket stands: ' +
        cleaned.reason,
    )
    return verified(ctx, params, record, warnings)
  }
  const markedDone = await deps.checkpoint.markCleanedUp()
  if (markedDone.kind !== 'ok') {
    warnings.push(
      "marking the completed ticket's cleanup bookkeeping failed and was recorded as a warning: " +
        markedDone.reason,
    )
  }
  return verified(ctx, params, record, warnings)
}

/**
 * The §11.3 reopen repair: a close made against stale specification,
 * membership, blocker, chronology, or target facts is undone — the Ticket is
 * reopened if it is currently closed — and the run ends
 * `blocked(changed-input)` with the partial shared writes recorded. An
 * unknown reopen result is a recoverable run-scoped error.
 */
async function repairAndBlock(
  deps: ShipCloseDeps,
  params: ShipCloseParams,
  ctx: CloseContext,
  ticketState: 'OPEN' | 'CLOSED' | undefined,
  evidence: readonly Evidence[],
): Promise<ShipCloseOutcome> {
  ctx.sharedWrite = 'confirmed'
  if (ticketState !== 'CLOSED') {
    return changedInput(ctx, evidence)
  }
  const reopened = await deps.writer.reopenIssue(locatorOf(params.ticket))
  if (reopened.kind !== 'ok') {
    return error({
      scope: 'run',
      code: 'issue-reopen',
      reason:
        `the stale close of ticket #${params.ticket.number} could not be repaired: the reopen ` +
        `returned an unknown result: ${reopened.reason}`,
      sharedWrite: 'unknown',
      evidence: [...reopened.evidence, ...evidence],
    })
  }
  return blocked({
    scope: 'run',
    code: 'changed-input',
    reason:
      'the post-close read found stale facts that would have prevented this Ship; the Ticket was reopened ' +
      'and the partial shared writes are recorded (design.md §11.3)',
    sharedWrite: 'confirmed',
    evidence: [
      ...evidence,
      { repair: 'reopened', partialDeliveryId: ctx.current.checkpoint.delivery.deliveryId },
    ],
  })
}

/**
 * Decide repair for a stabilization failure: a `blocked(changed-input)`
 * whose Ticket is known closed — or whose checkpoint already confirms the
 * close — follows the §11.3 reopen repair path; a still-open Ticket is left
 * untouched (no evidence write, no close, §11.3).
 */
async function maybeRepair(
  deps: ShipCloseDeps,
  params: ShipCloseParams,
  ctx: CloseContext,
  failure: StabilizeFailure,
): Promise<ShipCloseOutcome> {
  if (failure.failure.kind !== 'blocked') return failure.failure
  const closed =
    failure.ticketState === 'CLOSED' ||
    (failure.ticketState === undefined && ctx.current.checkpoint.stage === 'ticket-closed')
  if (!closed) return failure.failure
  return repairAndBlock(deps, params, ctx, failure.ticketState ?? 'CLOSED', [
    ...failure.failure.evidence,
  ])
}

/** The cleanup-only replay of a Completed Ticket with a retained workspace. */
async function retryCleanup(
  deps: ShipCloseDeps,
  params: ShipCloseParams,
  completed: LoadedCompletedTicket,
): Promise<ShipCloseOutcome> {
  const warnings: string[] = []
  const cleaned = await deps.cleanup(completed.cleanupWorkspace!)
  if (cleaned.kind !== 'ok') {
    warnings.push(
      'workspace cleanup failed and was recorded as a warning; the verified Completed Ticket stands: ' +
        cleaned.reason,
    )
    return ok({
      ticket: params.ticket,
      deliveryId: completed.deliveryId,
      integratedSha: completed.integratedSha,
      adoptedExtensions: [],
      warnings,
    })
  }
  const markedDone = await deps.checkpoint.markCleanedUp()
  if (markedDone.kind !== 'ok') {
    warnings.push(
      "marking the completed ticket's cleanup bookkeeping failed and was recorded as a warning: " +
        markedDone.reason,
    )
  }
  return ok({
    ticket: params.ticket,
    deliveryId: completed.deliveryId,
    integratedSha: completed.integratedSha,
    adoptedExtensions: [],
    warnings,
  })
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The evidence locator of one ticket reference. */
function locatorOf(ref: TicketRef): EvidenceIssueLocator {
  return { githubHost: ref.githubHost, number: ref.number, url: ref.url }
}

/** One complete evidence read of the shipped ticket (§14), or its failure. */
async function readTicketEvidence(
  deps: ShipCloseDeps,
  params: ShipCloseParams,
  ctx: CloseContext,
  stage: string,
): Promise<
  | { readonly read: IssueEvidenceRead }
  | { readonly failure: ShipCloseOutcome }
> {
  const read = await deps.readIssueEvidence(locatorOf(params.ticket))
  if (read.kind === 'error') {
    return {
      failure: closeFailure(ctx, 'evidence-read', read.reason, [
        { stage },
        ...read.evidence,
      ]),
    }
  }
  if (read.kind === 'blocked') {
    return {
      failure: changedInput(ctx, [
        { stage: 'evidence-read', code: read.code, reason: read.reason },
        ...read.evidence,
      ]),
    }
  }
  return { read: read.value }
}

/** Fetch the target and read its current tip SHA (§11.1, §14). */
async function fetchedTargetSha(
  deps: ShipCloseDeps,
  params: ShipCloseParams,
  ctx: CloseContext,
): Promise<{ readonly sha: string } | { readonly failure: ShipCloseOutcome }> {
  const fetched = await deps.facts.fetchTarget(params.targetBranch)
  if (fetched.kind !== 'ok') {
    return { failure: targetReadFailure(ctx, fetched.reason, [...fetched.evidence]) }
  }
  const sha = await deps.facts.targetSha(params.targetBranch)
  if (sha.kind !== 'ok') {
    return { failure: targetReadFailure(ctx, sha.reason, [...sha.evidence]) }
  }
  return { sha: sha.value }
}

function targetReadFailure(
  ctx: CloseContext,
  reason: string,
  evidence: readonly Evidence[],
): ShipCloseOutcome {
  return error({
    scope: 'run',
    code: 'target-read',
    reason: `reading the remote target failed: ${reason}`,
    // A target-read failure after confirmed writes is recoverable, never
    // terminal (§9, §13.2); before any write the ctx state is 'none'.
    sharedWrite: ctx.sharedWrite,
    evidence: [...evidence],
  })
}

/** The findings array of a non-completed evaluation, always serializable. */
function findingsOf(
  evaluation: Exclude<
    Awaited<ReturnType<typeof evaluateDeliveryEvidence>>,
    { status: 'completed' } | { status: 'error' }
  >,
): readonly DeliveryEvidenceFinding[] {
  return evaluation.status === 'no-record' ? [] : [...evaluation.findings]
}

function verified(
  ctx: CloseContext,
  params: ShipCloseParams,
  record: { readonly anchor: string; readonly written: boolean },
  warnings: readonly string[],
): ShipCloseOutcome {
  return ok({
    ticket: params.ticket,
    deliveryId: ctx.current.checkpoint.delivery.deliveryId,
    integratedSha: ctx.current.checkpoint.integratedSha,
    anchorCommentId: record.anchor,
    commentWritten: record.written,
    adoptedExtensions: [...ctx.adopted],
    // The write-or-reuse scan and the §14 evaluation may both report the
    // same duplicate warning; a Completed Ticket reports it once.
    warnings: [...new Set(warnings)],
  })
}

/** The run-scoped `blocked(changed-input)` of §11.3. */
function changedInput(ctx: CloseContext, evidence: readonly Evidence[]): ShipCloseOutcome {
  return blocked({
    scope: 'run',
    code: 'changed-input',
    reason:
      'the trustworthy facts this close depends on changed; the partial shared writes are recorded ' +
      'exactly as established so far (design.md §11.3)',
    sharedWrite: ctx.sharedWrite,
    evidence: [...evidence],
  })
}

function closeFailure(
  ctx: CloseContext,
  code: ShipCloseErrorCode,
  reason: string,
  evidence: readonly Evidence[],
): ShipCloseOutcome {
  return error({ scope: 'run', code, reason, sharedWrite: ctx.sharedWrite, evidence: [...evidence] })
}

function closeError(
  code: ShipCloseErrorCode,
  reason: string,
  evidence: readonly Evidence[],
  sharedWrite: 'none' | 'confirmed' | 'unknown' = 'none',
): ShipCloseOutcome {
  return error({ scope: 'run', code, reason, sharedWrite, evidence: [...evidence] })
}

/**
 * A control-store failure after remotely confirmed writes is an error
 * following a confirmed shared write — recoverable, never terminal (§9).
 */
function storeFailure(
  ctx: CloseContext,
  what: string,
  failure: Outcome<never, never, ShipStoreErrorCode>,
): ShipCloseOutcome {
  if (failure.kind === 'ok') return failure
  return error({
    scope: 'run',
    code: failure.code,
    reason: `${what} failed: ${failure.reason}`,
    sharedWrite: 'confirmed',
    evidence: [...failure.evidence],
  })
}

/** An entry-state load failure leaves the shared-write state unprovable. */
function entryLoadFailure(failure: Outcome<never, never, ShipStoreErrorCode>): ShipCloseOutcome {
  if (failure.kind === 'ok') return failure
  return error({
    scope: 'run',
    code: failure.code,
    reason: `loading the shipping checkpoint failed: ${failure.reason}`,
    sharedWrite: 'unknown',
    evidence: [...failure.evidence],
  })
}
