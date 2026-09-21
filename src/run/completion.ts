/**
 * Map completion (design.md §15, §13.4 — ticket #14).
 *
 * Proving the whole map. Entered only when every member is a valid Completed
 * Ticket, the protocol is:
 *
 * ```text
 * allocate a unique completion attempt; read completionSha from the target
 *     ↓
 * check out exactly that commit in a clean run-owned map-completion
 * workspace carrying the attempt ID (§10.2 substrate)
 *     ↓
 * run setup and the complete test list with the §10.2 post-command checks,
 * recording baseSha = completionSha
 *     ↓
 * run one fresh read-only review of the complete normalized Task Map
 * snapshot plus the ordered completion-test evidence; re-verify the commit,
 * tree, and cleanliness (§15 steps 3–5)
 *     ↓
 * acquire the target lock — held through step 11 for the unchanged case:
 *     re-read the stable Map, every member's Completed Ticket evidence, and
 *     the remote target; a Compatible Map Extension follows the §11.3
 *     release-adopt-reacquire dance and returns to planning or restarts
 *     completion (the prior gates are discarded); target movement restarts
 *     completion (§15 step 7)
 *     ↓
 * unchanged: capture the timeline anchor, persist the `gated`
 * MapCompletionCheckpoint, and close the still-open Map (§15 step 8)
 *     ↓
 * while still holding the lock: re-read the stable Map, all member
 * completion predicates, the remote target, and the current Map closing
 * event; stale facts repair the close — reopen while holding the lock — and
 * the record of that repaired attempt is historical (§15 step 9)
 *     ↓
 * seal and write or reuse the `norn-map-completion:v1` record bound to that
 * closing event — the comment is written AFTER the close event, as the
 * remote finalization marker recovery can distinguish (§15 step 10)
 *     ↓
 * re-read the marked comment, stable Map, and remote target; terminal
 * completion is recorded only when the record validates, the Map remains
 * CLOSED at the checkpoint revision, and the target still contains
 * completionSha — descendant-only advancement after the record is allowed
 * (§15 step 11)
 * ```
 *
 * `completeMap` is an orchestration over the five seams the earlier tickets
 * built: the map stable read and §7.4 classifier (`src/map/`), the
 * issue-evidence and issue-write gateway seams (`src/evidence/`,
 * `src/adapters/github-gateway`), the Git delivery facts, the workspace and
 * §10.2 command gate (`src/work/`), agent settlement (`src/agents/`), the
 * target lock and the Run-State checkpoint store (`src/ship/`,
 * `src/runstate/`). A persisted `MapCompletionCheckpoint` routes through the
 * §13.4 recovery reconciliation before anything else: recovery distinguishes
 * a close whose post-check finished (a valid current completion record) from
 * one that did not, repairs stale closes, and never guesses from the
 * checkpoint stage alone.
 */
import { existsSync } from 'node:fs'

import { blocked, error, ok } from '../core/outcome.ts'
import type {
  Evidence,
  Outcome,
  OutcomeBlocked,
  OutcomeError,
} from '../core/outcome.ts'
import { canonicalJson } from '../core/canonical-json.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'
import { canonicalJsonDigest, isSha256Digest } from '../core/digest.ts'
import type { Sha256Digest } from '../core/digest.ts'
import type { GitHubIssueWriter } from '../adapters/github-gateway.ts'
import type { GitCommandRunner } from '../adapters/git-repository.ts'
import { AGENT_COMPLETION_SCHEMA, GIT_OBJECT_OID_PATTERN, agentRecordedAt } from '../agents/completion.ts'
import type {
  AgentCompletionContext,
  GitObjectOid,
  ReviewerCompletion,
} from '../agents/completion.ts'
import { planAgentPiArgv } from '../agents/herdr-runner.ts'
import { runAgentInvocation } from '../agents/runner.ts'
import type { AgentSettlementErrorCode, VisibleAgentRunner } from '../agents/runner.ts'
import type { RunConfigAgentRole, RunConfigCommand } from '../config/run-config.ts'
import { evaluateDeliveryEvidence, NORN_TIMESTAMP_PATTERN } from '../evidence/delivery.ts'
import type {
  DeliveryEvidenceFinding,
  DeliveryFactsErrorCode,
  DeliveryTargetFacts,
} from '../evidence/delivery.ts'
import { formatRecordEnvelope, parseRecordEnvelope } from '../evidence/envelope.ts'
import type {
  EvidenceIssueLocator,
  IssueEvidenceRead,
  IssueEvidenceReader,
  IssueTimelineEvent,
} from '../evidence/read.ts'
import { classifyMapChange } from '../map/map-extension.ts'
import type { MapRef, TaskMapSnapshot } from '../map/snapshot.ts'
import type { StableSnapshotOutcome } from '../map/stable-read.ts'
import { loadRunState, saveRunState } from '../runstate/run-state-store.ts'
import type {
  AcceptedMapRevision,
  EvidenceGateV1,
  MapCompletionCheckpoint,
  MapCompletionRecordV1,
  MapCompletionReviewEvidence,
  ProcessGroupCheckpoint,
  RunState,
  TestEvidence,
  WorkspaceRef,
} from '../runstate/types.ts'
import type { ShipTargetLock, ShipTargetLockHandle } from '../ship/push.ts'
import type { ShipExtensionAdoption, ShipFacts } from '../ship/reconcile.ts'
import { acceptedSnapshotFrom, snapshotMapPayload } from '../ship/reconcile.ts'
import type { AgentLaunchPlan, ReviewerTestOutput } from '../work/round-gate.ts'
import { REVIEWER_READ_ONLY_TOOLS, isReadOnlyAgentArgv, modelProvider } from '../work/round-gate.ts'
import type { CommandRunner } from '../work/command-runner.ts'
import type { GateCommandErrorCode, GateCommandListValue, GateDeps } from '../work/gate.ts'
import { runGateCommandList } from '../work/gate.ts'
import { mapCompletionWorkspaceDir } from '../work/naming.ts'
import { createMapCompletionWorkspace, inspectWorkspace } from '../work/workspace.ts'
import type { WorkspaceErrorCode } from '../work/workspace.ts'

// ---------------------------------------------------------------------------
// Outcome vocabulary (§9, §15)
// ---------------------------------------------------------------------------

/**
 * The two block codes of map completion: the §15 machine gate on setup,
 * tests, and review (`map-completion-gate-failed` — the Map remains open
 * with findings), and trustworthy facts the completion depends on changing
 * (`changed-input`). Both are run-scoped.
 */
export type MapCompletionBlockCode = 'map-completion-gate-failed' | 'changed-input'

/** Closed error codes of the completion protocol; all run-scoped (§9). */
export type MapCompletionErrorCode =
  | 'map-read'
  | 'target-read'
  | 'evidence-read'
  | 'issue-close'
  | 'issue-reopen'
  | 'comment-write'
  | 'control-store'
  | 'state-integrity'
  | 'lock-failed'
  | 'reviewer-not-read-only'
  | AgentSettlementErrorCode
  | GateCommandErrorCode
  | WorkspaceErrorCode

/** One Compatible Map Extension adopted during completion (§7.4, §15). */
export type MapCompletionAdoption = {
  readonly revision: string
  readonly fromRevision: string
  readonly addedTicketIssueIds: readonly string[]
}

/** The `ok` value: terminal completion, or a return to Wave planning (§15). */
export type MapCompletionResult =
  | {
      /** Every §15 predicate held: the run is terminally `passed`. */
      readonly kind: 'completed'
      readonly completionSha: string
      readonly closingEventId: string
      readonly completionId: string
      readonly record: MapCompletionRecordV1
      /** Whether this invocation wrote the record comment (false = reused). */
      readonly commentWritten: boolean
      readonly warnings: readonly string[]
      readonly adoptedExtensions: readonly MapCompletionAdoption[]
      /** The run-owned completion workspace, for terminal cleanup (§15). */
      readonly workspace: WorkspaceRef
    }
  | {
      /**
       * A Compatible Map Extension was adopted and at least one added Ticket
       * is not a valid Completed Ticket: execution returns to Wave planning
       * (§15 step 7); a fresh completion check follows eventually.
       */
      readonly kind: 'replan'
      readonly adoptedExtensions: readonly MapCompletionAdoption[]
    }

export type MapCompletionOutcome = Outcome<
  MapCompletionResult,
  MapCompletionBlockCode,
  MapCompletionErrorCode
>

// ---------------------------------------------------------------------------
// The completion record schema and its §15 predicate
// ---------------------------------------------------------------------------

export const MAP_COMPLETION_RECORD_SCHEMA = 'norn-map-completion:v1' as const

/**
 * `completionId` is SHA-256 over RFC 8785 canonical JSON of the complete
 * record except `completionId` (§15). The sealed record persists verbatim in
 * the checkpoint before the first comment attempt and every replay reuses it.
 */
export function computeCompletionId(
  record: Omit<MapCompletionRecordV1, 'completionId'>,
): Sha256Digest {
  return canonicalJsonDigest(record as unknown as CanonicalJsonValue)
}

/** Recompute the sealed ID from a parsed record value; `undefined` when unhashable. */
function recomputeCompletionId(value: CanonicalJsonValue): Sha256Digest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const rest: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  delete rest.completionId
  try {
    return canonicalJsonDigest(rest as CanonicalJsonValue)
  } catch {
    return undefined
  }
}

type Unknown = Record<string, unknown>

function isPlainObject(value: unknown): value is Unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value !== ''
}

function checkObjectOid(value: unknown, where: string, problems: string[]): void {
  if (typeof value !== 'string' || !GIT_OBJECT_OID_PATTERN.test(value)) {
    problems.push(`${where} must be an object-format Git OID`)
  }
}

function checkDigest(value: unknown, where: string, problems: string[]): void {
  if (!isSha256Digest(value)) problems.push(`${where} must be a sha256:<hex> digest`)
}

function checkGateStructure(gate: unknown, where: string, problems: string[]): void {
  if (!isPlainObject(gate)) {
    problems.push(`${where} must be an evidence gate object`)
    return
  }
  for (const role of ['worker', 'reviewer'] as const) {
    const entry = gate[role]
    if (!isPlainObject(entry)) {
      problems.push(`${where}.${role} must be an agent role object`)
      continue
    }
    for (const field of ['provider', 'model', 'family', 'thinking'] as const) {
      if (!nonEmptyString(entry[field])) {
        problems.push(`${where}.${role}.${field} must be a non-empty string`)
      }
    }
  }
  const tests = gate.tests
  if (!Array.isArray(tests) || tests.length === 0) {
    problems.push(`${where}.tests must be a non-empty array of command entries`)
    return
  }
  tests.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      problems.push(`${where}.tests[${index}] must be an object`)
      return
    }
    const argv = entry.argv
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every(nonEmptyString)) {
      problems.push(`${where}.tests[${index}].argv must be a non-empty array of non-empty strings`)
    }
    if (
      typeof entry.timeoutMs !== 'number' ||
      !Number.isFinite(entry.timeoutMs) ||
      entry.timeoutMs <= 0
    ) {
      problems.push(`${where}.tests[${index}].timeoutMs must be a number greater than 0`)
    }
  })
}

function checkCompletionReviewStructure(review: unknown, where: string, problems: string[]): void {
  if (!isPlainObject(review)) {
    problems.push(`${where} must be a map-completion review evidence object`)
    return
  }
  if (review.phase !== 'map-completion') problems.push(`${where}.phase must be "map-completion"`)
  for (const field of ['provider', 'model', 'family', 'thinking'] as const) {
    if (!nonEmptyString(review[field])) problems.push(`${where}.${field} must be a non-empty string`)
  }
  if (review.verdict !== 'pass') problems.push(`${where}.verdict must be "pass"`)
  checkDigest(review.mapRevision, `${where}.mapRevision`, problems)
  checkObjectOid(review.completionSha, `${where}.completionSha`, problems)
  checkObjectOid(review.treeOid, `${where}.treeOid`, problems)
  checkDigest(review.testEvidenceDigest, `${where}.testEvidenceDigest`, problems)
}

/**
 * Structural problems of one parsed value against the `MapCompletionRecordV1`
 * schema of §15. An empty list means the value is a well-formed record;
 * predicate-level binding checks are separate findings.
 */
export function mapCompletionRecordProblems(value: unknown): readonly string[] {
  const problems: string[] = []
  if (!isPlainObject(value)) return ['the record must be a JSON object']

  if (value.schema !== MAP_COMPLETION_RECORD_SCHEMA) {
    problems.push(`schema must be "${MAP_COMPLETION_RECORD_SCHEMA}"`)
  }
  if (!isSha256Digest(value.completionId)) {
    problems.push('completionId must be a sha256:<hex> digest')
  }

  const run = value.run
  if (isPlainObject(run)) {
    if (!nonEmptyString(run.id)) problems.push('run.id must be a non-empty string')
    if (!nonEmptyString(run.completionAttemptId)) {
      problems.push('run.completionAttemptId must be a non-empty string')
    }
    checkDigest(run.configRevision, 'run.configRevision', problems)
    if (!nonEmptyString(run.nornVersion)) problems.push('run.nornVersion must be a non-empty string')
  } else {
    problems.push('run must be an object')
  }

  checkGateStructure(value.gate, 'gate', problems)

  const map = value.map
  if (isPlainObject(map)) {
    if (!nonEmptyString(map.issueId)) problems.push('map.issueId must be a non-empty string')
    checkDigest(map.revision, 'map.revision', problems)
    if (!nonEmptyString(map.closingEventId)) {
      problems.push('map.closingEventId must be a non-empty string')
    }
  } else {
    problems.push('map must be an object')
  }

  const target = value.target
  if (isPlainObject(target)) {
    if (!nonEmptyString(target.repositoryId)) {
      problems.push('target.repositoryId must be a non-empty string')
    }
    if (!nonEmptyString(target.branch)) problems.push('target.branch must be a non-empty string')
    checkObjectOid(target.completionSha, 'target.completionSha', problems)
    checkObjectOid(target.treeOid, 'target.treeOid', problems)
  } else {
    problems.push('target must be an object')
  }

  checkCompletionReviewStructure(value.review, 'review', problems)

  const tests = value.tests
  if (!Array.isArray(tests) || tests.length === 0) {
    problems.push('tests must be a non-empty array of test evidence')
  } else {
    tests.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        problems.push(`tests[${index}] must be an object`)
        return
      }
      if (entry.phase !== 'map-completion') {
        problems.push(`tests[${index}].phase must be "map-completion"`)
      }
      if (entry.exitCode !== 0) problems.push(`tests[${index}].exitCode must be 0`)
      checkObjectOid(entry.baseSha, `tests[${index}].baseSha`, problems)
      checkObjectOid(entry.treeOid, `tests[${index}].treeOid`, problems)
      checkDigest(entry.outputDigest, `tests[${index}].outputDigest`, problems)
    })
  }

  if (!nonEmptyString(value.actorId)) problems.push('actorId must be a non-empty string')
  if (typeof value.recordedAt !== 'string' || !NORN_TIMESTAMP_PATTERN.test(value.recordedAt)) {
    problems.push('recordedAt must be a UTC RFC 3339 timestamp with three fractional-second digits')
  }
  return problems
}

