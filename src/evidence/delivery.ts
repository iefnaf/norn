/**
 * Delivery Record validation and the Completed Ticket predicate
 * (design.md §14).
 *
 * Pure validation core plus one injectable Git-facts seam. Everything over
 * issue comments and timelines operates on one complete
 * `IssueEvidenceRead` — the caller followed every pagination cursor before
 * deciding uniqueness or chronology. Git integration facts (the fetched
 * target tip, commit trees and parents, ancestry) cross an injectable
 * `DeliveryTargetFacts` seam so tests stay deterministic with no network and
 * no Git binary.
 *
 * Every predicate violation produces its own typed finding, and all
 * independently discoverable findings accumulate before the evaluation
 * answers.
 */
import { GIT_OBJECT_OID_PATTERN } from '../agents/completion.ts'
import { canonicalJsonDigest, isSha256Digest } from '../core/digest.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'
import { isCanonicalJsonValue } from '../core/canonical-json.ts'
import type { Sha256Digest } from '../core/digest.ts'
import type { Outcome } from '../core/outcome.ts'
import type {
  DeliveryRecordV1,
  TestEvidence,
} from '../runstate/types.ts'
import { parseRecordEnvelope } from './envelope.ts'
import type { IssueEvidenceRead } from './read.ts'

export const DELIVERY_RECORD_SCHEMA = 'norn-delivery:v1' as const

/** `recordedAt` format: UTC RFC 3339 with exactly three fractional digits (§14). */
export const NORN_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * `deliveryId` is SHA-256 over RFC 8785 canonical JSON of the complete
 * record except `deliveryId` (§14). The sealed record persists verbatim and
 * every replay reuses it, so recomputation must reproduce it exactly.
 */
export function computeDeliveryId(
  record: Omit<DeliveryRecordV1, 'deliveryId'>,
): Sha256Digest {
  return canonicalJsonDigest(record as unknown as CanonicalJsonValue)
}

/** Recompute the sealed ID from a parsed record value; `undefined` when unhashable. */
function recomputeDeliveryId(value: CanonicalJsonValue): Sha256Digest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const rest: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  delete rest.deliveryId
  if (!isCanonicalJsonValue(rest)) return undefined
  try {
    return canonicalJsonDigest(rest)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Structural validation of the §14 record schema
// ---------------------------------------------------------------------------

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
    problems.push(`${where} must be an object-format Git OID (${GIT_OBJECT_OID_PATTERN})`)
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
      if (!nonEmptyString(entry[field])) problems.push(`${where}.${role}.${field} must be a non-empty string`)
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
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((argument) => nonEmptyString(argument))
    ) {
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

function checkReviewStructure(review: unknown, where: string, problems: string[]): void {
  if (!isPlainObject(review)) {
    problems.push(`${where} must be a review evidence object`)
    return
  }
  if (review.phase !== 'work' && review.phase !== 'ship') {
    problems.push(`${where}.phase must be "work" or "ship"`)
  }
  for (const field of ['provider', 'model', 'family', 'thinking'] as const) {
    if (!nonEmptyString(review[field])) problems.push(`${where}.${field} must be a non-empty string`)
  }
  if (review.verdict !== 'pass') problems.push(`${where}.verdict must be "pass"`)
  checkDigest(review.mapRevision, `${where}.mapRevision`, problems)
  checkDigest(review.ticketRevision, `${where}.ticketRevision`, problems)
  checkObjectOid(review.baseSha, `${where}.baseSha`, problems)
  checkObjectOid(review.treeOid, `${where}.treeOid`, problems)
  checkDigest(review.testEvidenceDigest, `${where}.testEvidenceDigest`, problems)
}

function checkTestsStructure(tests: unknown, where: string, problems: string[]): void {
  if (!Array.isArray(tests) || tests.length === 0) {
    problems.push(`${where} must be a non-empty array of test evidence`)
    return
  }
  tests.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      problems.push(`${where}[${index}] must be an object`)
      return
    }
    if (entry.phase !== 'work' && entry.phase !== 'ship' && entry.phase !== 'map-completion') {
      problems.push(`${where}[${index}].phase must be "work", "ship", or "map-completion"`)
    }
    if (
      typeof entry.testIndex !== 'number' ||
      !Number.isInteger(entry.testIndex) ||
      entry.testIndex < 0
    ) {
      problems.push(`${where}[${index}].testIndex must be an integer >= 0`)
    }
    if (
      !Array.isArray(entry.argv) ||
      entry.argv.length === 0 ||
      !entry.argv.every((argument) => nonEmptyString(argument))
    ) {
      problems.push(`${where}[${index}].argv must be a non-empty array of non-empty strings`)
    }
    if (
      typeof entry.timeoutMs !== 'number' ||
      !Number.isFinite(entry.timeoutMs) ||
      entry.timeoutMs <= 0
    ) {
      problems.push(`${where}[${index}].timeoutMs must be a number greater than 0`)
    }
    checkObjectOid(entry.baseSha, `${where}[${index}].baseSha`, problems)
    checkObjectOid(entry.treeOid, `${where}[${index}].treeOid`, problems)
    if (entry.exitCode !== 0) problems.push(`${where}[${index}].exitCode must be 0`)
    checkDigest(entry.outputDigest, `${where}[${index}].outputDigest`, problems)
  })
}

