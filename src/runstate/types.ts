/**
 * The persisted Run State vocabulary (design.md §13.1).
 *
 * V1 uses one versioned `RunState` document per active map holding the
 * complete checkpoint vocabulary: the accepted Map revision lineage, Wave
 * state, the Ticket phase union, Ship and map-completion checkpoints, owned
 * process groups, and the terminal RunReport. The referenced payload types —
 * stable issue references (§7.3), Work inputs and workspaces (§10.1),
 * tree-bound evidence and records (§10.3, §14, §15) — are defined here so the
 * document is self-contained: every recovery-critical fact the coordinator
 * persists has exactly one type.
 *
 * Pure types only. Validation, persistence, and integrity checks live in
 * `run-state-store.ts`.
 */
import type { Evidence } from '../core/outcome.ts'
import type { Sha256Digest } from '../core/digest.ts'
import type { GitObjectOid } from '../agents/completion.ts'
import type { MapRevisionPayload } from '../core/revision.ts'

export const RUN_STATE_SCHEMA = 'norn-run-state:v1' as const

/** A stable issue reference: immutable identity plus mutable locators (§7.3). */
export type StableIssueRef<Role extends 'map' | 'ticket'> = {
  readonly role: Role
  /** Lowercase ASCII host with the default HTTPS port omitted. */
  readonly githubHost: string
  /** Opaque GitHub repository node ID, preserved exactly. */
  readonly repositoryId: string
  /** Opaque GitHub issue node ID, preserved exactly. */
  readonly issueId: string
  /** Display locator and per-run Ship sort key; never identity. */
  readonly number: number
  readonly url: string
}

export type MapRef = StableIssueRef<'map'>
export type TicketRef = StableIssueRef<'ticket'>

/** The immutable Work input captured during Wave planning (§10.1). */
export type EffectiveTicketSpec = {
  readonly mapTitle: string
  readonly mapBody: string
  readonly mapRevision: string
  readonly ticketTitle: string
  readonly ticketBody: string
  readonly ticketRevision: string
}

export type WorkInput = {
  readonly ticket: TicketRef
  readonly spec: EffectiveTicketSpec
  readonly target: {
    readonly branch: string
    readonly baseSha: string
    readonly baseTreeOid: string
  }
}

/** One run-owned Git workspace, qualified by run and attempt (§10.1). */
export type WorkspaceRef =
  | {
      readonly kind: 'ticket'
      readonly repositoryId: string
      readonly runId: string
      readonly path: string
      readonly branch: string
      readonly workAttemptId: string
    }
  | {
      readonly kind: 'map-completion'
      readonly repositoryId: string
      readonly runId: string
      readonly path: string
      readonly completionAttemptId: string
    }

/** One successful configured test command bound to an exact tree (§10.3). */
export type TestEvidence = {
  readonly phase: 'work' | 'ship' | 'map-completion'
  readonly testIndex: number
  readonly argv: readonly string[]
  readonly timeoutMs: number
  readonly baseSha: string
  readonly treeOid: string
  readonly exitCode: 0
  readonly outputDigest: string
}

/** A passing independent review bound to exact revisions, base, and tree (§10.3). */
export type ReviewEvidence = {
  readonly phase: 'work' | 'ship'
  readonly provider: string
  readonly model: string
  readonly family: string
  readonly thinking: string
  readonly verdict: 'pass'
  readonly mapRevision: string
  readonly ticketRevision: string
  readonly baseSha: string
  readonly treeOid: string
  readonly testEvidenceDigest: string
}

/** A passing map-completion review (§10.3). */
export type MapCompletionReviewEvidence = {
  readonly phase: 'map-completion'
  readonly provider: string
  readonly model: string
  readonly family: string
  readonly thinking: string
  readonly verdict: 'pass'
  readonly mapRevision: string
  readonly completionSha: string
  readonly treeOid: string
  readonly testEvidenceDigest: string
}

/** A tested and reviewed candidate tree that has not yet entered the target (§10.3). */
export type ShippableChange = {
  readonly ticket: TicketRef
  readonly mapRevision: string
  readonly ticketRevision: string
  readonly baseSha: string
  readonly candidateCommit: string
  readonly candidateTreeOid: string
  readonly workspace: WorkspaceRef
  readonly tests: readonly TestEvidence[]
  readonly review: ReviewEvidence
}

/** The sealed execution gate a remote record was produced under (§14). */
export type EvidenceGateV1 = {
  readonly worker: {
    readonly provider: string
    readonly model: string
    readonly family: string
    readonly thinking: string
  }
  readonly reviewer: {
    readonly provider: string
    readonly model: string
    readonly family: string
    readonly thinking: string
  }
  readonly tests: ReadonlyArray<{
    readonly argv: readonly string[]
    readonly timeoutMs: number
  }>
}