// ---------------------------------------------------------------------------
// Timeline helpers (§13.4, §15 chronology)
// ---------------------------------------------------------------------------

type ClosedEvent = IssueTimelineEvent & { readonly kind: 'closed' }

/** The current closing event: the last close no reopen follows, or `undefined`. */
export function currentClosingEvent(timeline: readonly IssueTimelineEvent[]): ClosedEvent | undefined {
  let closing: ClosedEvent | undefined
  timeline.forEach((event) => {
    if (event.kind === 'closed') closing = event
    if (event.kind === 'reopened') closing = undefined
  })
  return closing
}

/** Whether a close followed by a reopen occurred after the anchor event. */
export function closeThenReopenAfter(
  timeline: readonly IssueTimelineEvent[],
  anchorEventId: string | null,
): boolean {
  const anchorIndex =
    anchorEventId === null
      ? -1
      : timeline.findIndex((event) => event.eventId === anchorEventId)
  if (anchorEventId !== null && anchorIndex === -1) return true // the anchor is gone: never guess
  let state: 'open' | 'closed' = 'open'
  let closeThenReopen = false
  timeline.forEach((event, index) => {
    if (index <= anchorIndex) return
    if (event.kind === 'closed') state = 'closed'
    if (event.kind === 'reopened') {
      if (state === 'closed') closeThenReopen = true
      state = 'open'
    }
  })
  return closeThenReopen
}

/**
 * The §13.4 close-window binding: the current closing event is the
 * authenticated actor's first close after the anchor and no reopen follows
 * it. Returns the binding verdict plus, when bound, the closing event ID.
 */
export type ClosingEventBinding =
  | { readonly bound: true; readonly closingEventId: string }
  | {
      readonly bound: false
      readonly reason: 'no-closing-event' | 'reopen-follows' | 'not-first-close-after-anchor' | 'foreign-actor'
    }

export function closingEventBinding(
  timeline: readonly IssueTimelineEvent[],
  anchorEventId: string | null,
  actorId: string,
): ClosingEventBinding {
  const anchorIndex =
    anchorEventId === null ? -1 : timeline.findIndex((event) => event.eventId === anchorEventId)
  if (anchorEventId !== null && anchorIndex === -1) {
    return { bound: false, reason: 'not-first-close-after-anchor' }
  }
  const closing = currentClosingEvent(timeline)
  if (closing === undefined) return { bound: false, reason: 'no-closing-event' }
  const firstCloseAfterAnchor = timeline.find(
    (event, index) => index > anchorIndex && event.kind === 'closed',
  )
  if (firstCloseAfterAnchor === undefined || firstCloseAfterAnchor.eventId !== closing.eventId) {
    return { bound: false, reason: 'not-first-close-after-anchor' }
  }
  if (closing.actorId !== actorId) return { bound: false, reason: 'foreign-actor' }
  return { bound: true, closingEventId: closing.eventId }
}

// ---------------------------------------------------------------------------
// The §15 current-record predicate
// ---------------------------------------------------------------------------

/** One independently discoverable violation of the §15 record predicate. */
export type MapCompletionFinding =
  | { readonly code: 'invalid-envelope'; readonly commentId: string; readonly reason: string }
  | { readonly code: 'invalid-record'; readonly commentId: string; readonly problems: readonly string[] }
  | { readonly code: 'completion-id-mismatch'; readonly commentId: string }
  | {
      readonly code: 'divergent-duplicate'
      readonly completionId: string
      readonly commentIds: readonly string[]
    }
  | { readonly code: 'map-open' }
  | { readonly code: 'missing-closing-event' }
  | {
      readonly code: 'wrong-closing-event'
      readonly recordClosingEventId: string
      readonly currentClosingEventId: string
    }
  | { readonly code: 'record-not-in-timeline'; readonly commentId: string }
  | { readonly code: 'record-before-close'; readonly commentId: string; readonly closingEventId: string }
  | { readonly code: 'closing-actor-mismatch'; readonly closingActorId: string | null; readonly actorId: string }
  | { readonly code: 'author-mismatch'; readonly commentAuthorId: string | null; readonly actorId: string }
  | { readonly code: 'untrusted-author'; readonly actorId: string }
  | {
      readonly code: 'identity-mismatch'
      readonly detail: 'map' | 'repository' | 'branch' | 'revision'
      readonly expected: string
      readonly recorded: string
    }
  | {
      readonly code: 'member-not-completed'
      readonly ticketIssueId: string
      readonly findings: readonly DeliveryEvidenceFinding[]
    }
  | { readonly code: 'invalid-gate'; readonly problems: readonly string[] }
  | { readonly code: 'reviewer-gate-mismatch' }
  | {
      readonly code: 'review-binding-mismatch'
      readonly detail: 'mapRevision' | 'completionSha' | 'treeOid' | 'testEvidenceDigest'
    }
  | { readonly code: 'tests-gate-mismatch'; readonly problems: readonly string[] }
  | { readonly code: 'wrong-completion-shape'; readonly detail: string }
  | { readonly code: 'completion-sha-not-ancestor'; readonly completionSha: string; readonly targetSha: string }
  | { readonly code: 'conflicting-records'; readonly completionIds: readonly string[] }

/** What the evaluation of one map's completion evidence established. */
export type MapCompletionRecordEvaluation =
  | {
      /** Every §15 predicate holds: this is current, valid completion evidence. */
      readonly status: 'valid'
      readonly record: MapCompletionRecordV1
      readonly anchorCommentId: string
      readonly closingEventId: string
      readonly warnings: readonly string[]
    }
  | { readonly status: 'findings'; readonly findings: readonly MapCompletionFinding[] }
  /** No marked record comment exists on the map issue at all. */
  | { readonly status: 'no-record' }
  | { readonly status: 'error'; readonly code: DeliveryFactsErrorCode; readonly reason: string }

/** Everything the §15 predicate needs about the map under evaluation. */
export type MapCompletionEvidenceQuery = {
  readonly map: {
    readonly issueId: string
    readonly repositoryId: string
    readonly state: 'OPEN' | 'CLOSED'
    readonly mapRevision: string
  }
  readonly targetBranch: string
  readonly trustedEvidenceAuthorIds: readonly string[]
  /** The complete comments+timeline read of the map issue (§14 pagination). */
  readonly evidence: IssueEvidenceRead
  /**
   * §15 predicate 4: every current member's §14 evaluation, keyed by ticket
   * issue ID — `'completed'` or the findings that prevent it.
   */
  readonly memberCompletion: ReadonlyMap<string, 'completed' | readonly DeliveryEvidenceFinding[]>
  readonly facts: DeliveryTargetFacts
}

/** One parsed candidate record with its comment provenance. */
type CompletionCandidate = {
  readonly commentId: string
  readonly authorId: string | null
  readonly canonicalText: string
  readonly value: CanonicalJsonValue
  readonly record: MapCompletionRecordV1
}

/** One logical record: byte-identical duplicate comments collapsed (§14/§15). */
type LogicalCompletionRecord = {
  readonly record: MapCompletionRecordV1
  readonly copies: readonly { commentId: string; authorId: string | null }[]
}

/**
 * Evaluate the complete §15 current-record predicate for one map issue:
 * envelope parsing, duplicate selection, the close-window binding, identity,
 * authorship, chronology, gate, review, ordered tests, and the
 * fetched-target completion shape. All independently discoverable findings
 * accumulate in one pass. A record is *current* only when it names the map's
 * current closing event; records of repaired attempts name older events and
 * are simply not selected — they are historical, not findings.
 */
export async function evaluateMapCompletionRecord(
  query: MapCompletionEvidenceQuery,
): Promise<MapCompletionRecordEvaluation> {
  const findings: MapCompletionFinding[] = []
  const warnings: string[] = []
  const trusted = new Set(query.trustedEvidenceAuthorIds)

  // Grammar: parse every comment; prose is ignored, malformed marked
  // comments are rejected with their own finding.
  const candidates: CompletionCandidate[] = []
  for (const comment of query.evidence.comments) {
    const envelope = parseRecordEnvelope(comment.body)
    if (envelope.kind === 'unmarked') continue
    if (envelope.kind === 'invalid') {
      findings.push({ code: 'invalid-envelope', commentId: comment.commentId, reason: envelope.reason })
      continue
    }
    const problems = mapCompletionRecordProblems(envelope.value)
    if (problems.length > 0) {
      findings.push({ code: 'invalid-record', commentId: comment.commentId, problems })
      continue
    }
    const record = envelope.value as unknown as MapCompletionRecordV1
    candidates.push({
      commentId: comment.commentId,
      authorId: comment.authorId,
      canonicalText: envelope.canonicalText,
      value: envelope.value,
      record,
    })
  }
  if (candidates.length === 0 && findings.length === 0) return { status: 'no-record' }

  // Duplicate rules (§14/§15): group by claimed completionId — byte-identical
  // copies collapse, the same claimed ID with divergent content blocks, then
  // the claimed ID is checked against recomputation.
  const byCompletionId = new Map<string, CompletionCandidate[]>()
  for (const candidate of candidates) {
    const group = byCompletionId.get(candidate.record.completionId) ?? []
    group.push(candidate)
    byCompletionId.set(candidate.record.completionId, group)
  }
  const logical: LogicalCompletionRecord[] = []
  for (const [completionId, group] of byCompletionId) {
    const divergent = new Set(group.map((candidate) => candidate.canonicalText))
    if (divergent.size > 1) {
      findings.push({
        code: 'divergent-duplicate',
        completionId,
        commentIds: group.map((candidate) => candidate.commentId),
      })
      continue
    }
    const first = group[0]!
    const recomputed = recomputeCompletionId(first.value)
    if (recomputed === undefined || recomputed !== completionId) {
      for (const candidate of group) {
        findings.push({ code: 'completion-id-mismatch', commentId: candidate.commentId })
      }
      continue
    }
    if (group.length > 1) {
      warnings.push(
        `duplicate byte-identical completion comments count as one record: ${group
          .map((candidate) => candidate.commentId)
          .join(', ')}`,
      )
    }
    logical.push({
      record: first.record,
      copies: group.map((candidate) => ({
        commentId: candidate.commentId,
        authorId: candidate.authorId,
      })),
    })
  }

  // Rule 1: the map is CLOSED and the record names its current closing event.
  const closing = currentClosingEvent(query.evidence.timeline)
  if (query.map.state !== 'CLOSED') findings.push({ code: 'map-open' })
  if (closing === undefined) findings.push({ code: 'missing-closing-event' })

  const currentRecords = logical.filter(
    (entry) => closing !== undefined && entry.record.map.closingEventId === closing.eventId,
  )
  if (currentRecords.length > 1) {
    findings.push({
      code: 'conflicting-records',
      completionIds: currentRecords.map((entry) => entry.record.completionId),
    })
  }
  const selected = currentRecords[0]
  if (selected === undefined) {
    return findings.length > 0 ? { status: 'findings', findings } : { status: 'no-record' }
  }
  const record = selected.record

  // Rule 2: the anchor is the earliest trusted identical copy; the comment
  // author and the closing-event actor equal actorId, are trusted, and the
  // timeline places the comment after the closing event.
  const trustedCopies = selected.copies.filter(
    (copy) => copy.authorId === record.actorId && trusted.has(record.actorId),
  )
  const anchor = trustedCopies[0] ?? selected.copies[0]!
  if (anchor.authorId !== record.actorId) {
    findings.push({
      code: 'author-mismatch',
      commentAuthorId: anchor.authorId,
      actorId: record.actorId,
    })
  }
  if (!trusted.has(record.actorId)) {
    findings.push({ code: 'untrusted-author', actorId: record.actorId })
  }
  if (closing !== undefined) {
    if (closing.actorId !== record.actorId) {
      findings.push({
        code: 'closing-actor-mismatch',
        closingActorId: closing.actorId,
        actorId: record.actorId,
      })
    }
    const commentIndex = query.evidence.timeline.findIndex(
      (event) => event.kind === 'commented' && event.commentId === anchor.commentId,
    )
    const closingIndex = query.evidence.timeline.findIndex(
      (event) => event.eventId === closing.eventId,
    )
    if (commentIndex === -1) {
      findings.push({ code: 'record-not-in-timeline', commentId: anchor.commentId })
    } else if (commentIndex < closingIndex) {
      findings.push({
        code: 'record-before-close',
        commentId: anchor.commentId,
        closingEventId: closing.eventId,
      })
    }
  }

  // Rule 3: identity, revision, and branch match current facts.
  const identity: ReadonlyArray<['map' | 'repository' | 'branch' | 'revision', string, string]> = [
    ['map', query.map.issueId, record.map.issueId],
    ['repository', query.map.repositoryId, record.target.repositoryId],
    ['branch', query.targetBranch, record.target.branch],
    ['revision', query.map.mapRevision, record.map.revision],
  ]
  for (const [detail, expected, recorded] of identity) {
    if (expected !== recorded) {
      findings.push({ code: 'identity-mismatch', detail, expected, recorded })
    }
  }

  // Rule 4: every current member remains a valid Completed Ticket (§14).
  for (const [ticketIssueId, completion] of query.memberCompletion) {
    if (completion !== 'completed') {
      findings.push({ code: 'member-not-completed', ticketIssueId, findings: [...completion] })
    }
  }

  // Rule 5: gate structure and differing families.
  const gateProblems: string[] = []
  if (record.gate.worker.family === record.gate.reviewer.family) {
    gateProblems.push(
      `worker and reviewer families must differ (both are "${record.gate.worker.family}")`,
    )
  }
  if (gateProblems.length > 0) findings.push({ code: 'invalid-gate', problems: gateProblems })

  // Rule 6: the review matches the gate's Reviewer and binds the completion.
  const reviewer = record.gate.reviewer
  const reviewMatchesGate =
    record.review.provider === reviewer.provider &&
    record.review.model === reviewer.model &&
    record.review.family === reviewer.family &&
    record.review.thinking === reviewer.thinking
  if (!reviewMatchesGate) findings.push({ code: 'reviewer-gate-mismatch' })

  const bindings: ReadonlyArray<
    ['mapRevision' | 'completionSha' | 'treeOid' | 'testEvidenceDigest', string, string]
  > = [
    ['mapRevision', record.map.revision, record.review.mapRevision],
    ['completionSha', record.target.completionSha, record.review.completionSha],
    ['treeOid', record.target.treeOid, record.review.treeOid],
    [
      'testEvidenceDigest',
      canonicalJsonDigest(record.tests as unknown as CanonicalJsonValue),
      record.review.testEvidenceDigest,
    ],
  ]
  for (const [detail, expected, recorded] of bindings) {
    if (expected !== recorded) {
      findings.push({ code: 'review-binding-mismatch', detail })
    }
  }

  // Rule 7: the ordered tests exactly realize the sealed gate tests.
  const testProblems = completionTestPredicateProblems(record)
  if (testProblems.length > 0) findings.push({ code: 'tests-gate-mismatch', problems: testProblems })

  // Rule 8: the completion shape against the fetched target.
  const shapeError = await checkCompletionShape(query, record, findings)
  if (shapeError !== undefined) return shapeError

  if (findings.length === 0 && closing !== undefined) {
    return {
      status: 'valid',
      record,
      anchorCommentId: anchor.commentId,
      closingEventId: closing.eventId,
      warnings,
    }
  }
  return { status: 'findings', findings }
}