/**
 * Structural problems of one parsed value against the `DeliveryRecordV1`
 * schema of §14. An empty list means the value is a well-formed record;
 * predicate-level binding checks (gate match, tests, integration shape)
 * are separate findings.
 */
export function deliveryRecordProblems(value: unknown): readonly string[] {
  const problems: string[] = []
  if (!isPlainObject(value)) return ['the record must be a JSON object']

  if (value.schema !== DELIVERY_RECORD_SCHEMA) {
    problems.push(`schema must be "${DELIVERY_RECORD_SCHEMA}"`)
  }
  if (!isSha256Digest(value.deliveryId)) problems.push('deliveryId must be a sha256:<hex> digest')

  const run = value.run
  if (isPlainObject(run)) {
    if (!nonEmptyString(run.id)) problems.push('run.id must be a non-empty string')
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
  } else {
    problems.push('map must be an object')
  }

  const ticket = value.ticket
  if (isPlainObject(ticket)) {
    if (!nonEmptyString(ticket.issueId)) {
      problems.push('ticket.issueId must be a non-empty string')
    }
    checkDigest(ticket.revision, 'ticket.revision', problems)
  } else {
    problems.push('ticket must be an object')
  }

  const target = value.target
  if (isPlainObject(target)) {
    if (!nonEmptyString(target.repositoryId)) {
      problems.push('target.repositoryId must be a non-empty string')
    }
    if (!nonEmptyString(target.branch)) problems.push('target.branch must be a non-empty string')
    checkObjectOid(target.baseSha, 'target.baseSha', problems)
    checkObjectOid(target.integratedSha, 'target.integratedSha', problems)
    checkObjectOid(target.treeOid, 'target.treeOid', problems)
  } else {
    problems.push('target must be an object')
  }

  checkReviewStructure(value.review, 'review', problems)
  checkTestsStructure(value.tests, 'tests', problems)

  if (!nonEmptyString(value.actorId)) problems.push('actorId must be a non-empty string')
  if (typeof value.recordedAt !== 'string' || !NORN_TIMESTAMP_PATTERN.test(value.recordedAt)) {
    problems.push('recordedAt must be a UTC RFC 3339 timestamp with three fractional-second digits')
  }
  return problems
}

// ---------------------------------------------------------------------------
// The Git integration-facts seam (design.md §14 predicate 9)
// ---------------------------------------------------------------------------

/** Commit facts the integration-shape checks need. */
export type DeliveryCommitFacts = {
  readonly treeOid: string
  readonly parents: readonly string[]
}

export type DeliveryFactsErrorCode = 'git-unavailable' | 'git-failed'

/**
 * Read-only Git facts about the current target branch, fetched from the
 * remote. `commitFacts` answers `undefined` when the object is absent from
 * the local object store after the fetch.
 */
export type DeliveryTargetFacts = {
  targetSha(branch: string): Promise<Outcome<string, never, DeliveryFactsErrorCode>>
  commitFacts(sha: string): Promise<Outcome<DeliveryCommitFacts | undefined, never, DeliveryFactsErrorCode>>
  isAncestorOfTarget(
    sha: string,
    branch: string,
  ): Promise<Outcome<boolean, never, DeliveryFactsErrorCode>>
}

// ---------------------------------------------------------------------------
// Findings: every predicate violation carries its specific code
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Findings: every predicate violation carries its specific code
// ---------------------------------------------------------------------------