/** The machine comment sealing one Ticket delivery (§14). */
export type DeliveryRecordV1 = {
  readonly schema: 'norn-delivery:v1'
  readonly deliveryId: string
  readonly run: {
    readonly id: string
    readonly configRevision: string
    readonly nornVersion: string
  }
  readonly gate: EvidenceGateV1
  readonly map: {
    readonly issueId: string
    readonly revision: string
  }
  readonly ticket: {
    readonly issueId: string
    readonly revision: string
  }
  readonly target: {
    readonly repositoryId: string
    readonly branch: string
    readonly baseSha: string
    readonly integratedSha: string
    readonly treeOid: string
  }
  readonly review: ReviewEvidence
  readonly tests: readonly TestEvidence[]
  readonly actorId: string
  readonly recordedAt: string
}

/** The machine comment sealing one verified Map completion (§15). */
export type MapCompletionRecordV1 = {
  readonly schema: 'norn-map-completion:v1'
  readonly completionId: string
  readonly run: {
    readonly id: string
    readonly completionAttemptId: string
    readonly configRevision: string
    readonly nornVersion: string
  }
  readonly gate: EvidenceGateV1
  readonly map: {
    readonly issueId: string
    readonly revision: string
    readonly closingEventId: string
  }
  readonly target: {
    readonly repositoryId: string
    readonly branch: string
    readonly completionSha: string
    readonly treeOid: string
  }
  readonly review: MapCompletionReviewEvidence
  readonly tests: readonly TestEvidence[]
  readonly actorId: string
  readonly recordedAt: string
}

/** One accepted snapshot in the run's Map revision lineage (§7.4, §13.1). */
export type AcceptedMapRevision = {
  readonly revision: Sha256Digest
  readonly payload: MapRevisionPayload
  readonly extension?: {
    readonly fromRevision: Sha256Digest
    readonly addedTicketIssueIds: readonly string[]
  }
}

/** The write-ahead record of one owned child process group (§13.1, §16, §17). */
export type ProcessGroupCheckpoint = {
  readonly id: string
  readonly owner: 'worker' | 'reviewer' | 'command'
  readonly phase: 'work' | 'ship' | 'map-completion'
  readonly workspace: WorkspaceRef
  readonly ticketIssueId?: string
  readonly workAttemptId?: string
  readonly adapterHandle: string
  readonly state: 'launch-intent' | 'running' | 'settled'
}

/**
 * One structured feedback entry accumulated across a Work attempt's rounds
 * (§10.2, §13.1). Feedback only: it informs later worker rounds — including
 * a later attempt for the same Ticket, in this run or a later one — and is
 * never evidence. Command failures, reviewer iterate prose, an in-run Ship
 * conflict, and a park's terminal entry are the only payloads that travel.
 */
export type ReworkFeedback =
  | {
      readonly kind: 'setup'
      /** Round the failure belongs to; 0 marks the attempt's initial setup. */
      readonly round: number
      readonly origin: 'initial' | 'candidate'
      readonly argv: readonly string[]
      readonly cause: 'non-zero-exit' | 'timeout-terminated'
      readonly exitCode: number | null
      readonly stdout: string
      readonly stderr: string
    }
  | {
      readonly kind: 'tests'
      readonly round: number
      readonly testIndex: number
      readonly argv: readonly string[]
      readonly cause: 'non-zero-exit' | 'timeout-terminated'
      readonly exitCode: number | null
      readonly stdout: string
      readonly stderr: string
    }
  | {
      readonly kind: 'review'
      readonly round: number
      readonly feedback: string
    }
  | {
      /**
       * The Ship conflict that re-queued this Ticket for fresh Work (§12),
       * carried into the rework attempt's first round.
       */
      readonly kind: 'conflict'
      readonly round: number
      readonly code: string
      readonly reason: string
      readonly evidence: readonly Evidence[]
    }
  | {
      /** How the parked attempt ended; the terminal entry of its feedback. */
      readonly kind: 'terminal'
      readonly outcome: 'blocked' | 'error'
      readonly code: string
      readonly reason: string
    }

/** The persisted `awaiting-reservation → reserved` slot handshake (§13.1, §16). */
export type WorkAttemptCheckpoint = {
  readonly workAttemptId: string
  readonly input: WorkInput
  readonly branch: string
  readonly workspace: WorkspaceRef
  readonly round: number
  readonly slot: 'awaiting-reservation' | 'reserved' | 'released'
  readonly processGroupIds: readonly string[]
  /**
   * Feedback accumulated so far, in order. Optional on load so a document
   * written before this vocabulary existed still resumes; it can never be
   * reconstructed from a workspace or from earlier evidence.
   */
  readonly feedback?: readonly ReworkFeedback[]
}

/**
 * The in-run conflict rework of one Ticket (§12).
 *
 * A Ticket whose Ship returned `integration-conflict` is re-queued for fresh
 * Work in a later Wave of the same run instead of parking. `cycles` counts
 * the rework attempts already granted, bounded by `maxWorkRounds`; `conflict`
 * is the Ship conflict the pending rework must resolve. The conflict is
 * worker feedback, never evidence.
 */
export type TicketRework = {
  readonly cycles: number
  readonly conflict: {
    readonly code: string
    readonly reason: string
    readonly evidence: readonly Evidence[]
  }
}