/** §15 rule 7: exactly one map-completion entry per sealed gate test. */
function completionTestPredicateProblems(record: MapCompletionRecordV1): readonly string[] {
  const problems: string[] = []
  const gateTests = record.gate.tests
  const tests = record.tests
  if (tests.length !== gateTests.length) {
    problems.push(
      `the record carries ${tests.length} test entries for ${gateTests.length} sealed gate tests`,
    )
  }
  const count = Math.min(tests.length, gateTests.length)
  for (let index = 0; index < count; index++) {
    const test = tests[index] as TestEvidence
    const gate = gateTests[index]!
    if (test.testIndex !== index) problems.push(`tests[${index}].testIndex must equal its position`)
    if (test.phase !== 'map-completion') {
      problems.push(`tests[${index}].phase must be "map-completion"`)
    }
    if (test.argv.join('\u0000') !== gate.argv.join('\u0000')) {
      problems.push(`tests[${index}].argv must equal gate test ${index}`)
    }
    if (test.timeoutMs !== gate.timeoutMs) {
      problems.push(`tests[${index}].timeoutMs must equal gate test ${index}`)
    }
    if (test.baseSha !== record.target.completionSha) {
      problems.push(`tests[${index}].baseSha must equal the completion commit`)
    }
    if (test.treeOid !== record.target.treeOid) {
      problems.push(`tests[${index}].treeOid must equal the completed tree`)
    }
  }
  return problems
}

/** §15 rule 8: `completionSha` has the recorded tree and is an ancestor of the target. */
async function checkCompletionShape(
  query: MapCompletionEvidenceQuery,
  record: MapCompletionRecordV1,
  findings: MapCompletionFinding[],
): Promise<
  | { readonly status: 'error'; readonly code: DeliveryFactsErrorCode; readonly reason: string }
  | undefined