/**
 * One independently discoverable violation of the §14 grammar or Completed
 * Ticket predicate. Codes are machine data; operators act on them through
 * `deliveryRemedies`.
 */
export type DeliveryEvidenceFinding =
  | { readonly code: 'invalid-envelope'; readonly commentId: string; readonly reason: string }
  | { readonly code: 'invalid-record'; readonly commentId: string; readonly problems: readonly string[] }
  | { readonly code: 'delivery-id-mismatch'; readonly commentId: string }
  | {
      readonly code: 'divergent-duplicate'
      readonly deliveryId: string
      readonly commentIds: readonly string[]
    }
  | { readonly code: 'ambiguous-records'; readonly deliveryIds: readonly string[] }
  | { readonly code: 'no-valid-record' }
  | {
      readonly code: 'stale-ticket-revision'
      readonly currentRevision: string
      readonly recordedRevisions: readonly string[]
    }
  | { readonly code: 'ticket-open' }
  | {
      readonly code: 'identity-mismatch'
      readonly detail: 'map' | 'ticket' | 'repository' | 'branch'
      readonly expected: string
      readonly recorded: string
    }
  | { readonly code: 'author-mismatch'; readonly commentAuthorId: string | null; readonly actorId: string }
  | { readonly code: 'untrusted-author'; readonly actorId: string }
  | { readonly code: 'missing-closing-event' }
  | { readonly code: 'record-not-in-timeline'; readonly commentId: string }
  | { readonly code: 'record-after-close'; readonly commentId: string; readonly closingEventId: string }
  | { readonly code: 'invalid-gate'; readonly problems: readonly string[] }
  | { readonly code: 'reviewer-gate-mismatch' }
  | {
      readonly code: 'review-binding-mismatch'
      readonly detail: 'mapRevision' | 'ticketRevision' | 'baseSha' | 'treeOid' | 'testEvidenceDigest'
    }
  | { readonly code: 'tests-gate-mismatch'; readonly problems: readonly string[] }
  | { readonly code: 'wrong-integration-shape'; readonly detail: string }
  | { readonly code: 'integrated-commit-absent'; readonly integratedSha: string }
  | { readonly code: 'not-target-ancestor'; readonly integratedSha: string; readonly targetSha: string }

/** The operator remedies §14 specifies for invalid delivery evidence. */
export type DeliveryRemedy =
  | 'reopen-for-fresh-work'
  | 'remove-from-map'
  | 'restore-recorded-facts'
  | 'reclose-ticket'
  | 'change-ticket-specification'

/**
 * The remedies for one evaluation, per §14: a closed member without valid
 * evidence may be reopened for fresh Work, removed from the Map, or have its
 * recorded facts restored — never retroactively stamped. An open member whose
 * record satisfies every other predicate is reclosed or re-specified, not
 * silently re-worked.
 */
export function deliveryRemedies(
  ticketState: 'OPEN' | 'CLOSED',
  findings: readonly DeliveryEvidenceFinding[],
): readonly DeliveryRemedy[] {
  if (ticketState === 'OPEN') {
    const onlyOpen = findings.length === 1 && findings[0]!.code === 'ticket-open'
    return onlyOpen
      ? ['reclose-ticket', 'change-ticket-specification']
      : ['remove-from-map', 'restore-recorded-facts']
  }
  return ['reopen-for-fresh-work', 'remove-from-map', 'restore-recorded-facts']
}

// ---------------------------------------------------------------------------
// The Completed Ticket predicate
// ---------------------------------------------------------------------------

/** What the evaluation of one member's delivery evidence established. */
export type TicketEvidenceEvaluation =
  | {
      /** Every §14 predicate holds: this is a valid Completed Ticket. */
      readonly status: 'completed'
      readonly record: DeliveryRecordV1
      readonly anchorCommentId: string
      readonly warnings: readonly string[]
    }
  | {
      /** A canonical record exists; `findings` say why it is not a Completed Ticket. */
      readonly status: 'recorded'
      readonly record: DeliveryRecordV1
      readonly anchorCommentId: string
      readonly warnings: readonly string[]
      readonly findings: readonly DeliveryEvidenceFinding[]
    }
  | {
      /** No unambiguous canonical record could be selected; findings say why. */
      readonly status: 'findings'
      readonly findings: readonly DeliveryEvidenceFinding[]
    }
  /** No marked record comment exists on the issue at all. */
  | { readonly status: 'no-record' }
  | { readonly status: 'error'; readonly code: DeliveryFactsErrorCode; readonly reason: string }