/** The exact persisted Wave queue, preserving issue-number Ship order (§12, §13.1). */
export type WaveState = {
  readonly number: number
  readonly mapRevision: string
  readonly target: { readonly branch: string; readonly baseSha: string; readonly baseTreeOid: string }
  readonly frontierTicketIssueIds: readonly string[]
  readonly shipQueueTicketIssueIds: readonly string[]
  readonly nextShipIndex: number
}

/** The complete write-ahead intent before one push (§11, §13.1). */
export type ShipCheckpoint = {
  readonly stage: 'prepared' | 'push-verified' | 'delivery-recorded' | 'ticket-closed'
  readonly pushAttempts: number
  readonly zeroDelta: boolean
  readonly baseSha: string
  readonly integratedSha: string
  readonly treeOid: string
  readonly tests: readonly TestEvidence[]
  readonly review: ReviewEvidence
  readonly delivery: DeliveryRecordV1
}

/** The discriminated Ticket phase union (§13.1). */
export type TicketRunState =
  | {
      readonly phase: 'waiting'
      readonly wave?: number
      /**
       * Terminal feedback of the previous run's parked attempt, carried into
       * this run's first Work round (§10.2). Present only when the previous
       * run parked this Ticket with feedback; read from persisted Run State.
       */
      readonly carriedFeedback?: readonly ReworkFeedback[]
    }
  | { readonly phase: 'working'; readonly wave: number; readonly attempt: WorkAttemptCheckpoint }
  | {
      readonly phase: 'parked'
      readonly wave: number
      readonly workspace?: WorkspaceRef
      /** The attempt's accumulated feedback plus its terminal entry (§10.2). */
      readonly feedback?: readonly ReworkFeedback[]
      readonly outcome: {
        readonly kind: 'blocked' | 'error'
        readonly code: string
        readonly reason: string
        readonly evidence: readonly Evidence[]
      }
    }
  | { readonly phase: 'shippable'; readonly wave: number; readonly change: ShippableChange }
  | {
      readonly phase: 'shipping'
      readonly wave: number
      readonly change: ShippableChange
      readonly checkpoint: ShipCheckpoint
    }
  | {
      readonly phase: 'completed'
      readonly deliveryId: string
      readonly integratedSha: string
      readonly cleanupWorkspace?: WorkspaceRef
    }

/**
 * The exact timeline boundary captured before Map close (§13.4, §15).
 * A real head event ID is relocatable directly. When GitHub omits the head
 * item's ID, the complete prefix length and digest form a synthetic anchor.
 */
export type TimelineAnchor =
  | { readonly kind: 'event-id'; readonly eventId: string }
  | {
      readonly kind: 'prefix'
      readonly timelineLength: number
      readonly prefixDigest: Sha256Digest
    }

/** The map-completion write-ahead checkpoint (§13.1, §15). */
export type MapCompletionCheckpoint = {
  readonly stage: 'gated' | 'map-closed' | 'recorded'
  readonly completionAttemptId: string
  readonly timelineAnchor: TimelineAnchor
  readonly workspace: WorkspaceRef
  readonly mapRevision: string
  readonly completionSha: string
  readonly treeOid: string
  readonly gate: EvidenceGateV1
  readonly tests: readonly TestEvidence[]
  readonly review: MapCompletionReviewEvidence
  readonly closingEventId?: string
  readonly record?: MapCompletionRecordV1
}

/** The terminal report of a run (§13.1). */
export type RunReport = {
  readonly label: 'passed' | 'blocked' | 'error'
  readonly code?: string
  readonly runId: string
  readonly initialMapRevision: string
  readonly finalMapRevision: string
  readonly acceptedExtensions: ReadonlyArray<{
    readonly revision: string
    readonly addedTicketIssueIds: readonly string[]
  }>
  readonly tickets: ReadonlyArray<{
    readonly ticket: TicketRef
    readonly state: 'completed' | 'parked' | 'waiting'
    readonly code?: string
  }>
  readonly sharedWrite: 'none' | 'confirmed'
  readonly completionSha?: string
  readonly warnings: readonly string[]
  readonly retainedWorkspace?: WorkspaceRef
}

/** One versioned Run State document per active map (§13.1). */
export type RunState = {
  readonly schema: typeof RUN_STATE_SCHEMA
  readonly runId: string
  readonly map: MapRef
  readonly acceptedMapRevisions: readonly AcceptedMapRevision[]
  readonly configRevision: Sha256Digest
  readonly nornVersion: string
  readonly status: 'running' | 'terminal' | 'aborted'
  readonly wave: number
  readonly activeWave?: WaveState
  readonly parkedTickets: readonly TicketRef[]
  readonly tickets: Readonly<Record<string, TicketRunState>>
  /**
   * The in-run conflict rework ledger (§12, §13.1): one entry per Ticket
   * that has been re-queued for fresh Work in this run.
   */
  readonly reworks?: Readonly<Record<string, TicketRework>>
  readonly activeProcesses: readonly ProcessGroupCheckpoint[]
  readonly mapCompletion?: MapCompletionCheckpoint
  readonly report?: RunReport
}