> {
  const target = await query.facts.targetSha(query.targetBranch)
  if (target.kind !== 'ok') {
    return { status: 'error', code: target.code, reason: target.reason }
  }
  const completion = await query.facts.commitFacts(record.target.completionSha)
  if (completion.kind !== 'ok') {
    return { status: 'error', code: completion.code, reason: completion.reason }
  }
  if (completion.value === undefined) {
    findings.push({
      code: 'wrong-completion-shape',
      detail: 'the completion commit is absent from the fetched history',
    })
  } else if (completion.value.treeOid !== record.target.treeOid) {
    findings.push({
      code: 'wrong-completion-shape',
      detail: 'the completion commit carries a different tree than the recorded tree',
    })
  }
  const ancestor = await query.facts.isAncestorOfTarget(record.target.completionSha, query.targetBranch)
  if (ancestor.kind !== 'ok') {
    return { status: 'error', code: ancestor.code, reason: ancestor.reason }
  }
  if (!ancestor.value) {
    findings.push({
      code: 'completion-sha-not-ancestor',
      completionSha: record.target.completionSha,
      targetSha: target.value,
    })
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The map-completion reviewer launch (§15 step 4, §10.2's pattern)
// ---------------------------------------------------------------------------

/** Everything the independent completion reviewer judges (§15 step 4). */
export type MapCompletionReviewerLaunchInput = {
  /** The complete normalized Task Map snapshot, topology included. */
  readonly map: {
    readonly title: string
    readonly body: string
    readonly mapRevision: string
    readonly members: ReadonlyArray<{
      readonly issueId: string
      readonly number: number
      readonly title: string
      readonly body: string
      readonly ticketRevision: string
      readonly blockedBy: readonly string[]
    }>
  }
  readonly target: {
    readonly branch: string
    readonly completionSha: GitObjectOid
    readonly treeOid: GitObjectOid
  }
  /** The ordered successful completion-test evidence (§10.3). */
  readonly tests: readonly TestEvidence[]
  readonly testOutput: readonly ReviewerTestOutput[]
}

export type MapCompletionReviewerPlanner = (
  input: MapCompletionReviewerLaunchInput,
) => AgentLaunchPlan

function renderMapCompletionReviewerPrompt(input: MapCompletionReviewerLaunchInput): string {
  const brief = {
    schema: 'norn-map-completion-review-brief:v1',
    map: input.map,
    target: input.target,
    tests: input.tests,
    testOutput: input.testOutput,
  }
  return (
    'You are the independent Norn Reviewer for Task Map completion. You have read-only tools. ' +
    'Judge whether the complete Task Map — its shared specification, every member Ticket ' +
    'specification, membership, and dependency topology — is satisfied by the repository at ' +
    'the bound completion commit, using the ordered completion test evidence. Every member ' +
    'Ticket is already a verified Completed Ticket; your verdict completes the map. Finish ' +
    'with the norn_complete tool: pass, iterate with feedback, or a typed block. ' +
    'Review briefing (JSON):\n' +
    canonicalJson(brief as CanonicalJsonValue)
  )
}

/**
 * The production read-only completion reviewer launch: the configured
 * reviewer model, the completion extension, and the strict §10.2 read-only
 * tool allowlist. Write-capable built-ins are absent, so the reviewer cannot
 * modify the repository it judges.
 */
export function piMapCompletionReviewerLaunch(
  input: MapCompletionReviewerLaunchInput,
  options: {
    readonly model: string
    readonly thinking: string
    readonly extensionPath: string
    readonly piSessionId: string
  },
): AgentLaunchPlan {
  return {
    argv: [
      ...planAgentPiArgv(
        { model: options.model, thinking: options.thinking },
        { extensionPath: options.extensionPath, piSessionId: options.piSessionId },
      ),
      '--tools',
      REVIEWER_READ_ONLY_TOOLS.join(','),
      renderMapCompletionReviewerPrompt(input),
    ],
  }
}

// ---------------------------------------------------------------------------
// The Map Completion Checkpoint store (§13.1, §15)
// ---------------------------------------------------------------------------

export type MapCompletionStoreErrorCode = 'control-store' | 'state-integrity'

/**
 * The injectable checkpoint store. Every operation loads the Run State
 * document, mutates its `mapCompletion` checkpoint (and the completion
 * reviewer's process groups), and persists it through the atomic write
 * protocol — so a crash between any two operations leaves the previous or
 * the complete new checkpoint, never a torn one.
 */
export type MapCompletionCheckpointStore = {
  /** The persisted checkpoint, or `undefined` when none exists. */
  load(): Promise<Outcome<MapCompletionCheckpoint | undefined, never, MapCompletionStoreErrorCode>>
  /**
   * Persist the `gated` checkpoint (attempt, anchor, workspace, sealed
   * gates). Replaces any prior checkpoint — a restart discards the stale
   * gates durably before anything else runs (§15).
   */
  persistGated(
    checkpoint: MapCompletionCheckpoint,
  ): Promise<Outcome<MapCompletionCheckpoint, never, MapCompletionStoreErrorCode>>
  /** Confirm the remotely observed close: stage `map-closed` plus its event. */
  markMapClosed(
    closingEventId: string,
  ): Promise<Outcome<MapCompletionCheckpoint, never, MapCompletionStoreErrorCode>>
  /** Store the sealed record before the first comment attempt (§15). */
  sealRecord(
    record: MapCompletionRecordV1,
  ): Promise<Outcome<MapCompletionCheckpoint, never, MapCompletionStoreErrorCode>>
  /** Confirm the remotely present record comment: stage `recorded`. */
  markRecorded(): Promise<Outcome<MapCompletionCheckpoint, never, MapCompletionStoreErrorCode>>
  /** Drop the checkpoint: the prior gates are discarded (§15). */
  clear(): Promise<Outcome<void, never, MapCompletionStoreErrorCode>>
  /** Upsert one completion process-group checkpoint (§16/§17 write-ahead). */
  recordProcessGroup(
    group: ProcessGroupCheckpoint,
  ): Promise<Outcome<void, never, MapCompletionStoreErrorCode>>
  /** Remove process groups whose settlement proved exit (§16). */
  dropProcessGroups(
    ids: readonly string[],
  ): Promise<Outcome<void, never, MapCompletionStoreErrorCode>>
}

/**
 * The production checkpoint store over one Run State document (§13.1). Only
 * the coordinator (map-lock protected) writes it, and `saveRunState`
 * re-validates every integrity rule before any byte is written.
 */
export function runStateMapCompletionStore(options: {
  readonly repositoryHome: string
  readonly encodedMapIssueId: string
}): MapCompletionCheckpointStore {
  const { repositoryHome, encodedMapIssueId } = options

  return {
    async load() {
      const loaded = loadRunState(repositoryHome, encodedMapIssueId)
      if (loaded.kind !== 'ok') return loaded
      return ok(loaded.value?.mapCompletion)
    },

    async persistGated(checkpoint) {
      return updateMapCompletion(repositoryHome, encodedMapIssueId, (state) => {
        if (state.status !== 'running') {
          return storeIntegrityError('the run is no longer running; a gated checkpoint cannot persist')
        }
        const next: RunState = { ...state, mapCompletion: checkpoint }
        return ok({ state: next, result: next.mapCompletion! })
      })
    },

    async markMapClosed(closingEventId) {
      return updateMapCompletion(repositoryHome, encodedMapIssueId, (state) => {
        const current = requireCheckpoint(state)
        if (current.kind !== 'ok') return current
        if (current.value.stage !== 'gated' && current.value.stage !== 'map-closed') {
          return storeIntegrityError(
            `the completion checkpoint is at stage "${current.value.stage}" and cannot confirm a close`,
          )
        }
        const next: MapCompletionCheckpoint = {
          ...current.value,
          stage: 'map-closed',
          closingEventId,
        }
        return ok({ state: { ...state, mapCompletion: next }, result: next })
      })
    },

    async sealRecord(record) {
      return updateMapCompletion(repositoryHome, encodedMapIssueId, (state) => {
        const current = requireCheckpoint(state)
        if (current.kind !== 'ok') return current
        if (current.value.stage !== 'map-closed' || current.value.closingEventId === undefined) {
          return storeIntegrityError(
            'the sealed completion record requires a confirmed map close first (§15)',
          )
        }
        if (
          record.run.completionAttemptId !== current.value.completionAttemptId ||
          record.map.closingEventId !== current.value.closingEventId
        ) {
          return storeIntegrityError(
            'the sealed record must bind the checkpoint attempt and closing event',
          )
        }
        const next: MapCompletionCheckpoint = { ...current.value, record }
        return ok({ state: { ...state, mapCompletion: next }, result: next })
      })
    },

    async markRecorded() {
      return updateMapCompletion(repositoryHome, encodedMapIssueId, (state) => {
        const current = requireCheckpoint(state)
        if (current.kind !== 'ok') return current
        if (current.value.stage !== 'map-closed' && current.value.stage !== 'recorded') {
          return storeIntegrityError(
            `the completion checkpoint is at stage "${current.value.stage}" and cannot confirm the record`,
          )
        }
        if (current.value.record === undefined) {
          return storeIntegrityError('the record comment cannot be confirmed before it is sealed')
        }
        const next: MapCompletionCheckpoint = { ...current.value, stage: 'recorded' }
        return ok({ state: { ...state, mapCompletion: next }, result: next })
      })
    },

    async clear() {
      return updateMapCompletion(repositoryHome, encodedMapIssueId, (state) =>
        ok({ state: { ...state, mapCompletion: undefined }, result: undefined }),
      )
    },

    async recordProcessGroup(group) {
      return updateMapCompletion(repositoryHome, encodedMapIssueId, (state) =>
        ok({
          state: {
            ...state,
            activeProcesses: [
              ...state.activeProcesses.filter((entry) => entry.id !== group.id),
              group,
            ],
          },
          result: undefined,
        }),
      )
    },

    async dropProcessGroups(ids) {
      return updateMapCompletion(repositoryHome, encodedMapIssueId, (state) => {
        const drop = new Set(ids)
        return ok({
          state: {
            ...state,
            activeProcesses: state.activeProcesses.filter((entry) => !drop.has(entry.id)),
          },
          result: undefined,
        })
      })
    },
  }
}

function requireCheckpoint(
  state: RunState,
): Outcome<MapCompletionCheckpoint, never, MapCompletionStoreErrorCode> {
  if (state.mapCompletion === undefined) {
    return storeIntegrityError('no map completion checkpoint exists for this run')
  }
  return ok(state.mapCompletion)
}

function storeIntegrityError(
  reason: string,
): Outcome<never, never, MapCompletionStoreErrorCode> {
  return error({ scope: 'run', code: 'state-integrity', reason, sharedWrite: 'none', evidence: [] })
}

/**
 * Load the Run State document, apply one checkpoint mutation, and persist
 * the next document atomically (the same protocol as the Ship store).
 */
function updateMapCompletion<T>(
  repositoryHome: string,
  encodedMapIssueId: string,
  mutate: (
    state: RunState,
  ) => Outcome<
    { readonly state: RunState; readonly result: T },
    never,
    MapCompletionStoreErrorCode
  >,
): Outcome<T, never, MapCompletionStoreErrorCode> {
  const loaded = loadRunState(repositoryHome, encodedMapIssueId)
  if (loaded.kind !== 'ok') return loaded
  if (loaded.value === undefined) {
    return error({
      scope: 'run',
      code: 'control-store',
      reason: 'no run state exists for this map',
      sharedWrite: 'none',
      evidence: [],
    })
  }
  const result = mutate(loaded.value)
  if (result.kind !== 'ok') return result
  const saved = saveRunState(repositoryHome, encodedMapIssueId, result.value.state)
  if (saved.kind !== 'ok') {
    return error({
      scope: 'run',
      code: saved.code,
      reason: `persisting the map completion checkpoint failed: ${saved.reason}`,
      sharedWrite: 'none',
      evidence: [...saved.evidence],
    })
  }
  return ok(result.value.result)
}

// ---------------------------------------------------------------------------
// The injected seams and parameters
// ---------------------------------------------------------------------------

/** Everything the completion protocol composes. */
export type MapCompletionDeps = {
  /** The Visible Agent Runner seam for the completion reviewer (§6, §17). */
  readonly runner: VisibleAgentRunner
  /** The Command runner seam for setup and tests (§6, §10.2). */
  readonly commands: CommandRunner
  /** The git command seam for workspace verification. */
  readonly git: GitCommandRunner
  /** The remote target and commit facts seam, fetch included (§15). */
  readonly facts: ShipFacts
  /** One stable read of the current Task Map snapshot (§7.3). */
  readonly readMap: () => Promise<StableSnapshotOutcome>
  /** One complete comments+timeline read of one issue (§14). */
  readonly readIssueEvidence: IssueEvidenceReader['loadIssueEvidence']
  /** The GitHub issue-write seam: record comment, close, reopen (§15). */
  readonly writer: GitHubIssueWriter
  /**
   * Persists a Compatible Map Extension (§7.4). Called only with the target
   * lock released (§16); a blocked result means adoption was prevented — the
   * change is treated as incompatible.
   */
  readonly adoptExtension: (
    extension: ShipExtensionAdoption,
  ) => Promise<Outcome<void, 'changed-input', 'control-store'>>
  /** Atomic Map Completion Checkpoint persistence over the Run State store. */
  readonly checkpoint: MapCompletionCheckpointStore
  /** The target lock serializing Ship per repository and branch (§16). */
  readonly lock: ShipTargetLock
  /** Builds the read-only completion reviewer launch (§15 step 4). */
  readonly planReviewer: MapCompletionReviewerPlanner
  /** Validates the reviewer plan; defaults to the argv allowlist check. */
  readonly reviewerPlanIsReadOnly?: (plan: AgentLaunchPlan) => boolean
  /** Sealed-record timestamps; defaults to the §14 format now. */
  readonly now?: () => string
}

/** Everything one completion needs, beyond its injected seams. */
export type MapCompletionParams = {
  readonly runId: string
  readonly map: MapRef
  /** The latest accepted lineage entry when completion starts (§7.4, §13.1). */
  readonly accepted: AcceptedMapRevision
  readonly repositoryRoot: string
  readonly repositoryId: string
  readonly repositoryHome: string
  readonly targetBranch: string
  readonly setup: readonly RunConfigCommand[]
  readonly tests: readonly RunConfigCommand[]
  readonly reviewer: RunConfigAgentRole & { readonly family: string }
  readonly trustedEvidenceAuthorIds: readonly string[]
  /** Run-owned completions area, outside every workspace (§17). */
  readonly completionsDir: string
  /** Whether this run already shipped any Ticket (§15 shared-write state). */
  readonly alreadyShipped: boolean
  /** The sealed evidence gate from the resolved Run Config (§15). */
  readonly gate: EvidenceGateV1
  /** The authenticated GitHub actor that will author the record (§15). */
  readonly actorId: string
  readonly configRevision: string
  readonly nornVersion: string
}

// ---------------------------------------------------------------------------
// Internal step vocabulary
// ---------------------------------------------------------------------------

/** The sealed gates of one completion attempt, before the close protocol. */
type SealedGates = {
  readonly completionAttemptId: string
  readonly workspace: WorkspaceRef
  readonly mapRevision: string
  readonly completionSha: string
  readonly treeOid: string
  readonly gate: EvidenceGateV1
  readonly tests: readonly TestEvidence[]
  readonly review: MapCompletionReviewEvidence
}

/**
 * Internal control flow of the protocol: a terminal completion, a return to
 * Wave planning, a fresh-attempt restart, an extension to adopt (with the
 * target lock released) before replanning or restarting, or a final outcome.
 */
type ProtocolSignal =
  | {
      readonly kind: 'completed'
      readonly completionSha: string
      readonly closingEventId: string
      readonly record: MapCompletionRecordV1
      readonly commentWritten: boolean
      readonly warnings: readonly string[]
      readonly workspace: WorkspaceRef
    }
  | { readonly kind: 'replan' }
  | { readonly kind: 'restart' }
  | {
      readonly kind: 'adopt-extension'
      readonly extension: ShipExtensionAdoption
      /** The shared-write state proven so far (a repair confirms). */
      readonly sharedWrite: 'none' | 'confirmed'
    }
  | { readonly kind: 'outcome'; readonly outcome: MapCompletionOutcome }

/** Mutable protocol context: the lock, the accepted lineage, shared writes. */
type ProtocolContext = {
  lock: ShipTargetLockHandle | undefined
  /**
   * The accepted lineage, shared across every attempt of one `completeMap`
   * invocation: an adoption during one attempt is the next attempt's base.
   */
  readonly lineage: { accepted: AcceptedMapRevision }
  /** Shared across every attempt of one `completeMap` invocation. */
  readonly adopted: MapCompletionAdoption[]
  readonly warnings: string[]
  /**
   * The shared-write state proven so far: starts from `alreadyShipped` and
   * becomes `confirmed` with the map close (§9, §15).
   */
  sharedWrite: 'none' | 'confirmed'
}

// ---------------------------------------------------------------------------
// The completion protocol (§15)
// ---------------------------------------------------------------------------

/**
 * Prove the whole map. With no persisted checkpoint this runs one fresh
 * completion attempt — gates at the exact remote commit, then the guarded
 * close-and-record protocol under the target lock — restarting internally
 * when the target moved or an adopted extension invalidated the gates. With
 * a persisted `MapCompletionCheckpoint`, the §13.4 recovery reconciliation
 * runs first: it never guesses from the checkpoint stage alone.
 */
export async function completeMap(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
): Promise<MapCompletionOutcome> {
  const adopted: MapCompletionAdoption[] = []
  const warnings: string[] = []
  const lineage = { accepted: params.accepted }
  for (;;) {
    const loaded = await deps.checkpoint.load()
    if (loaded.kind !== 'ok') {
      return storeFailure('loading the map completion checkpoint', loaded, 'none')
    }

    const signal =
      loaded.value !== undefined
        ? await reconcileCheckpoint(deps, params, loaded.value, adopted, warnings, lineage)
        : await freshAttempt(deps, params, adopted, warnings, lineage)

    const resolved = await resolveSignal(deps, params, signal, adopted, lineage)
    if (resolved !== undefined) return resolved
    // A restart loops with the checkpoint now cleared.
  }
}

/** One fresh completion attempt: gates, then the guarded close and record. */
async function freshAttempt(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  adopted: MapCompletionAdoption[],
  warnings: string[],
  lineage: { accepted: AcceptedMapRevision },
): Promise<ProtocolSignal> {
  const gates = await runCompletionGates(deps, params, nextCompletionAttemptId(params))
  if (gates.kind !== 'ok') return { kind: 'outcome', outcome: gates }
  const acquired = await deps.lock.acquire()
  if (acquired.kind !== 'ok') {
    return {
      kind: 'outcome',
      outcome: completionError('lock-failed', `acquiring the target lock failed: ${acquired.reason}`, [], 'none'),
    }
  }
  const ctx: ProtocolContext = {
    lock: acquired.value,
    lineage,
    adopted,
    warnings,
    sharedWrite: params.alreadyShipped ? 'confirmed' : 'none',
  }
  try {
    return await closeAndRecord(deps, params, gates.value, /* resuming */ undefined, ctx)
  } finally {
    await releaseContextLock(ctx)
  }
}

/**
 * Translate one protocol signal into the final outcome, adopting any
 * extension whose decision was deferred past the lock release (§15).
 * `undefined` means: loop with a fresh attempt.
 */
async function resolveSignal(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  signal: ProtocolSignal,
  adopted: MapCompletionAdoption[],
  lineage: { accepted: AcceptedMapRevision },
): Promise<MapCompletionOutcome | undefined> {
  for (;;) {
    if (signal.kind === 'restart') return undefined
    if (signal.kind === 'replan') {
      return ok({ kind: 'replan', adoptedExtensions: [...adopted] })
    }
    if (signal.kind === 'completed') {
      return ok({
        kind: 'completed',
        completionSha: signal.completionSha,
        closingEventId: signal.closingEventId,
        completionId: signal.record.completionId,
        record: signal.record,
        commentWritten: signal.commentWritten,
        warnings: [...new Set(signal.warnings)],
        adoptedExtensions: [...adopted],
        workspace: signal.workspace,
      })
    }
    if (signal.kind === 'outcome') return signal.outcome
    // adopt-extension: the target lock is released; adopt, then decide
    // planning versus restart from the added Tickets' current evidence.
    const adoption = await deps.adoptExtension(signal.extension)
    if (adoption.kind === 'blocked') {
      // §7.4: a blocked added-Ticket preflight prevents adoption and is
      // treated as an incompatible change.
      return changedInput(signal.sharedWrite, [
        { stage: 'extension-adoption', reason: adoption.reason, kind: 'blocked' },
      ])
    }
    if (adoption.kind !== 'ok') {
      return storeFailure('adopting the Compatible Map Extension', adoption, signal.sharedWrite)
    }
    adopted.push({
      revision: signal.extension.revision,
      fromRevision: signal.extension.fromRevision,
      addedTicketIssueIds: [...signal.extension.addedTicketIssueIds],
    })
    lineage.accepted = {
      revision: signal.extension.revision,
      payload: signal.extension.payload,
      extension: {
        fromRevision: signal.extension.fromRevision,
        addedTicketIssueIds: [...signal.extension.addedTicketIssueIds],
      },
    }
    signal = await decideAddedTickets(deps, params, signal.extension)
  }
}

/** Release (and clear) the context's target lock on every exit path. */
async function releaseContextLock(ctx: ProtocolContext): Promise<void> {
  const lock = ctx.lock
  ctx.lock = undefined
  if (lock !== undefined) await lock.release()
}

// ---------------------------------------------------------------------------
// §15 steps 1–5: one completion attempt's gates
// ---------------------------------------------------------------------------

/** The next unique completion attempt ID whose workspace path is free. */
function nextCompletionAttemptId(params: MapCompletionParams): string {
  const base = `${params.runId}-mc`
  for (let index = 1; ; index++) {
    const candidate = `${base}${index}`
    const path = mapCompletionWorkspaceDir(params.repositoryHome, params.runId, candidate)
    if (path !== undefined && !existsSync(path)) return candidate
  }
}

/**
 * The attempt gates of §15 steps 1–5: read the completion commit, check out
 * exactly that commit in a clean run-owned workspace, run setup and the
 * complete test list with the §10.2 post-command checks, run one fresh
 * read-only review of the complete normalized snapshot plus the ordered
 * completion-test evidence, and re-verify the commit, tree, and cleanliness.
 */
async function runCompletionGates(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  completionAttemptId: string,
): Promise<Outcome<SealedGates, MapCompletionBlockCode, MapCompletionErrorCode>> {
  // --- step 1: the completion commit from the remote target ---------------

  const target = await readCompletionTarget(deps, params)
  if (target.kind !== 'ok') return target.failure
  const { sha: completionSha, treeOid, snapshot } = target.value

  // --- step 2: the run-owned workspace at exactly that commit -------------

  const workspace = await createMapCompletionWorkspace(
    { git: deps.git },
    {
      repositoryRoot: params.repositoryRoot,
      repositoryHome: params.repositoryHome,
      repositoryId: params.repositoryId,
      runId: params.runId,
      completionAttemptId,
      completion: { sha: completionSha, treeOid },
    },
    'run',
  )
  if (workspace.kind !== 'ok') return workspace

  // --- step 3: setup, then the complete test list (§10.2 checks) ----------

  const gateDeps: GateDeps = { runner: deps.commands, git: deps.git }
  const gateWorkspace = {
    path: workspace.value.path,
    expectedHead: completionSha,
    expectedTreeOid: treeOid,
  }
  const setup = await runGateCommandList(gateDeps, {
    commands: params.setup,
    workspace: gateWorkspace,
    scope: 'run',
  })
  if (setup.kind !== 'ok') return setup
  const setupFailure = firstNonPass(setup.value)
  if (setupFailure !== undefined) {
    return completionGateFailed(params, 'setup', setupFailure.index, setupFailure.detail)
  }
  const tests = await runGateCommandList(gateDeps, {
    commands: params.tests,
    workspace: gateWorkspace,
    scope: 'run',
  })
  if (tests.kind !== 'ok') return tests
  const testFailure = firstNonPass(tests.value)
  if (testFailure !== undefined) {
    return completionGateFailed(params, 'tests', testFailure.index, testFailure.detail)
  }
  const evidence = mapCompletionTests(tests.value, completionSha, treeOid)
  const problem = gateMatchesTests(params.gate, evidence)
  if (problem !== undefined) {
    return completionError('state-integrity', problem, [], 'none')
  }

  // --- step 4: one fresh read-only reviewer of the whole map --------------

  const review = await runCompletionReviewer(deps, params, {
    completionAttemptId,
    workspace: workspace.value,
    snapshot,
    completionSha,
    treeOid,
    tests: evidence,
    testOutput: reviewerTestOutput(tests.value),
  })
  if (review.kind !== 'ok') return review

  // --- step 5: re-verify the commit, tree, and cleanliness ----------------

  const verified = await verifyCompletionWorkspace(deps, workspace.value.path, {
    expectedHead: completionSha,
    expectedTreeOid: treeOid,
  })
  if (verified !== undefined) return verified

  return ok({
    completionAttemptId,
    workspace: workspace.value,
    mapRevision: snapshot.mapRevision,
    completionSha,
    treeOid,
    gate: params.gate,
    tests: evidence,
    review: review.value,
  })
}

/** Fetch the target and read its current commit, tree, and stable snapshot. */
async function readCompletionTarget(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
): Promise<
  | {
      readonly kind: 'ok'
      readonly value: {
        readonly sha: GitObjectOid
        readonly treeOid: GitObjectOid
        readonly snapshot: TaskMapSnapshot
      }
    }
  | {
      readonly kind: 'failure'
      readonly failure: Outcome<never, MapCompletionBlockCode, MapCompletionErrorCode>
    }
> {
  const mapRead = await deps.readMap()
  if (mapRead.kind === 'error') {
    return { kind: 'failure', failure: completionError('map-read', mapRead.reason, [...mapRead.evidence], 'none') }
  }
  if (mapRead.kind === 'blocked') {
    return {
      kind: 'failure',
      failure: changedInput(initialSharedWrite(params), [
        { stage: 'gate-map-read', code: mapRead.code, reason: mapRead.reason },
        ...mapRead.evidence,
      ]),
    }
  }
  const snapshot = mapRead.value
  if (snapshot.state !== 'OPEN') {
    return {
      kind: 'failure',
      failure: changedInput(initialSharedWrite(params), [
        { stage: 'gate-map-state', mapState: snapshot.state, mapRevision: snapshot.mapRevision },
      ]),
    }
  }
  const fetched = await deps.facts.fetchTarget(params.targetBranch)
  if (fetched.kind !== 'ok') {
    return { kind: 'failure', failure: completionError('target-read', fetched.reason, [...fetched.evidence], 'none') }
  }
  const shaRead = await deps.facts.targetSha(params.targetBranch)
  if (shaRead.kind !== 'ok') {
    return { kind: 'failure', failure: completionError('target-read', shaRead.reason, [...shaRead.evidence], 'none') }
  }
  const commit = await deps.facts.commitFacts(stripOid(shaRead.value))
  if (commit.kind !== 'ok') {
    return { kind: 'failure', failure: completionError('target-read', commit.reason, [...commit.evidence], 'none') }
  }
  if (commit.value === undefined) {
    return {
      kind: 'failure',
      failure: completionError(
        'target-read',
        `the target commit ${shaRead.value} is absent after the fetch`,
        [{ targetSha: shaRead.value }],
        'none',
      ),
    }
  }
  return {
    kind: 'ok',
    value: { sha: shaRead.value, treeOid: commit.value.treeOid, snapshot },
  }
}

/** One ordered map-completion `TestEvidence` per passing configured test (§10.3). */
function mapCompletionTests(
  list: GateCommandListValue,
  completionSha: string,
  treeOid: string,
): TestEvidence[] {
  return list.entries.map((entry) => {
    if (entry.result.status !== 'pass') {
      throw new Error('completion test evidence may only be built from a complete passing list')
    }
    return {
      phase: 'map-completion' as const,
      testIndex: entry.index,
      argv: [...entry.command.argv],
      timeoutMs: entry.command.timeoutMs,
      baseSha: completionSha,
      treeOid,
      exitCode: 0 as const,
      outputDigest: entry.result.outputDigest,
    }
  })
}

/** The captured output of every passing test, for the reviewer (§10.2). */
function reviewerTestOutput(list: GateCommandListValue): ReviewerTestOutput[] {
  return list.entries.map((entry) => {
    if (entry.result.status !== 'pass') {
      throw new Error('reviewer output may only be built from a complete passing list')
    }
    return {
      testIndex: entry.index,
      argv: [...entry.command.argv],
      stdout: Buffer.from(entry.result.stdout).toString('utf8'),
      stderr: Buffer.from(entry.result.stderr).toString('utf8'),
      outputDigest: entry.result.outputDigest,
    }
  })
}

/** The first non-pass of a stopped command list, when the list stopped early. */
function firstNonPass(
  list: GateCommandListValue,
): { readonly index: number; readonly detail: CanonicalJsonValue } | undefined {
  if (list.stoppedAtIndex === null) return undefined
  const entry = list.entries[list.stoppedAtIndex]
  if (entry === undefined || entry.result.status === 'pass') return undefined
  return {
    index: entry.index,
    detail: {
      argv: [...entry.command.argv],
      cause: entry.result.cause,
      exitCode: entry.result.exitCode,
      stdout: Buffer.from(entry.result.stdout).toString('utf8'),
      stderr: Buffer.from(entry.result.stderr).toString('utf8'),
    },
  }
}

/** The sealed gate must be realized exactly by the ordered tests (§15 rule 7). */
function gateMatchesTests(gate: EvidenceGateV1, tests: readonly TestEvidence[]): string | undefined {
  if (gate.tests.length !== tests.length) {
    return `the sealed gate lists ${gate.tests.length} tests but the completion carries ${tests.length}`
  }
  for (let index = 0; index < tests.length; index++) {
    const test = tests[index]!
    const gateTest = gate.tests[index]!
    if (test.testIndex !== index) {
      return `completion test ${index} carries testIndex ${test.testIndex}`
    }
    if (test.argv.join('\u0000') !== gateTest.argv.join('\u0000')) {
      return `completion test ${index} argv differs from the sealed gate test`
    }
    if (test.timeoutMs !== gateTest.timeoutMs) {
      return `completion test ${index} timeoutMs differs from the sealed gate test`
    }
  }
  return undefined
}

/** §15 steps 4–5's reviewer: launch, settle, verdict, then seal the review. */
async function runCompletionReviewer(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  attempt: {
    readonly completionAttemptId: string
    readonly workspace: WorkspaceRef
    readonly snapshot: TaskMapSnapshot
    readonly completionSha: string
    readonly treeOid: string
    readonly tests: readonly TestEvidence[]
    readonly testOutput: readonly ReviewerTestOutput[]
  },
): Promise<Outcome<MapCompletionReviewEvidence, MapCompletionBlockCode, MapCompletionErrorCode>> {
  const plan = deps.planReviewer({
    map: {
      title: attempt.snapshot.title,
      body: attempt.snapshot.body,
      mapRevision: attempt.snapshot.mapRevision,
      members: attempt.snapshot.tickets.map((ticket) => ({
        issueId: ticket.ref.issueId,
        number: ticket.ref.number,
        title: ticket.title,
        body: ticket.body,
        ticketRevision: ticket.ticketRevision,
        blockedBy: ticket.blockedBy.map((blocker) => blocker.issueId),
      })),
    },
    target: {
      branch: params.targetBranch,
      completionSha: attempt.completionSha,
      treeOid: attempt.treeOid,
    },
    tests: attempt.tests,
    testOutput: attempt.testOutput,
  })
  const planIsReadOnly =
    deps.reviewerPlanIsReadOnly ?? ((candidate: AgentLaunchPlan) => isReadOnlyAgentArgv(candidate.argv))
  if (!planIsReadOnly(plan)) {
    return completionError(
      'reviewer-not-read-only',
      'the completion reviewer launch plan exposes write-capable tools (§10.2)',
      [{ argv: plan.argv }],
      'none',
    )
  }

  const invocationId = `${attempt.completionAttemptId}-rev`
  const context: AgentCompletionContext = {
    schema: AGENT_COMPLETION_SCHEMA,
    invocationId,
    runId: params.runId,
    role: 'reviewer',
    phase: 'map-completion',
    map: {
      githubHost: params.map.githubHost,
      repositoryId: params.map.repositoryId,
      issueId: params.map.issueId,
    },
    workspace: { kind: 'map-completion', path: attempt.workspace.path },
    piSessionId: `${invocationId}-pi`,
    completionsDir: params.completionsDir,
  }

  // The write-ahead process-group protocol of §16/§17: the launch intent is
  // persisted before the process exists; the settled group is dropped once
  // its settlement proves exit.
  const intent: ProcessGroupCheckpoint = {
    id: invocationId,
    owner: 'reviewer',
    phase: 'map-completion',
    workspace: attempt.workspace,
    adapterHandle: invocationId,
    state: 'launch-intent',
  }
  const recorded = await deps.checkpoint.recordProcessGroup(intent)
  if (recorded.kind !== 'ok') {
    return storeFailure('recording the completion reviewer launch intent', recorded, 'none')
  }

  const settlement = await runAgentInvocation(deps.runner, {
    context,
    argv: plan.argv,
    cwd: attempt.workspace.path,
    env: plan.env,
    timeoutMs: params.reviewer.timeoutMs,
    scope: 'run',
  })
  const provenExited =
    settlement.kind === 'ok' ||
    settlement.kind === 'blocked' ||
    (settlement.kind === 'error' &&
      ['launch-failed', 'agent-timeout', 'protocol-error', 'malformed-sidecar'].includes(settlement.code))
  if (provenExited) {
    const dropped = await deps.checkpoint.dropProcessGroups([invocationId])
    if (dropped.kind !== 'ok') {
      return storeFailure('settling the completion reviewer process group', dropped, 'none')
    }
  } else {
    const settled = await deps.checkpoint.recordProcessGroup({ ...intent, state: 'settled' })
    if (settled.kind !== 'ok') {
      return storeFailure('settling the completion reviewer process group', settled, 'none')
    }
  }
  if (settlement.kind === 'blocked') {
    // Unreachable through this seam (no operator signal is wired into the
    // completion reviewer); a typed block cannot pass the §15 gate anyway.
    return completionGateFailed(params, 'review', null, { verdict: 'aborted' })
  }
  if (settlement.kind !== 'ok') return settlement

  const verdict = settlement.value.completion as ReviewerCompletion
  if (verdict.discriminant !== 'pass') {
    return completionGateFailed(params, 'review', null, {
      verdict: verdict.discriminant,
      ...(verdict.discriminant === 'iterate' ? { feedback: verdict.feedback } : {}),
      ...(verdict.discriminant === 'block' ? { code: verdict.code, reason: verdict.reason } : {}),
    })
  }

  return ok({
    phase: 'map-completion',
    provider: modelProvider(params.reviewer.model),
    model: params.reviewer.model,
    family: params.reviewer.family,
    thinking: params.reviewer.thinking,
    verdict: 'pass',
    mapRevision: attempt.snapshot.mapRevision,
    completionSha: attempt.completionSha,
    treeOid: attempt.treeOid,
    testEvidenceDigest: canonicalJsonDigest(attempt.tests as unknown as CanonicalJsonValue),
  })
}

/**
 * §15 step 5: the completion workspace still sits at exactly the completion
 * commit and tree, detached, and clean.
 */
async function verifyCompletionWorkspace(
  deps: MapCompletionDeps,
  path: string,
  expected: { readonly expectedHead: string; readonly expectedTreeOid: string },
): Promise<CompletionFailure | undefined> {
  const inspection = await inspectWorkspace(deps.git, path)
  if (inspection.status !== 'ok') {
    return completionError(
      'workspace-inspection-failed',
      `completion workspace inspection failed: ${inspection.message}`,
      [],
      'none',
    )
  }
  const violations: Record<string, CanonicalJsonValue> = {}
  if (inspection.state.symbolicHead !== null) {
    violations.symbolicHead = { expected: null, actual: inspection.state.symbolicHead }
  }
  if (inspection.state.head !== expected.expectedHead) {
    violations.head = { expected: expected.expectedHead, actual: inspection.state.head }
  }
  if (inspection.state.headTree !== expected.expectedTreeOid) {
    violations.headTree = { expected: expected.expectedTreeOid, actual: inspection.state.headTree }
  }
  if (inspection.state.status.length !== 0) violations.status = inspection.state.status
  if (Object.keys(violations).length === 0) return undefined
  return completionError(
    'workspace-verification-failed',
    'the completion workspace changed under the gates (§15 step 5)',
    [violations],
    'none',
  )
}

// ---------------------------------------------------------------------------
// §15 steps 6–11: the guarded close-and-record protocol
// ---------------------------------------------------------------------------

/**
 * The guarded tail of one completion attempt (or a §13.4 resume of it):
 * stabilize the map under the target lock, capture the anchor, persist the
 * gated checkpoint, close the map, then seal, write-or-reuse, and validate
 * the completion record — all while still holding the lock for the unchanged
 * case. `resuming` carries the persisted checkpoint whose close is retried
 * under the caller's already-held lock and context.
 */
async function closeAndRecord(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  gates: SealedGates,
  resuming: MapCompletionCheckpoint | undefined,
  ctx: ProtocolContext,
): Promise<ProtocolSignal> {
  // --- §15 step 6: stabilize under the lock, with the §11.3 dance ---------

  const stabilized = await stabilizeForClose(deps, params, ctx, gates)
  if (stabilized !== undefined) return stabilized

  // --- §15 step 8: anchor, gated checkpoint, close ------------------------

  let checkpoint: MapCompletionCheckpoint
  if (resuming === undefined) {
    const anchor = await readTimelineAnchor(deps, params, ctx)
    if ('outcome' in anchor) return { kind: 'outcome', outcome: anchor.outcome }
    checkpoint = {
      stage: 'gated',
      completionAttemptId: gates.completionAttemptId,
      timelineAnchorEventId: anchor.anchorEventId,
      workspace: gates.workspace,
      mapRevision: gates.mapRevision,
      completionSha: gates.completionSha,
      treeOid: gates.treeOid,
      gate: gates.gate,
      tests: [...gates.tests],
      review: gates.review,
    }
    const persisted = await deps.checkpoint.persistGated(checkpoint)
    if (persisted.kind !== 'ok') {
      return {
        kind: 'outcome',
        outcome: storeFailure('persisting the gated completion checkpoint', persisted, ctx.sharedWrite),
      }
    }
  } else {
    if (resuming.stage !== 'gated') {
      return {
        kind: 'outcome',
        outcome: completionError(
          'state-integrity',
          `a resumed close protocol requires a "gated" checkpoint, not "${resuming.stage}"`,
          [{ stage: resuming.stage }],
          ctx.sharedWrite,
        ),
      }
    }
    checkpoint = resuming
  }

  // Operator interference between the anchor and the close stops the
  // protocol instead of silently overwriting the visible state change.
  const preClose = await readMapEvidence(deps, params, ctx, 'pre-close-window')
  if ('outcome' in preClose) return { kind: 'outcome', outcome: preClose.outcome }
  if (closeThenReopenAfter(preClose.evidence.timeline, checkpoint.timelineAnchorEventId)) {
    const cleared = await deps.checkpoint.clear()
    if (cleared.kind !== 'ok') {
      return {
        kind: 'outcome',
        outcome: storeFailure('discarding the interfered completion gates', cleared, ctx.sharedWrite),
      }
    }
    return {
      kind: 'outcome',
      outcome: changedInput(ctx.sharedWrite, [
        { stage: 'close-then-reopen-after-anchor', anchorEventId: checkpoint.timelineAnchorEventId },
      ]),
    }
  }

  const mapRead = await readStableMap(deps, params, ctx, 'pre-close')
  if ('outcome' in mapRead) return { kind: 'outcome', outcome: mapRead.outcome }
  if (mapRead.snapshot.state !== 'OPEN') {
    return {
      kind: 'outcome',
      outcome: changedInput(ctx.sharedWrite, [
        { stage: 'pre-close-map-state', mapState: mapRead.snapshot.state },
      ]),
    }
  }

  const closed = await deps.writer.closeIssue(locatorOf(params.map))
  if (closed.kind !== 'ok') {
    return {
      kind: 'outcome',
      outcome: completionError(
        'issue-close',
        `closing the Task Map returned an unknown result: ${closed.reason}`,
        [...closed.evidence],
        'unknown',
      ),
    }
  }
  ctx.sharedWrite = 'confirmed'

  // --- confirm the close: the closing event, bound to the anchor ----------

  const postClose = await readMapEvidence(deps, params, ctx, 'close-window')
  if ('outcome' in postClose) return { kind: 'outcome', outcome: postClose.outcome }
  const binding = closingEventBinding(
    postClose.evidence.timeline,
    checkpoint.timelineAnchorEventId,
    params.actorId,
  )
  if (!binding.bound) {
    return await repairAndBlock(deps, params, ctx, checkpoint, [
      { stage: 'close-binding', reason: binding.reason },
    ])
  }
  const marked = await deps.checkpoint.markMapClosed(binding.closingEventId)
  if (marked.kind !== 'ok') {
    return {
      kind: 'outcome',
      outcome: storeFailure('persisting the confirmed map close', marked, 'confirmed'),
    }
  }

  // --- §15 steps 9–11 ------------------------------------------------------

  return await recordCompletion(deps, params, ctx, marked.value)
}

/**
 * §15 step 6 under the lock: the stable map read and classification (with
 * the §11.3 release-adopt-reacquire dance for a Compatible Map Extension),
 * every member's Completed Ticket evidence, and the unchanged target. A
 * non-`undefined` return stops the attempt.
 */
async function stabilizeForClose(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  ctx: ProtocolContext,
  gates: SealedGates,
): Promise<ProtocolSignal | undefined> {
  for (;;) {
    const mapRead = await readStableMap(deps, params, ctx, 'stabilize')
    if ('outcome' in mapRead) return { kind: 'outcome', outcome: mapRead.outcome }
    const snapshot = mapRead.snapshot
    if (snapshot.state !== 'OPEN') {
      return {
        kind: 'outcome',
        outcome: changedInput(ctx.sharedWrite, [
          { stage: 'map-state', mapState: snapshot.state, mapRevision: snapshot.mapRevision },
        ]),
      }
    }

    const classification = classifyMapChange(acceptedSnapshotFrom(ctx.lineage.accepted, params.map), snapshot)
    if (classification.kind === 'incompatible') {
      return {
        kind: 'outcome',
        outcome: changedInput(ctx.sharedWrite, [
          { stage: 'map-classification', kind: 'incompatible', reasons: classification.reasons },
        ]),
      }
    }
    if (classification.kind === 'compatible-extension') {
      // §15 step 7: the extension invalidates this attempt. Dance: release
      // the lock, adopt, reacquire, re-read — then return to planning when
      // an added Ticket is not already a valid Completed Ticket, and restart
      // completion otherwise.
      const payload = snapshotMapPayload(snapshot)
      if (payload.revision !== snapshot.mapRevision) {
        return {
          kind: 'outcome',
          outcome: completionError(
            'map-read',
            'the current snapshot does not re-hash to its revision',
            [{ mapRevision: snapshot.mapRevision }],
            ctx.sharedWrite,
          ),
        }
      }
      const extension: ShipExtensionAdoption = {
        revision: snapshot.mapRevision,
        payload: payload.payload,
        fromRevision: ctx.lineage.accepted.revision,
        addedTicketIssueIds: classification.addedTicketIssueIds,
      }
      const danced = await releaseAdoptReacquire(deps, ctx, extension)
      if (danced !== undefined) return danced
      const cleared = await deps.checkpoint.clear()
      if (cleared.kind !== 'ok') {
        return {
          kind: 'outcome',
          outcome: storeFailure('discarding the invalidated completion gates', cleared, ctx.sharedWrite),
        }
      }
      return await decideAddedTickets(deps, params, extension)
    }

    // Identical revision: every member's Completed Ticket evidence (§14).
    const memberFailure = await collectMemberCompletion(deps, params, snapshot)
    if (memberFailure !== undefined) {
      return { kind: 'outcome', outcome: memberFailure }
    }

    // §15 steps 6–8: only when the target is unchanged may the close proceed.
    const target = await fetchedTargetSha(deps, params, ctx)
    if ('outcome' in target) return { kind: 'outcome', outcome: target.outcome }
    if (target.sha !== gates.completionSha) {
      const cleared = await deps.checkpoint.clear()
      if (cleared.kind !== 'ok') {
        return {
          kind: 'outcome',
          outcome: storeFailure('discarding the stale completion gates', cleared, ctx.sharedWrite),
        }
      }
      return { kind: 'restart' }
    }
    return undefined
  }
}

/**
 * The release-adopt-reacquire dance (§11.3, §16): the target lock is released
 * before the repository control lock is taken for extension adoption, then
 * reacquired. On success the protocol context's accepted lineage advances.
 */
async function releaseAdoptReacquire(
  deps: MapCompletionDeps,
  ctx: ProtocolContext,
  extension: ShipExtensionAdoption,
): Promise<ProtocolSignal | undefined> {
  const lock = ctx.lock
  ctx.lock = undefined
  if (lock === undefined) {
    return {
      kind: 'outcome',
      outcome: completionError('lock-failed', 'the target lock is not held for the extension dance', [], 'none'),
    }
  }
  const released = await lock.release()
  if (released.kind !== 'ok') {
    return {
      kind: 'outcome',
      outcome: completionError('lock-failed', released.reason, [], ctx.sharedWrite),
    }
  }
  const adopted = await deps.adoptExtension(extension)
  // Reacquire regardless of the adoption outcome so the protocol either
  // continues under the lock or unwinds with it released by the caller.
  const reacquired = await deps.lock.acquire()
  if (reacquired.kind !== 'ok') {
    return {
      kind: 'outcome',
      outcome: completionError(
        'lock-failed',
        `reacquiring the target lock after extension adoption failed: ${reacquired.reason}`,
        [],
        ctx.sharedWrite,
      ),
    }
  }
  ctx.lock = reacquired.value
  if (adopted.kind === 'blocked') {
    // §7.4: a blocked added-Ticket preflight prevents adoption and is
    // treated as an incompatible change.
    return {
      kind: 'outcome',
      outcome: changedInput(ctx.sharedWrite, [
        { stage: 'extension-adoption', reason: adopted.reason, kind: 'blocked' },
      ]),
    }
  }
  if (adopted.kind !== 'ok') {
    return {
      kind: 'outcome',
      outcome: storeFailure('adopting the Compatible Map Extension', adopted, ctx.sharedWrite),
    }
  }
  ctx.lineage.accepted = {
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

/**
 * §15 step 7's decision after an adopted extension: when every added Ticket
 * is already a valid Completed Ticket the complete completion check restarts
 * against the new revision; otherwise execution returns to Wave planning.
 */
async function decideAddedTickets(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  extension: ShipExtensionAdoption,
): Promise<ProtocolSignal> {
  const snapshotRead = await deps.readMap()
  if (snapshotRead.kind !== 'ok') {
    return {
      kind: 'outcome',
      outcome:
        snapshotRead.kind === 'error'
          ? completionError('map-read', snapshotRead.reason, [...snapshotRead.evidence], 'none')
          : changedInput(initialSharedWrite(params), [
              { stage: 'post-adoption-map-read', code: snapshotRead.code, reason: snapshotRead.reason },
            ]),
    }
  }
  const snapshot = snapshotRead.value
  for (const issueId of extension.addedTicketIssueIds) {
    const ticket = snapshot.tickets.find((entry) => entry.ref.issueId === issueId)
    if (ticket === undefined) continue
    const completion = await evaluateMemberCompletion(deps, params, ticket)
    if ('outcome' in completion) return { kind: 'outcome', outcome: completion.outcome }
    if (completion.status !== 'completed') return { kind: 'replan' }
  }
  return { kind: 'restart' }
}

/**
 * §15 steps 9–11, run while still holding the target lock: re-read
 * everything, seal and write-or-reuse the record bound to the closing event,
 * then validate terminal completion.
 */
async function recordCompletion(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  ctx: ProtocolContext,
  checkpoint: MapCompletionCheckpoint,
): Promise<ProtocolSignal> {
  // --- step 9: re-read everything under the lock ---------------------------

  const mapRead = await readStableMap(deps, params, ctx, 'post-close')
  if ('outcome' in mapRead) return { kind: 'outcome', outcome: mapRead.outcome }
  const snapshot = mapRead.snapshot
  if (snapshot.state !== 'CLOSED' || snapshot.mapRevision !== checkpoint.mapRevision) {
    // A reopened or revised map: repair, then adopt an extension or block.
    return await repairForChangedMap(deps, params, ctx, checkpoint, snapshot)
  }

  const members = new Map<string, 'completed' | readonly DeliveryEvidenceFinding[]>()
  const memberFailure = await collectMemberCompletion(deps, params, snapshot, members)
  if (memberFailure !== undefined) {
    return await repairAndBlock(deps, params, ctx, checkpoint, [
      { stage: 'post-close-member-completion' },
      ...memberFailure.evidence,
    ])
  }

  const target = await fetchedTargetSha(deps, params, ctx)
  if ('outcome' in target) return { kind: 'outcome', outcome: target.outcome }
  const containsCompletion = await deps.facts.isAncestorOfTarget(
    stripOid(checkpoint.completionSha),
    params.targetBranch,
  )
  if (containsCompletion.kind !== 'ok') {
    return {
      kind: 'outcome',
      outcome: completionError('target-read', containsCompletion.reason, [...containsCompletion.evidence], ctx.sharedWrite),
    }
  }
  if (target.sha !== checkpoint.completionSha || !containsCompletion.value) {
    // Any target movement before the record is written repairs the close;
    // completion restarts against the new target (§15 step 9).
    const repaired = await repairClose(deps, params, ctx, checkpoint, [
      { stage: 'post-close-target-moved', completionSha: checkpoint.completionSha, targetSha: target.sha },
    ])
    if ('outcome' in repaired) return { kind: 'outcome', outcome: repaired.outcome }
    return { kind: 'restart' }
  }

  // --- step 10: seal, then write or reuse the record comment --------------

  let sealed: MapCompletionRecordV1
  if (checkpoint.record !== undefined) {
    sealed = checkpoint.record
  } else {
    sealed = sealCompletionRecord(params, checkpoint, deps.now?.() ?? agentRecordedAt())
    const stored = await deps.checkpoint.sealRecord(sealed)
    if (stored.kind !== 'ok') {
      return {
        kind: 'outcome',
        outcome: storeFailure('sealing the completion record', stored, 'confirmed'),
      }
    }
  }

  const written = await writeOrReuseRecord(deps, params, ctx, sealed)
  if ('outcome' in written) return { kind: 'outcome', outcome: written.outcome }
  const marked = await deps.checkpoint.markRecorded()
  if (marked.kind !== 'ok') {
    return {
      kind: 'outcome',
      outcome: storeFailure('persisting the confirmed completion record', marked, 'confirmed'),
    }
  }

  // --- step 11: final validation over fresh reads --------------------------

  const finalEvidence = await readMapEvidence(deps, params, ctx, 'final-validation')
  if ('outcome' in finalEvidence) return { kind: 'outcome', outcome: finalEvidence.outcome }
  const finalMap = await readStableMap(deps, params, ctx, 'final-validation')
  if ('outcome' in finalMap) return { kind: 'outcome', outcome: finalMap.outcome }
  const finalMembers = new Map<string, 'completed' | readonly DeliveryEvidenceFinding[]>()
  const finalMemberFailure = await collectMemberCompletion(deps, params, finalMap.snapshot, finalMembers)
  if (finalMemberFailure !== undefined) {
    return await repairAndBlock(deps, params, ctx, checkpoint, [
      { stage: 'final-member-completion' },
      ...finalMemberFailure.evidence,
    ])
  }
  const evaluation = await evaluateMapCompletionRecord({
    map: {
      issueId: finalMap.snapshot.ref.issueId,
      repositoryId: finalMap.snapshot.ref.repositoryId,
      state: finalMap.snapshot.state,
      mapRevision: finalMap.snapshot.mapRevision,
    },
    targetBranch: params.targetBranch,
    trustedEvidenceAuthorIds: params.trustedEvidenceAuthorIds,
    evidence: finalEvidence.evidence,
    memberCompletion: finalMembers,
    facts: deps.facts,
  })
  if (evaluation.status === 'error') {
    return {
      kind: 'outcome',
      outcome: completionError('target-read', evaluation.reason, [{ code: evaluation.code }], ctx.sharedWrite),
    }
  }

  const closedAtCheckpoint =
    finalMap.snapshot.state === 'CLOSED' && finalMap.snapshot.mapRevision === checkpoint.mapRevision
  if (evaluation.status === 'valid' && closedAtCheckpoint) {
    return {
      kind: 'completed',
      completionSha: checkpoint.completionSha,
      closingEventId: checkpoint.closingEventId!,
      record: evaluation.record,
      commentWritten: written.written,
      warnings: [...ctx.warnings, ...evaluation.warnings],
      workspace: checkpoint.workspace,
    }
  }

  // §15 step 11 repairs a changed Map, invalid member completion, or loss of
  // completionSha ancestry; a record from the repaired attempt is historical.
  if (finalMap.snapshot.mapRevision !== checkpoint.mapRevision) {
    // A revised map classifies after the repair: an extension adopts and
    // replans or restarts; an incompatible edit blocks (§15).
    return await repairForChangedMap(deps, params, ctx, checkpoint, finalMap.snapshot)
  }
  return await repairAndBlock(deps, params, ctx, checkpoint, [
    { stage: 'final-validation', recordValid: evaluation.status === 'valid' },
    ...(evaluation.status === 'findings' ? [...evaluation.findings] : []),
  ])
}

/**
 * Repair a close made against a changed map (§15 step 9): reopen the map if
 * necessary while still holding the lock, then — with the lock released by
 * the caller — adopt a Compatible Map Extension and replan or restart, or
 * return `blocked(changed-input)` for an incompatible change.
 */
async function repairForChangedMap(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  ctx: ProtocolContext,
  checkpoint: MapCompletionCheckpoint,
  snapshot: TaskMapSnapshot,
): Promise<ProtocolSignal> {
  const repaired = await repairClose(deps, params, ctx, checkpoint, [
    {
      stage: 'post-close-map-changed',
      mapState: snapshot.state,
      mapRevision: snapshot.mapRevision,
      checkpointRevision: checkpoint.mapRevision,
    },
  ])
  if ('outcome' in repaired) return { kind: 'outcome', outcome: repaired.outcome }

  const classification = classifyMapChange(acceptedSnapshotFrom(ctx.lineage.accepted, params.map), snapshot)
  if (classification.kind === 'compatible-extension') {
    const payload = snapshotMapPayload(snapshot)
    return {
      kind: 'adopt-extension',
      extension: {
        revision: snapshot.mapRevision,
        payload: payload.payload,
        fromRevision: ctx.lineage.accepted.revision,
        addedTicketIssueIds: classification.addedTicketIssueIds,
      },
      sharedWrite: ctx.sharedWrite,
    }
  }
  if (classification.kind === 'incompatible') {
    return {
      kind: 'outcome',
      outcome: changedInput(ctx.sharedWrite, [
        { stage: 'map-classification', kind: 'incompatible', reasons: classification.reasons },
      ]),
    }
  }
  return { kind: 'restart' }
}

/**
 * The §15 repair: reopen the Map if it is currently closed — while still
 * holding the target lock — and discard the repaired attempt's gates. The
 * record of that attempt is historical because its closing event is no
 * longer current or its Map revision no longer matches.
 */
async function repairClose(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  ctx: ProtocolContext,
  checkpoint: MapCompletionCheckpoint,
  evidence: readonly Evidence[],
): Promise<{ readonly repaired: true } | { readonly outcome: MapCompletionOutcome }> {
  ctx.sharedWrite = 'confirmed'
  const mapRead = await deps.readMap()
  let mapClosed: boolean
  if (mapRead.kind !== 'ok') {
    // The current state cannot be proved: the close is conservatively
    // reopened when its checkpoint already confirmed it.
    mapClosed = checkpoint.stage !== 'gated'
  } else {
    mapClosed = mapRead.value.state === 'CLOSED'
  }
  if (mapClosed) {
    const reopened = await deps.writer.reopenIssue(locatorOf(params.map))
    if (reopened.kind !== 'ok') {
      return {
        outcome: completionError(
          'issue-reopen',
          `the stale map close could not be repaired: the reopen returned an unknown result: ${reopened.reason}`,
          [...reopened.evidence, ...evidence],
          'unknown',
        ),
      }
    }
  }
  const cleared = await deps.checkpoint.clear()
  if (cleared.kind !== 'ok') {
    return { outcome: storeFailure('discarding the repaired attempt gates', cleared, 'confirmed') }
  }
  if (checkpoint.record !== undefined) {
    ctx.warnings.push(
      `the completion record of attempt ${checkpoint.completionAttemptId} is historical: ` +
        'its closing event is no longer the current one',
    )
  }
  return { repaired: true }
}

/** Repair, then end the run `blocked(changed-input)` with the writes recorded. */
async function repairAndBlock(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  ctx: ProtocolContext,
  checkpoint: MapCompletionCheckpoint,
  evidence: readonly Evidence[],
): Promise<ProtocolSignal> {
  const repaired = await repairClose(deps, params, ctx, checkpoint, evidence)
  if ('outcome' in repaired) return { kind: 'outcome', outcome: repaired.outcome }
  return {
    kind: 'outcome',
    outcome: changedInput(ctx.sharedWrite, [
      ...evidence,
      { repair: 'reopened', completionAttemptId: checkpoint.completionAttemptId },
      ...(checkpoint.record !== undefined
        ? [{ historicalCompletionId: checkpoint.record.completionId }]
        : []),
    ]),
  }
}

// ---------------------------------------------------------------------------
// §14 member validation under the completion protocol
// ---------------------------------------------------------------------------

/**
 * §15 steps 6 and 9: every current member must be a valid Completed Ticket
 * under the complete §14 predicate, evaluated over one complete evidence
 * read per member against the fetched remote target. When `into` is given,
 * every member's verdict is recorded for the §15 rule-4 predicate; a
 * non-`undefined` return is the failure to report.
 */
async function collectMemberCompletion(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  snapshot: TaskMapSnapshot,
  into?: Map<string, 'completed' | readonly DeliveryEvidenceFinding[]>,
): Promise<CompletionFailure | undefined> {
  const fetched = await deps.facts.fetchTarget(params.targetBranch)
  if (fetched.kind !== 'ok') {
    return completionError('target-read', `fetching the target failed: ${fetched.reason}`, [...fetched.evidence], 'none')
  }
  const failures: Evidence[] = []
  for (const ticket of snapshot.tickets) {
    const read = await deps.readIssueEvidence(locatorOf(ticket.ref))
    if (read.kind === 'error') {
      return completionError(
        'evidence-read',
        `reading delivery evidence of member #${ticket.ref.number} failed: ${read.reason}`,
        [{ ticketIssueId: ticket.ref.issueId }, ...read.evidence],
        'none',
      )
    }
    if (read.kind === 'blocked') {
      return changedInput(initialSharedWrite(params), [
        {
          stage: 'member-evidence-read',
          ticketIssueId: ticket.ref.issueId,
          code: read.code,
          reason: read.reason,
        },
      ])
    }
    const evaluation = await evaluateDeliveryEvidence({
      map: {
        issueId: snapshot.ref.issueId,
        repositoryId: snapshot.ref.repositoryId,
      },
      ticket: {
        issueId: ticket.ref.issueId,
        state: ticket.state,
        ticketRevision: ticket.ticketRevision,
      },
      targetBranch: params.targetBranch,
      trustedEvidenceAuthorIds: params.trustedEvidenceAuthorIds,
      evidence: read.value,
      facts: deps.facts,
    })
    if (evaluation.status === 'error') {
      return completionError(
        'target-read',
        `validating member #${ticket.ref.number} failed: ${evaluation.reason}`,
        [{ ticketIssueId: ticket.ref.issueId, code: evaluation.code }],
        'none',
      )
    }
    if (evaluation.status === 'completed') {
      into?.set(ticket.ref.issueId, 'completed')
      continue
    }
    const findings: readonly DeliveryEvidenceFinding[] =
      evaluation.status === 'no-record' ? [{ code: 'no-valid-record' }] : [...evaluation.findings]
    into?.set(ticket.ref.issueId, findings)
    failures.push({
      stage: 'member-completion',
      ticketIssueId: ticket.ref.issueId,
      ticketState: ticket.state,
      status: evaluation.status,
      findings,
    })
  }
  if (failures.length > 0) {
    return changedInput(initialSharedWrite(params), [
      { stage: 'member-completion', count: failures.length },
      ...failures,
    ])
  }
  return undefined
}

/** One member's evaluation, for the added-ticket decision of §15 step 7. */
async function evaluateMemberCompletion(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  ticket: TaskMapSnapshot['tickets'][number],
): Promise<
  | { readonly status: 'completed' }
  | { readonly status: 'not-completed' }
  | { readonly outcome: CompletionFailure }
> {
  const read = await deps.readIssueEvidence(locatorOf(ticket.ref))
  if (read.kind === 'error') {
    return {
      outcome: completionError(
        'evidence-read',
        `reading delivery evidence of added ticket #${ticket.ref.number} failed: ${read.reason}`,
        [{ ticketIssueId: ticket.ref.issueId }],
        'none',
      ),
    }
  }
  if (read.kind === 'blocked') {
    return {
      outcome: changedInput(initialSharedWrite(params), [
        { stage: 'added-ticket-evidence-read', ticketIssueId: ticket.ref.issueId, code: read.code },
      ]),
    }
  }
  const fetched = await deps.facts.fetchTarget(params.targetBranch)
  if (fetched.kind !== 'ok') {
    return { outcome: completionError('target-read', fetched.reason, [...fetched.evidence], 'none') }
  }
  const evaluation = await evaluateDeliveryEvidence({
    map: {
      issueId: params.map.issueId,
      repositoryId: params.map.repositoryId,
    },
    ticket: {
      issueId: ticket.ref.issueId,
      state: ticket.state,
      ticketRevision: ticket.ticketRevision,
    },
    targetBranch: params.targetBranch,
    trustedEvidenceAuthorIds: params.trustedEvidenceAuthorIds,
    evidence: read.value,
    facts: deps.facts,
  })
  if (evaluation.status === 'error') {
    return {
      outcome: completionError(
        'target-read',
        `validating added ticket #${ticket.ref.number} failed: ${evaluation.reason}`,
        [{ ticketIssueId: ticket.ref.issueId, code: evaluation.code }],
        'none',
      ),
    }
  }
  return evaluation.status === 'completed' ? { status: 'completed' } : { status: 'not-completed' }
}

// ---------------------------------------------------------------------------
// Reads and the sealed record
// ---------------------------------------------------------------------------

/** The evidence locator of one issue reference. */
function locatorOf(ref: {
  readonly githubHost: string
  readonly number: number
  readonly url: string
}): EvidenceIssueLocator {
  return { githubHost: ref.githubHost, number: ref.number, url: ref.url }
}

/** One stable map read mapped onto the protocol's outcome vocabulary. */
async function readStableMap(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  ctx: ProtocolContext,
  stage: string,
): Promise<{ readonly snapshot: TaskMapSnapshot } | { readonly outcome: MapCompletionOutcome }> {
  void params
  const read = await deps.readMap()
  if (read.kind === 'error') {
    return { outcome: completionError('map-read', read.reason, [...read.evidence], ctx.sharedWrite) }
  }
  if (read.kind === 'blocked') {
    return {
      outcome: changedInput(ctx.sharedWrite, [
        { stage, code: read.code, reason: read.reason },
        ...read.evidence,
      ]),
    }
  }
  return { snapshot: read.value }
}

/** One complete evidence read of the map issue (§14), or its failure. */
async function readMapEvidence(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  ctx: ProtocolContext,
  stage: string,
): Promise<{ readonly evidence: IssueEvidenceRead } | { readonly outcome: MapCompletionOutcome }> {
  const read = await deps.readIssueEvidence(locatorOf(params.map))
  if (read.kind === 'error') {
    return {
      outcome: completionError('evidence-read', read.reason, [{ stage }, ...read.evidence], ctx.sharedWrite),
    }
  }
  if (read.kind === 'blocked') {
    return {
      outcome: changedInput(ctx.sharedWrite, [{ stage, code: read.code, reason: read.reason }, ...read.evidence]),
    }
  }
  return { evidence: read.value }
}

/** The timeline anchor: the last fully paginated item, or `null` when empty. */
async function readTimelineAnchor(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  ctx: ProtocolContext,
): Promise<{ readonly anchorEventId: string | null } | { readonly outcome: MapCompletionOutcome }> {
  const read = await readMapEvidence(deps, params, ctx, 'anchor')
  if ('outcome' in read) return { outcome: read.outcome }
  const last = read.evidence.timeline.at(-1)
  return { anchorEventId: last === undefined ? null : last.eventId }
}

/** Fetch the target and read its current tip SHA. */
async function fetchedTargetSha(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  ctx: ProtocolContext,
): Promise<{ readonly sha: string } | { readonly outcome: MapCompletionOutcome }> {
  const fetched = await deps.facts.fetchTarget(params.targetBranch)
  if (fetched.kind !== 'ok') {
    return { outcome: completionError('target-read', fetched.reason, [...fetched.evidence], ctx.sharedWrite) }
  }
  const sha = await deps.facts.targetSha(params.targetBranch)
  if (sha.kind !== 'ok') {
    return { outcome: completionError('target-read', sha.reason, [...sha.evidence], ctx.sharedWrite) }
  }
  return { sha: sha.value }
}

/** Seal the exact completion record of one checkpoint, `completionId` included. */
function sealCompletionRecord(
  params: MapCompletionParams,
  checkpoint: MapCompletionCheckpoint,
  recordedAt: string,
): MapCompletionRecordV1 {
  const draft: Omit<MapCompletionRecordV1, 'completionId'> = {
    schema: MAP_COMPLETION_RECORD_SCHEMA,
    run: {
      id: params.runId,
      completionAttemptId: checkpoint.completionAttemptId,
      configRevision: params.configRevision,
      nornVersion: params.nornVersion,
    },
    gate: checkpoint.gate,
    map: {
      issueId: params.map.issueId,
      revision: checkpoint.mapRevision,
      closingEventId: checkpoint.closingEventId!,
    },
    target: {
      repositoryId: params.map.repositoryId,
      branch: params.targetBranch,
      completionSha: checkpoint.completionSha,
      treeOid: checkpoint.treeOid,
    },
    review: checkpoint.review,
    tests: [...checkpoint.tests],
    actorId: params.actorId,
    recordedAt,
  }
  return { ...draft, completionId: computeCompletionId(draft) }
}

// ---------------------------------------------------------------------------
// §15 step 10: write or reuse the completion record comment (§14 rules)
// ---------------------------------------------------------------------------

/**
 * Write the sealed completion record comment or reuse its byte-identical
 * canonical copy (§14 rules, applied to the map issue): the fully-paginated
 * comments are scanned for the sealed `completionId`; identical canonical
 * records are reused (duplicates warn), while the same ID with divergent
 * content — or any malformed marked comment — is integrity-blocking before
 * anything else is written.
 */
async function writeOrReuseRecord(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  ctx: ProtocolContext,
  sealed: MapCompletionRecordV1,
): Promise<{ readonly written: boolean } | { readonly outcome: MapCompletionOutcome }> {
  const scan = await readMapEvidence(deps, params, ctx, 'record-scan')
  if ('outcome' in scan) return { outcome: scan.outcome }

  const sealedText = canonicalJson(sealed as unknown as CanonicalJsonValue)
  const identical: string[] = []
  const divergent: string[] = []
  const invalidMarked: { commentId: string; reason: string }[] = []
  for (const comment of scan.evidence.comments) {
    const envelope = parseRecordEnvelope(comment.body)
    if (envelope.kind === 'unmarked') continue
    if (envelope.kind === 'invalid') {
      invalidMarked.push({ commentId: comment.commentId, reason: envelope.reason })
      continue
    }
    const claimed = (envelope.value as { completionId?: unknown }).completionId
    if (claimed === sealed.completionId) {
      if (envelope.canonicalText === sealedText) {
        identical.push(comment.commentId)
      } else {
        divergent.push(comment.commentId)
      }
    }
  }
  if (divergent.length > 0 || invalidMarked.length > 0) {
    return {
      outcome: changedInput(ctx.sharedWrite, [{ stage: 'record-scan', divergent, invalidMarked }]),
    }
  }

  if (identical.length > 0) {
    if (identical.length > 1) {
      ctx.warnings.push(
        `duplicate byte-identical completion comments count as one record: ${identical.join(', ')}`,
      )
    }
    return { written: false }
  }

  const written = await deps.writer.writeIssueComment(
    locatorOf(params.map),
    formatRecordEnvelope(sealedText),
  )
  if (written.kind !== 'ok') {
    return {
      outcome: completionError(
        'comment-write',
        `writing the completion record comment returned an unknown result: ${written.reason}`,
        [...written.evidence, { completionId: sealed.completionId }],
        'unknown',
      ),
    }
  }
  return { written: true }
}

// ---------------------------------------------------------------------------
// §13.4: map-completion recovery reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile one persisted completion checkpoint (§13.4): under the target
 * lock, the stable map, the remote target, the current closing event, and
 * any matching completion comment decide between retrying the close
 * protocol, completing the post-close reads, repairing a stale close, or
 * discarding the gates and restarting. Recovery never guesses from the
 * checkpoint stage alone — every decision re-reads remote truth.
 */
async function reconcileCheckpoint(
  deps: MapCompletionDeps,
  params: MapCompletionParams,
  checkpoint: MapCompletionCheckpoint,
  adopted: MapCompletionAdoption[],
  warnings: string[],
  lineage: { accepted: AcceptedMapRevision },
): Promise<ProtocolSignal> {
  const acquired = await deps.lock.acquire()
  if (acquired.kind !== 'ok') {
    return {
      kind: 'outcome',
      outcome: completionError('lock-failed', `acquiring the target lock failed: ${acquired.reason}`, [], 'none'),
    }
  }
  const ctx: ProtocolContext = {
    lock: acquired.value,
    lineage,
    adopted,
    warnings,
    sharedWrite: params.alreadyShipped ? 'confirmed' : 'none',
  }
  try {
    const mapRead = await readStableMap(deps, params, ctx, 'reconcile-map')
    if ('outcome' in mapRead) return { kind: 'outcome', outcome: mapRead.outcome }
    const snapshot = mapRead.snapshot
    const evidence = await readMapEvidence(deps, params, ctx, 'reconcile-evidence')
    if ('outcome' in evidence) return { kind: 'outcome', outcome: evidence.outcome }
    const target = await fetchedTargetSha(deps, params, ctx)
    if ('outcome' in target) return { kind: 'outcome', outcome: target.outcome }

    if (snapshot.state === 'OPEN') {
      // §13.4 rule 1: a detected reopen discards the old gates and restarts
      // full completion rather than silently reclosing.
      if (closeThenReopenAfter(evidence.evidence.timeline, checkpoint.timelineAnchorEventId)) {
        const cleared = await deps.checkpoint.clear()
        if (cleared.kind !== 'ok') {
          return {
            kind: 'outcome',
            outcome: storeFailure('discarding reopened completion gates', cleared, ctx.sharedWrite),
          }
        }
        return { kind: 'restart' }
      }
      if (snapshot.mapRevision !== checkpoint.mapRevision || target.sha !== checkpoint.completionSha) {
        // Stale gates: discard, release the lock (the caller's finally), then
        // adopt, restart, or block per the ordinary rules (§13.4 rule 1).
        const cleared = await deps.checkpoint.clear()
        if (cleared.kind !== 'ok') {
          return {
            kind: 'outcome',
            outcome: storeFailure('discarding stale completion gates', cleared, ctx.sharedWrite),
          }
        }
        return classifyAfterDiscard(params, ctx, snapshot)
      }
      // Revision and target still equal the checkpoint: retry the close
      // protocol of §15 from the persisted gates (steps 6–11).
      return await closeAndRecord(deps, params, gatesOf(checkpoint), checkpoint, ctx)
    }

    // §13.4 rule 2: the map is CLOSED — bind it to the checkpoint only when
    // the current closing event is the authenticated actor's first close
    // after the anchor and no reopen follows it.
    const binding = closingEventBinding(
      evidence.evidence.timeline,
      checkpoint.timelineAnchorEventId,
      params.actorId,
    )
    if (!binding.bound) {
      // Rule 4: closed against stale facts (or superseded by a foreign
      // close); the record, if any, is historical. Reopen, then replan.
      const repaired = await repairClose(deps, params, ctx, checkpoint, [
        { stage: 'recovery-close-binding', reason: binding.reason },
      ])
      if ('outcome' in repaired) return { kind: 'outcome', outcome: repaired.outcome }
      return classifyAfterDiscard(params, ctx, snapshot)
    }
    if (checkpoint.closingEventId !== undefined && checkpoint.closingEventId !== binding.closingEventId) {
      // The persisted close was superseded within the bound window.
      const repaired = await repairClose(deps, params, ctx, checkpoint, [
        {
          stage: 'recovery-closing-event-moved',
          persisted: checkpoint.closingEventId,
          current: binding.closingEventId,
        },
      ])
      if ('outcome' in repaired) return { kind: 'outcome', outcome: repaired.outcome }
      return classifyAfterDiscard(params, ctx, snapshot)
    }
    let bound: MapCompletionCheckpoint = { ...checkpoint, stage: 'map-closed', closingEventId: binding.closingEventId }

    // Rule 3: a valid current completion record makes the run passed even if
    // the target advanced afterward in a descendant-only way — recovery
    // distinguishes a close whose post-check finished from one that did not.
    const members = new Map<string, 'completed' | readonly DeliveryEvidenceFinding[]>()
    const memberFailure = await collectMemberCompletion(deps, params, snapshot, members)
    if (memberFailure !== undefined) {
      return await repairAndBlock(deps, params, ctx, bound, [
        { stage: 'recovery-member-completion' },
        ...memberFailure.evidence,
      ])
    }
    const evaluation = await evaluateMapCompletionRecord({
      map: {
        issueId: snapshot.ref.issueId,
        repositoryId: snapshot.ref.repositoryId,
        state: snapshot.state,
        mapRevision: snapshot.mapRevision,
      },
      targetBranch: params.targetBranch,
      trustedEvidenceAuthorIds: params.trustedEvidenceAuthorIds,
      evidence: evidence.evidence,
      memberCompletion: members,
      facts: deps.facts,
    })
    if (evaluation.status === 'error') {
      return {
        kind: 'outcome',
        outcome: completionError('target-read', evaluation.reason, [{ code: evaluation.code }], ctx.sharedWrite),
      }
    }
    if (evaluation.status === 'valid') {
      if (checkpoint.closingEventId === undefined) {
        const marked = await deps.checkpoint.markMapClosed(binding.closingEventId)
        if (marked.kind !== 'ok') {
          return { kind: 'outcome', outcome: storeFailure('binding the recovered close', marked, 'confirmed') }
        }
        bound = marked.value
      }
      if (bound.record === undefined) {
        // The valid record must be this attempt's own sealed record.
        if (evaluation.record.run.completionAttemptId !== bound.completionAttemptId) {
          const repaired = await repairClose(deps, params, ctx, bound, [
            {
              stage: 'recovery-foreign-record',
              recordAttemptId: evaluation.record.run.completionAttemptId,
              checkpointAttemptId: bound.completionAttemptId,
            },
          ])
          if ('outcome' in repaired) return { kind: 'outcome', outcome: repaired.outcome }
          return classifyAfterDiscard(params, ctx, snapshot)
        }
        const stored = await deps.checkpoint.sealRecord(evaluation.record)
        if (stored.kind !== 'ok') {
          return { kind: 'outcome', outcome: storeFailure('sealing the recovered record', stored, 'confirmed') }
        }
        bound = stored.value
      }
      if (bound.stage !== 'recorded') {
        const recorded = await deps.checkpoint.markRecorded()
        if (recorded.kind !== 'ok') {
          return { kind: 'outcome', outcome: storeFailure('confirming the recovered record', recorded, 'confirmed') }
        }
      }
      return {
        kind: 'completed',
        completionSha: evaluation.record.target.completionSha,
        closingEventId: binding.closingEventId,
        record: evaluation.record,
        commentWritten: false,
        warnings: [...ctx.warnings, ...evaluation.warnings],
        workspace: bound.workspace,
      }
    }

    // No valid current record: either the record was never written (complete
    // the post-close protocol now, when the facts still match) or it is
    // invalid and the close repairs.
    if (snapshot.mapRevision === checkpoint.mapRevision && target.sha === checkpoint.completionSha) {
      if (checkpoint.closingEventId === undefined) {
        const marked = await deps.checkpoint.markMapClosed(binding.closingEventId)
        if (marked.kind !== 'ok') {
          return { kind: 'outcome', outcome: storeFailure('binding the recovered close', marked, 'confirmed') }
        }
        bound = marked.value
      }
      return await recordCompletion(deps, params, ctx, bound)
    }

    // Rule 4: the target moved before the record was written, or the map was
    // revised — the record is historical; repair and replan.
    const repaired = await repairClose(deps, params, ctx, bound, [
      {
        stage: 'recovery-stale-facts',
        mapRevision: snapshot.mapRevision,
        checkpointRevision: checkpoint.mapRevision,
        targetSha: target.sha,
        completionSha: checkpoint.completionSha,
      },
    ])
    if ('outcome' in repaired) return { kind: 'outcome', outcome: repaired.outcome }
    return classifyAfterDiscard(params, ctx, snapshot)
  } finally {
    await releaseContextLock(ctx)
  }
}

/**
 * After a discarded or repaired checkpoint (§13.4 rules 1 and 4): classify
 * the current snapshot against the accepted lineage and adopt an extension
 * (lock released), restart completion, or block on an incompatible change.
 */
function classifyAfterDiscard(
  params: MapCompletionParams,
  ctx: ProtocolContext,
  snapshot: TaskMapSnapshot,
): ProtocolSignal {
  void params
  const classification = classifyMapChange(acceptedSnapshotFrom(ctx.lineage.accepted, params.map), snapshot)
  if (classification.kind === 'compatible-extension') {
    const payload = snapshotMapPayload(snapshot)
    return {
      kind: 'adopt-extension',
      extension: {
        revision: snapshot.mapRevision,
        payload: payload.payload,
        fromRevision: ctx.lineage.accepted.revision,
        addedTicketIssueIds: classification.addedTicketIssueIds,
      },
      sharedWrite: ctx.sharedWrite,
    }
  }
  if (classification.kind === 'identical') return { kind: 'restart' }
  return {
    kind: 'outcome',
    outcome: changedInput(ctx.sharedWrite, [
      { stage: 'recovery-classification', kind: 'incompatible', reasons: classification.reasons },
    ]),
  }
}

/** The sealed gates of one persisted checkpoint, as the close protocol sees them. */
function gatesOf(checkpoint: MapCompletionCheckpoint): SealedGates {
  return {
    completionAttemptId: checkpoint.completionAttemptId,
    workspace: checkpoint.workspace,
    mapRevision: checkpoint.mapRevision,
    completionSha: checkpoint.completionSha,
    treeOid: checkpoint.treeOid,
    gate: checkpoint.gate,
    tests: checkpoint.tests,
    review: checkpoint.review,
  }
}

// ---------------------------------------------------------------------------
// Outcome helpers (§9, §15)
// ---------------------------------------------------------------------------

/** The run-scoped `blocked(map-completion-gate-failed)` of §15. */
function completionGateFailed(
  params: MapCompletionParams,
  gate: 'setup' | 'tests' | 'review',
  index: number | null,
  detail: CanonicalJsonValue,
): Outcome<never, MapCompletionBlockCode, MapCompletionErrorCode> {
  return blocked({
    scope: 'run',
    code: 'map-completion-gate-failed',
    reason:
      `the ${gate} gate of the map completion did not pass; the Map remains open with findings ` +
      '(design.md §15)',
    sharedWrite: params.alreadyShipped ? 'confirmed' : 'none',
    evidence: [{ gate, ...(index === null ? {} : { index }), detail }],
  })
}

/** A non-`ok` outcome of the completion protocol (never `ok`). */
type CompletionFailure = OutcomeBlocked<MapCompletionBlockCode> | OutcomeError<MapCompletionErrorCode>

/** The run-scoped `blocked(changed-input)` of §15, at a known shared-write state. */
function changedInput(
  sharedWrite: 'none' | 'confirmed',
  evidence: readonly Evidence[],
): CompletionFailure {
  return blocked({
    scope: 'run',
    code: 'changed-input',
    reason:
      'the trustworthy facts the map completion depends on changed; the partial shared writes are ' +
      'recorded exactly as established so far (design.md §15)',
    sharedWrite,
    evidence: [...evidence],
  })
}

/** The shared-write state a completion starts with (§15). */
function initialSharedWrite(params: MapCompletionParams): 'none' | 'confirmed' {
  return params.alreadyShipped ? 'confirmed' : 'none'
}

function completionError(
  code: MapCompletionErrorCode,
  reason: string,
  evidence: readonly Evidence[],
  sharedWrite: 'none' | 'confirmed' | 'unknown',
): CompletionFailure {
  return error({ scope: 'run', code, reason, sharedWrite, evidence: [...evidence] })
}

/**
 * A checkpoint-store failure after remotely confirmed writes is an error
 * following a confirmed shared write — recoverable, never terminal (§9).
 */
function storeFailure(
  what: string,
  failure: Outcome<never, never, MapCompletionStoreErrorCode>,
  sharedWrite: 'none' | 'confirmed',
): CompletionFailure {
  if (failure.kind === 'ok') throw new TypeError('a store failure was ok')
  return error({
    scope: 'run',
    code: failure.code,
    reason: `${what} failed: ${failure.reason}`,
    sharedWrite,
    evidence: [...failure.evidence],
  })
}

/** Strip an object OID to raw hex; identity when already raw. */
function stripOid(oid: string): string {
  const separator = oid.indexOf(':')
  return separator === -1 ? oid : oid.slice(separator + 1)
}