/** Everything the predicate needs about the member under evaluation. */
export type DeliveryEvidenceQuery = {
  readonly map: { readonly issueId: string; readonly repositoryId: string }
  readonly ticket: {
    readonly issueId: string
    readonly state: 'OPEN' | 'CLOSED'
    readonly ticketRevision: string
  }
  readonly targetBranch: string
  readonly trustedEvidenceAuthorIds: readonly string[]
  readonly evidence: IssueEvidenceRead
  readonly facts: DeliveryTargetFacts
}

/** One parsed candidate record with its comment provenance. */
type Candidate = {
  readonly commentId: string
  readonly authorId: string | null
  readonly canonicalText: string
  readonly value: CanonicalJsonValue
  readonly record: DeliveryRecordV1
}

/** One logical record: byte-identical duplicate comments collapsed (§14). */
type LogicalRecord = {
  readonly record: DeliveryRecordV1
  readonly copies: readonly { commentId: string; authorId: string | null }[]
}

type ErrorResult = { readonly status: 'error'; readonly code: DeliveryFactsErrorCode; readonly reason: string }

/**
 * Evaluate the complete §14 Completed Ticket predicate for one member:
 * envelope parsing, duplicate selection, identity, authorship, chronology,
 * gate, review, ordered tests, and the fetched-target integration shape.
 * All independently discoverable findings accumulate in one pass.
 */
export async function evaluateDeliveryEvidence(
  query: DeliveryEvidenceQuery,
): Promise<TicketEvidenceEvaluation> {
  const findings: DeliveryEvidenceFinding[] = []
  const warnings: string[] = []
  const trusted = new Set(query.trustedEvidenceAuthorIds)

  // Grammar: parse every comment; prose is ignored, malformed marked
  // comments are rejected with their own finding.
  const candidates: Candidate[] = []
  for (const comment of query.evidence.comments) {
    const envelope = parseRecordEnvelope(comment.body)
    if (envelope.kind === 'unmarked') continue
    if (envelope.kind === 'invalid') {
      findings.push({ code: 'invalid-envelope', commentId: comment.commentId, reason: envelope.reason })
      continue
    }
    const problems = deliveryRecordProblems(envelope.value)
    if (problems.length > 0) {
      findings.push({ code: 'invalid-record', commentId: comment.commentId, problems })
      continue
    }
    const record = envelope.value as unknown as DeliveryRecordV1
    candidates.push({
      commentId: comment.commentId,
      authorId: comment.authorId,
      canonicalText: envelope.canonicalText,
      value: envelope.value,
      record,
    })
  }

  if (candidates.length === 0 && findings.length === 0) return { status: 'no-record' }

  // Duplicate rules: comments are grouped by their claimed `deliveryId` —
  // byte-identical copies collapse into one record, the same claimed ID with
  // divergent canonical content blocks, and only then is the claimed ID
  // checked against recomputation (§14).
  const byDeliveryId = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const group = byDeliveryId.get(candidate.record.deliveryId) ?? []
    group.push(candidate)
    byDeliveryId.set(candidate.record.deliveryId, group)
  }
  const logicalRecords: LogicalRecord[] = []
  for (const [deliveryId, group] of byDeliveryId) {
    const divergent = new Set(group.map((candidate) => candidate.canonicalText))
    if (divergent.size > 1) {
      findings.push({
        code: 'divergent-duplicate',
        deliveryId,
        commentIds: group.map((candidate) => candidate.commentId),
      })
      continue
    }
    const first = group[0]!
    const recomputed = recomputeDeliveryId(first.value)
    if (recomputed === undefined || recomputed !== deliveryId) {
      for (const candidate of group) {
        findings.push({ code: 'delivery-id-mismatch', commentId: candidate.commentId })
      }
      continue
    }
    if (group.length > 1) {
      warnings.push(
        `duplicate byte-identical record comments count as one record: ${group
          .map((candidate) => candidate.commentId)
          .join(', ')}`,
      )
    }
    logicalRecords.push({
      record: group[0]!.record,
      copies: group.map((candidate) => ({
        commentId: candidate.commentId,
        authorId: candidate.authorId,
      })),
    })
  }

  // Selection: records carrying the current Ticket revision; distinct valid
  // records for the same revision are integrity-blocking (§14).
  const currentRecords = logicalRecords.filter(
    (logical) => logical.record.ticket.revision === query.ticket.ticketRevision,
  )
  if (currentRecords.length > 1) {
    findings.push({
      code: 'ambiguous-records',
      deliveryIds: currentRecords.map((logical) => logical.record.deliveryId),
    })
  }
  let selected: LogicalRecord | undefined
  if (currentRecords.length === 1) {
    selected = currentRecords[0]!
  } else if (currentRecords.length === 0 && logicalRecords.length > 0) {
    findings.push({
      code: 'stale-ticket-revision',
      currentRevision: query.ticket.ticketRevision,
      recordedRevisions: logicalRecords.map((logical) => logical.record.ticket.revision),
    })
  }

  if (selected === undefined) return { status: 'findings', findings }
  const record = selected.record

  // Predicate 1: the issue is CLOSED.
  if (query.ticket.state !== 'CLOSED') findings.push({ code: 'ticket-open' })

  // The timeline anchor is the earliest trusted identical copy (§14).
  const trustedCopies = selected.copies.filter(
    (copy) => copy.authorId === record.actorId && trusted.has(record.actorId),
  )
  const anchor = trustedCopies[0] ?? selected.copies[0]!

  // Predicate 4: the comment author equals actorId and is currently trusted.
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

  // Predicate 3: identity and branch match the current Map, member, and Run Config.
  const identity: ReadonlyArray<['map' | 'ticket' | 'repository' | 'branch', string, string]> = [
    ['map', query.map.issueId, record.map.issueId],
    ['ticket', query.ticket.issueId, record.ticket.issueId],
    ['repository', query.map.repositoryId, record.target.repositoryId],
    ['branch', query.targetBranch, record.target.branch],
  ]
  for (const [detail, expected, recorded] of identity) {
    if (expected !== recorded) {
      findings.push({ code: 'identity-mismatch', detail, expected, recorded })
    }
  }

  // Predicate 7: gate structure and families, reviewer match, review bindings.
  const gateProblems: string[] = []
  if (record.gate.worker.family === record.gate.reviewer.family) {
    gateProblems.push(
      `worker and reviewer families must differ (both are "${record.gate.worker.family}")`,
    )
  }
  if (gateProblems.length > 0) findings.push({ code: 'invalid-gate', problems: gateProblems })

  const reviewer = record.gate.reviewer
  const reviewMatchesGate =
    record.review.provider === reviewer.provider &&
    record.review.model === reviewer.model &&
    record.review.family === reviewer.family &&
    record.review.thinking === reviewer.thinking
  if (!reviewMatchesGate) findings.push({ code: 'reviewer-gate-mismatch' })

  const bindings: ReadonlyArray<
    ['mapRevision' | 'ticketRevision' | 'baseSha' | 'treeOid' | 'testEvidenceDigest', string, string]
  > = [
    ['mapRevision', record.map.revision, record.review.mapRevision],
    ['ticketRevision', record.ticket.revision, record.review.ticketRevision],
    ['baseSha', record.target.baseSha, record.review.baseSha],
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

  // Predicate 8: the ordered tests exactly realize the sealed gate tests.
  const testProblems = testPredicateProblems(record)
  if (testProblems.length > 0) findings.push({ code: 'tests-gate-mismatch', problems: testProblems })

  // Predicate 5: the record comment precedes the current closing event.
  if (query.ticket.state === 'CLOSED') {
    const timeline = query.evidence.timeline
    let lastClosed = -1
    let lastReopened = -1
    timeline.forEach((event, index) => {
      if (event.kind === 'closed') lastClosed = index
      if (event.kind === 'reopened') lastReopened = index
    })
    if (lastClosed === -1 || lastReopened > lastClosed) {
      findings.push({ code: 'missing-closing-event' })
    } else {
      const closingEvent = timeline[lastClosed]!
      const commentIndex = timeline.findIndex(
        (event) => event.kind === 'commented' && event.commentId === anchor.commentId,
      )
      if (commentIndex === -1) {
        findings.push({ code: 'record-not-in-timeline', commentId: anchor.commentId })
      } else if (commentIndex > lastClosed) {
        findings.push({
          code: 'record-after-close',
          commentId: anchor.commentId,
          closingEventId: closingEvent.eventId,
        })
      }
    }
  }

  // Predicate 9: integration shape and ancestry against the fetched target.
  const shapeError = await checkIntegrationShape(query, record, findings)
  if (shapeError !== undefined) return shapeError

  if (findings.length === 0) {
    return { status: 'completed', record, anchorCommentId: anchor.commentId, warnings }
  }
  return { status: 'recorded', record, anchorCommentId: anchor.commentId, warnings, findings }
}

/** §14 predicate 8: exactly one entry per sealed gate test, bound to the delivery. */
function testPredicateProblems(record: DeliveryRecordV1): readonly string[] {
  const problems: string[] = []
  const gateTests = record.gate.tests
  const tests = record.tests
  const phase = record.review.phase
  if (tests.length !== gateTests.length) {
    problems.push(
      `the record carries ${tests.length} test entries for ${gateTests.length} sealed gate tests`,
    )
  }
  const count = Math.min(tests.length, gateTests.length)
  for (let index = 0; index < count; index++) {
    const test = tests[index] as TestEvidence
    const gate = gateTests[index]!
    if (test.testIndex !== index) {
      problems.push(`tests[${index}].testIndex must equal its position`)
    }
    if (test.phase !== phase) {
      problems.push(`tests[${index}].phase must equal the review phase "${phase}"`)
    }
    if (test.argv.join('\u0000') !== gate.argv.join('\u0000')) {
      problems.push(`tests[${index}].argv must equal gate test ${index}`)
    }
    if (test.timeoutMs !== gate.timeoutMs) {
      problems.push(`tests[${index}].timeoutMs must equal gate test ${index}`)
    }
    if (test.baseSha !== record.target.baseSha) {
      problems.push(`tests[${index}].baseSha must equal the recorded base`)
    }
    if (test.treeOid !== record.target.treeOid) {
      problems.push(`tests[${index}].treeOid must equal the delivered tree`)
    }
  }
  return problems
}

/** §14 predicate 9: `deliveryId` recomputation, integration shape, and ancestry. */
async function checkIntegrationShape(
  query: DeliveryEvidenceQuery,
  record: DeliveryRecordV1,
  findings: DeliveryEvidenceFinding[],
): Promise<ErrorResult | undefined> {
  const target = await query.facts.targetSha(query.targetBranch)
  if (target.kind !== 'ok') {
    return { status: 'error', code: target.code, reason: target.reason }
  }

  const integrated = await query.facts.commitFacts(record.target.integratedSha)
  if (integrated.kind !== 'ok') {
    return { status: 'error', code: integrated.code, reason: integrated.reason }
  }
  if (integrated.value === undefined) {
    findings.push({ code: 'integrated-commit-absent', integratedSha: record.target.integratedSha })
  } else {
    if (integrated.value.treeOid !== record.target.treeOid) {
      findings.push({
        code: 'wrong-integration-shape',
        detail: 'the integrated commit carries a different tree than the recorded tree',
      })
    }
    const zeroDelta = record.target.integratedSha === record.target.baseSha
    if (!zeroDelta) {
      if (integrated.value.parents.length !== 1 || integrated.value.parents[0] !== record.target.baseSha) {
        findings.push({
          code: 'wrong-integration-shape',
          detail: 'a non-zero delivery must have exactly one parent equal to baseSha',
        })
      }
      const base = await query.facts.commitFacts(record.target.baseSha)
      if (base.kind !== 'ok') {
        return { status: 'error', code: base.code, reason: base.reason }
      }
      if (base.value === undefined) {
        findings.push({
          code: 'wrong-integration-shape',
          detail: 'the recorded base commit is absent from the fetched history',
        })
      } else if (base.value.treeOid === integrated.value.treeOid) {
        findings.push({
          code: 'wrong-integration-shape',
          detail: 'a non-zero delivery must deliver a tree different from the base tree',
        })
      }
    }
  }

  const ancestor = await query.facts.isAncestorOfTarget(record.target.integratedSha, query.targetBranch)
  if (ancestor.kind !== 'ok') {
    return { status: 'error', code: ancestor.code, reason: ancestor.reason }
  }
  if (!ancestor.value) {
    findings.push({
      code: 'not-target-ancestor',
      integratedSha: record.target.integratedSha,
      targetSha: target.value,
    })
  }
  return undefined
}
