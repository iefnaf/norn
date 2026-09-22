/**
 * Run State persistence and integrity (design.md §13.1, §13.2).
 *
 * One versioned document per active map lives at
 * `<repository-home>/maps/<encoded-issue-id>/run-state.json`. Only the
 * coordinator writes it, and every write follows the atomic protocol:
 * temporary file, flush, atomic rename, directory flush — a writer killed at
 * any point leaves the previous or the complete new document, never a torn
 * one.
 *
 * Loading re-establishes every integrity fact before the document is
 * trusted: the full §13.1 checkpoint vocabulary is structurally validated,
 * `wave` must agree with `activeWave.number`, `parkedTickets` must exactly
 * match the parked phase, every accepted revision payload is re-hashed and
 * every recorded transition re-verified, Ship and map-completion checkpoints
 * must agree with their persisted bases and trees, and sealed record IDs
 * recompute exactly. Any violation is one `state-integrity` error — a
 * corrupted document never becomes a new runtime branch.
 */
import { readFileSync, readdirSync } from 'node:fs'

import { error, ok } from '../core/outcome.ts'
import type { Outcome } from '../core/outcome.ts'
import { isCanonicalJsonValue } from '../core/canonical-json.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'
import { canonicalJsonDigest, isSha256Digest } from '../core/digest.ts'
import type { Sha256Digest } from '../core/digest.ts'
import { GIT_OBJECT_OID_PATTERN, isGitObjectOid } from '../agents/completion.ts'
import { MAP_REVISION_SCHEMA } from '../core/revision.ts'
import { mapsDir, runStatePath } from '../config/paths.ts'
import { writeDocumentAtomic } from './atomic-write.ts'
import type { RunState } from './types.ts'
import { RUN_STATE_SCHEMA } from './types.ts'

export type RunStateErrorCode = 'control-store' | 'state-integrity'

export type RunStateSaveOutcome = Outcome<void, never, RunStateErrorCode>
export type RunStateLoadOutcome = Outcome<RunState | undefined, never, RunStateErrorCode>

/** Serialize one Run State document for storage (human-readable, stable order). */
export function runStateToJson(state: RunState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

/**
 * Persist one Run State document atomically (§13.1). Intended for the
 * coordinator only: a second live coordinator for the same map is excluded by
 * the OS-backed map lock, not by this file. The document is integrity-checked
 * before any byte is written, so garbage states never reach disk.
 */
export function saveRunState(
  repositoryHome: string,
  encodedIssueId: string,
  state: RunState,
): RunStateSaveOutcome {
  const checked = checkRunStateIntegrity(state)
  if (checked.kind !== 'ok') return checked
  try {
    writeDocumentAtomic(runStatePath(repositoryHome, encodedIssueId), runStateToJson(state))
    return ok(undefined)
  } catch (cause) {
    return controlStoreError('writing run state', cause)
  }
}

/**
 * Load one Run State document. `ok(undefined)` means no state exists for the
 * map. A document that cannot be read, parsed, or that fails any integrity
 * check is an error — never a fresh or repaired runtime branch.
 */
export function loadRunState(
  repositoryHome: string,
  encodedIssueId: string,
): RunStateLoadOutcome {
  let text: string
  try {
    text = readFileSync(runStatePath(repositoryHome, encodedIssueId), 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ok(undefined)
    return controlStoreError('reading run state', cause)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    return stateIntegrityError([`run-state.json is not valid JSON: ${describe(cause)}`])
  }
  return checkRunStateIntegrity(parsed)
}

/** Load every Run State document under repository home, keyed by encoded issue ID. */
export function loadAllRunStates(
  repositoryHome: string,
): Outcome<ReadonlyMap<string, RunState>, never, RunStateErrorCode> {
  let entries
  try {
    entries = readdirSync(mapsDir(repositoryHome), { withFileTypes: true })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ok(new Map())
    return controlStoreError('listing run states', cause)
  }
  const states = new Map<string, RunState>()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const loaded = loadRunState(repositoryHome, entry.name)
    if (loaded.kind !== 'ok') return loaded
    if (loaded.value !== undefined) states.set(entry.name, loaded.value)
  }
  return ok(states)
}

export type RunStateIntegrityOutcome = Outcome<RunState, never, 'state-integrity'>

/**
 * Validate a parsed Run State document against every load-time integrity rule
 * of §13.1 (and the report rules of §13.2). All independently discoverable
 * violations are reported together.
 */
export function checkRunStateIntegrity(value: unknown): RunStateIntegrityOutcome {
  const violations: string[] = []
  const state = checkRunStateShape(value, violations)
  // Cross-field invariants run only on a structurally valid document; a
  // malformed one already carries its violations.
  if (state !== undefined && violations.length === 0) checkRunStateInvariants(state, violations)
  if (violations.length > 0) return stateIntegrityError(violations)
  return ok(value as RunState)
}

// ---------------------------------------------------------------------------
// Structural validation: the shape of every checkpoint field
// ---------------------------------------------------------------------------

type Unknown = Record<string, unknown>

function isPlainObject(value: unknown): value is Unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function checkString(value: unknown, where: string, violations: string[]): void {
  if (typeof value !== 'string') violations.push(`${where} must be a string`)
}

function checkNonEmptyString(value: unknown, where: string, violations: string[]): void {
  if (!nonEmptyString(value)) violations.push(`${where} must be a non-empty string`)
}

function checkDigest(value: unknown, where: string, violations: string[]): void {
  if (!isSha256Digest(value)) violations.push(`${where} must be a sha256:<hex> digest`)
}

function checkObjectOid(value: unknown, where: string, violations: string[]): void {
  if (!isGitObjectOid(value)) {
    violations.push(`${where} must be an object-format Git OID (${GIT_OBJECT_OID_PATTERN})`)
  }
}

function checkInteger(
  value: unknown,
  minimum: number,
  where: string,
  violations: string[],
): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    violations.push(`${where} must be an integer >= ${minimum}`)
  }
}

function checkEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  where: string,
  violations: string[],
): void {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    violations.push(`${where} must be one of ${allowed.join(', ')}`)
  }
}

function checkStringArray(
  value: unknown,
  where: string,
  violations: string[],
  options: { readonly unique?: boolean } = {},
): void {
  if (!Array.isArray(value)) {
    violations.push(`${where} must be an array of strings`)
    return
  }
  const seen = new Set<string>()
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry === '') {
      violations.push(`${where}[${index}] must be a non-empty string`)
    } else if (options.unique && seen.has(entry)) {
      violations.push(`${where} contains duplicate "${entry}"`)
    } else {
      seen.add(entry)
    }
  })
}

/** Check exactly the keys present, rejecting unknown fields on a closed shape. */
function checkKeys(
  value: Unknown,
  required: readonly string[],
  where: string,
  violations: string[],
  options: { readonly allowOptional?: readonly string[] } = {},
): void {
  const optional = options.allowOptional ?? []
  for (const key of required) {
    if (!(key in value)) violations.push(`${where} is missing required field "${key}"`)
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      violations.push(`${where} has unknown field "${key}"`)
    }
  }
}

function checkStableIssueRef(
  value: unknown,
  role: 'map' | 'ticket',
  where: string,
  violations: string[],
): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be an issue reference object`)
    return
  }
  checkKeys(value, ['role', 'githubHost', 'repositoryId', 'issueId', 'number', 'url'], where, violations)
  if (value.role !== role) violations.push(`${where}.role must be "${role}"`)
  checkNonEmptyString(value.githubHost, `${where}.githubHost`, violations)
  checkNonEmptyString(value.repositoryId, `${where}.repositoryId`, violations)
  checkNonEmptyString(value.issueId, `${where}.issueId`, violations)
  checkInteger(value.number, 1, `${where}.number`, violations)
  checkNonEmptyString(value.url, `${where}.url`, violations)
}

function checkWorkspaceRef(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a workspace reference object`)
    return
  }
  checkEnum(value.kind, ['ticket', 'map-completion'] as const, `${where}.kind`, violations)
  if (value.kind === 'ticket') {
    checkKeys(
      value,
      ['kind', 'repositoryId', 'runId', 'path', 'branch', 'workAttemptId'],
      where,
      violations,
    )
    checkNonEmptyString(value.repositoryId, `${where}.repositoryId`, violations)
    checkNonEmptyString(value.runId, `${where}.runId`, violations)
    checkNonEmptyString(value.path, `${where}.path`, violations)
    checkNonEmptyString(value.branch, `${where}.branch`, violations)
    checkNonEmptyString(value.workAttemptId, `${where}.workAttemptId`, violations)
  } else if (value.kind === 'map-completion') {
    checkKeys(
      value,
      ['kind', 'repositoryId', 'runId', 'path', 'completionAttemptId'],
      where,
      violations,
    )
    checkNonEmptyString(value.repositoryId, `${where}.repositoryId`, violations)
    checkNonEmptyString(value.runId, `${where}.runId`, violations)
    checkNonEmptyString(value.path, `${where}.path`, violations)
    checkNonEmptyString(value.completionAttemptId, `${where}.completionAttemptId`, violations)
  }
}

function checkTestEvidence(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a test evidence object`)
    return
  }
  checkKeys(
    value,
    ['phase', 'testIndex', 'argv', 'timeoutMs', 'baseSha', 'treeOid', 'exitCode', 'outputDigest'],
    where,
    violations,
  )
  checkEnum(value.phase, ['work', 'ship', 'map-completion'] as const, `${where}.phase`, violations)
  checkInteger(value.testIndex, 0, `${where}.testIndex`, violations)
  checkStringArray(value.argv, `${where}.argv`, violations)
  if (
    typeof value.timeoutMs !== 'number' ||
    !Number.isFinite(value.timeoutMs) ||
    value.timeoutMs <= 0
  ) {
    violations.push(`${where}.timeoutMs must be a number greater than 0`)
  }
  checkObjectOid(value.baseSha, `${where}.baseSha`, violations)
  checkObjectOid(value.treeOid, `${where}.treeOid`, violations)
  if (value.exitCode !== 0) violations.push(`${where}.exitCode must be 0 for stored evidence`)
  checkDigest(value.outputDigest, `${where}.outputDigest`, violations)
}

function checkTestEvidenceList(
  value: unknown,
  where: string,
  violations: string[],
  options: { readonly phases: readonly ('work' | 'ship' | 'map-completion')[] },
): void {
  if (!Array.isArray(value) || value.length === 0) {
    violations.push(`${where} must be a non-empty array of test evidence`)
    return
  }
  value.forEach((entry, index) => checkTestEvidence(entry, `${where}[${index}]`, violations))
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      if (isPlainObject(entry)) {
        if (!options.phases.includes(entry.phase as 'work' | 'ship' | 'map-completion')) {
          violations.push(`${where}[${index}].phase must be ${options.phases.join(' or ')}`)
        }
        if (entry.testIndex !== index) {
          violations.push(`${where}[${index}].testIndex must equal its position ${index}`)
        }
      }
    })
  }
}

function checkReviewEvidence(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a review evidence object`)
    return
  }
  checkKeys(
    value,
    [
      'phase', 'provider', 'model', 'family', 'thinking', 'verdict',
      'mapRevision', 'ticketRevision', 'baseSha', 'treeOid', 'testEvidenceDigest',
    ],
    where,
    violations,
  )
  checkEnum(value.phase, ['work', 'ship'] as const, `${where}.phase`, violations)
  for (const field of ['provider', 'model', 'family', 'thinking'] as const) {
    checkNonEmptyString(value[field], `${where}.${field}`, violations)
  }
  if (value.verdict !== 'pass') violations.push(`${where}.verdict must be "pass"`)
  checkDigest(value.mapRevision, `${where}.mapRevision`, violations)
  checkDigest(value.ticketRevision, `${where}.ticketRevision`, violations)
  checkObjectOid(value.baseSha, `${where}.baseSha`, violations)
  checkObjectOid(value.treeOid, `${where}.treeOid`, violations)
  checkDigest(value.testEvidenceDigest, `${where}.testEvidenceDigest`, violations)
}

function checkMapCompletionReviewEvidence(
  value: unknown,
  where: string,
  violations: string[],
): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a map-completion review evidence object`)
    return
  }
  checkKeys(
    value,
    [
      'phase', 'provider', 'model', 'family', 'thinking', 'verdict',
      'mapRevision', 'completionSha', 'treeOid', 'testEvidenceDigest',
    ],
    where,
    violations,
  )
  if (value.phase !== 'map-completion') {
    violations.push(`${where}.phase must be "map-completion"`)
  }
  for (const field of ['provider', 'model', 'family', 'thinking'] as const) {
    checkNonEmptyString(value[field], `${where}.${field}`, violations)
  }
  if (value.verdict !== 'pass') violations.push(`${where}.verdict must be "pass"`)
  checkDigest(value.mapRevision, `${where}.mapRevision`, violations)
  checkObjectOid(value.completionSha, `${where}.completionSha`, violations)
  checkObjectOid(value.treeOid, `${where}.treeOid`, violations)
  checkDigest(value.testEvidenceDigest, `${where}.testEvidenceDigest`, violations)
}

function checkEvidenceGateV1(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be an evidence gate object`)
    return
  }
  checkKeys(value, ['worker', 'reviewer', 'tests'], where, violations)
  for (const role of ['worker', 'reviewer'] as const) {
    const gate = value[role]
    if (!isPlainObject(gate)) {
      violations.push(`${where}.${role} must be an agent role object`)
      continue
    }
    checkKeys(gate, ['provider', 'model', 'family', 'thinking'], `${where}.${role}`, violations)
    for (const field of ['provider', 'model', 'family', 'thinking'] as const) {
      checkNonEmptyString(gate[field], `${where}.${role}.${field}`, violations)
    }
  }
  const tests = value.tests
  if (!Array.isArray(tests) || tests.length === 0) {
    violations.push(`${where}.tests must be a non-empty array of command entries`)
  } else {
    tests.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        violations.push(`${where}.tests[${index}] must be an object`)
        return
      }
      checkKeys(entry, ['argv', 'timeoutMs'], `${where}.tests[${index}]`, violations)
      checkStringArray(entry.argv, `${where}.tests[${index}].argv`, violations)
      if (
        typeof entry.timeoutMs !== 'number' ||
        !Number.isFinite(entry.timeoutMs) ||
        entry.timeoutMs <= 0
      ) {
        violations.push(`${where}.tests[${index}].timeoutMs must be a number greater than 0`)
      }
    })
  }
  const worker = value.worker
  const reviewer = value.reviewer
  if (isPlainObject(worker) && isPlainObject(reviewer) && worker.family === reviewer.family) {
    violations.push(`${where} worker and reviewer families must differ`)
  }
}

function checkShippableChange(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a shippable change object`)
    return
  }
  checkKeys(
    value,
    [
      'ticket', 'mapRevision', 'ticketRevision', 'baseSha',
      'candidateCommit', 'candidateTreeOid', 'workspace', 'tests', 'review',
    ],
    where,
    violations,
  )
  checkStableIssueRef(value.ticket, 'ticket', `${where}.ticket`, violations)
  checkDigest(value.mapRevision, `${where}.mapRevision`, violations)
  checkDigest(value.ticketRevision, `${where}.ticketRevision`, violations)
  checkObjectOid(value.baseSha, `${where}.baseSha`, violations)
  checkObjectOid(value.candidateCommit, `${where}.candidateCommit`, violations)
  checkObjectOid(value.candidateTreeOid, `${where}.candidateTreeOid`, violations)
  checkWorkspaceRef(value.workspace, `${where}.workspace`, violations)
  checkTestEvidenceList(value.tests, `${where}.tests`, violations, { phases: ['work'] })
  checkReviewEvidence(value.review, `${where}.review`, violations)
  if (isPlainObject(value.review) && isPlainObject(value.workspace)) {
    if (value.review.phase === 'work') {
      bindReviewToChange(value, where, violations)
      bindTestsToChange(value, where, violations)
    }
  }
}

function bindReviewToChange(change: Unknown, where: string, violations: string[]): void {
  const review = change.review as Unknown
  if (review.mapRevision !== change.mapRevision) {
    violations.push(`${where}.review.mapRevision must equal the change revision`)
  }
  if (review.ticketRevision !== change.ticketRevision) {
    violations.push(`${where}.review.ticketRevision must equal the change revision`)
  }
  if (review.baseSha !== change.baseSha) {
    violations.push(`${where}.review.baseSha must equal the change base`)
  }
  if (review.treeOid !== change.candidateTreeOid) {
    violations.push(`${where}.review.treeOid must equal the candidate tree`)
  }
}

function bindTestsToChange(change: Unknown, where: string, violations: string[]): void {
  const tests = change.tests
  if (!Array.isArray(tests)) return
  tests.forEach((entry, index) => {
    if (!isPlainObject(entry)) return
    if (entry.baseSha !== change.baseSha) {
      violations.push(`${where}.tests[${index}].baseSha must equal the change base`)
    }
    if (entry.treeOid !== change.candidateTreeOid) {
      violations.push(`${where}.tests[${index}].treeOid must equal the candidate tree`)
    }
  })
  const review = change.review
  if (isPlainObject(review) && isCanonicalJsonValue(tests)) {
    const digest = tryCanonicalDigest(tests)
    if (digest !== undefined && digest !== review.testEvidenceDigest) {
      violations.push(`${where}.review.testEvidenceDigest must match the ordered test evidence`)
    }
  }
}

function checkDeliveryRecordV1(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a delivery record object`)
    return
  }
  checkKeys(
    value,
    [
      'schema', 'deliveryId', 'run', 'gate', 'map', 'ticket',
      'target', 'review', 'tests', 'actorId', 'recordedAt',
    ],
    where,
    violations,
  )
  if (value.schema !== 'norn-delivery:v1') {
    violations.push(`${where}.schema must be "norn-delivery:v1"`)
  }
  checkNonEmptyString(value.deliveryId, `${where}.deliveryId`, violations)
  if (isPlainObject(value.run)) {
    checkKeys(value.run, ['id', 'configRevision', 'nornVersion'], `${where}.run`, violations)
    checkNonEmptyString(value.run.id, `${where}.run.id`, violations)
    checkDigest(value.run.configRevision, `${where}.run.configRevision`, violations)
    checkNonEmptyString(value.run.nornVersion, `${where}.run.nornVersion`, violations)
  }
  checkEvidenceGateV1(value.gate, `${where}.gate`, violations)
  if (isPlainObject(value.map)) {
    checkKeys(value.map, ['issueId', 'revision'], `${where}.map`, violations)
    checkNonEmptyString(value.map.issueId, `${where}.map.issueId`, violations)
    checkDigest(value.map.revision, `${where}.map.revision`, violations)
  }
  if (isPlainObject(value.ticket)) {
    checkKeys(value.ticket, ['issueId', 'revision'], `${where}.ticket`, violations)
    checkNonEmptyString(value.ticket.issueId, `${where}.ticket.issueId`, violations)
    checkDigest(value.ticket.revision, `${where}.ticket.revision`, violations)
  }
  if (isPlainObject(value.target)) {
    checkKeys(
      value.target,
      ['repositoryId', 'branch', 'baseSha', 'integratedSha', 'treeOid'],
      `${where}.target`,
      violations,
    )
    checkNonEmptyString(value.target.repositoryId, `${where}.target.repositoryId`, violations)
    checkNonEmptyString(value.target.branch, `${where}.target.branch`, violations)
    checkObjectOid(value.target.baseSha, `${where}.target.baseSha`, violations)
    checkObjectOid(value.target.integratedSha, `${where}.target.integratedSha`, violations)
    checkObjectOid(value.target.treeOid, `${where}.target.treeOid`, violations)
  }
  checkReviewEvidence(value.review, `${where}.review`, violations)
  checkTestEvidenceList(value.tests, `${where}.tests`, violations, { phases: ['work', 'ship'] })
  checkNonEmptyString(value.actorId, `${where}.actorId`, violations)
  checkNonEmptyString(value.recordedAt, `${where}.recordedAt`, violations)
  checkSealedRecordId(value, 'deliveryId', where, violations)
}

function checkMapCompletionRecordV1(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a map completion record object`)
    return
  }
  checkKeys(
    value,
    [
      'schema', 'completionId', 'run', 'gate', 'map', 'target',
      'review', 'tests', 'actorId', 'recordedAt',
    ],
    where,
    violations,
  )
  if (value.schema !== 'norn-map-completion:v1') {
    violations.push(`${where}.schema must be "norn-map-completion:v1"`)
  }
  checkNonEmptyString(value.completionId, `${where}.completionId`, violations)
  if (isPlainObject(value.run)) {
    checkKeys(
      value.run,
      ['id', 'completionAttemptId', 'configRevision', 'nornVersion'],
      `${where}.run`,
      violations,
    )
    checkNonEmptyString(value.run.id, `${where}.run.id`, violations)
    checkNonEmptyString(value.run.completionAttemptId, `${where}.run.completionAttemptId`, violations)
    checkDigest(value.run.configRevision, `${where}.run.configRevision`, violations)
    checkNonEmptyString(value.run.nornVersion, `${where}.run.nornVersion`, violations)
  }
  checkEvidenceGateV1(value.gate, `${where}.gate`, violations)
  if (isPlainObject(value.map)) {
    checkKeys(value.map, ['issueId', 'revision', 'closingEventId'], `${where}.map`, violations)
    checkNonEmptyString(value.map.issueId, `${where}.map.issueId`, violations)
    checkDigest(value.map.revision, `${where}.map.revision`, violations)
    checkNonEmptyString(value.map.closingEventId, `${where}.map.closingEventId`, violations)
  }
  if (isPlainObject(value.target)) {
    checkKeys(
      value.target,
      ['repositoryId', 'branch', 'completionSha', 'treeOid'],
      `${where}.target`,
      violations,
    )
    checkNonEmptyString(value.target.repositoryId, `${where}.target.repositoryId`, violations)
    checkNonEmptyString(value.target.branch, `${where}.target.branch`, violations)
    checkObjectOid(value.target.completionSha, `${where}.target.completionSha`, violations)
    checkObjectOid(value.target.treeOid, `${where}.target.treeOid`, violations)
  }
  checkMapCompletionReviewEvidence(value.review, `${where}.review`, violations)
  checkTestEvidenceList(value.tests, `${where}.tests`, violations, { phases: ['map-completion'] })
  checkNonEmptyString(value.actorId, `${where}.actorId`, violations)
  checkNonEmptyString(value.recordedAt, `${where}.recordedAt`, violations)
  checkSealedRecordId(value, 'completionId', where, violations)
}

/** Recompute a sealed record ID: SHA-256 over canonical JSON without the ID (§14, §15). */
function checkSealedRecordId(
  record: Unknown,
  idField: 'deliveryId' | 'completionId',
  where: string,
  violations: string[],
): void {
  const sealedId = record[idField]
  if (typeof sealedId !== 'string') return
  const rest: Record<string, unknown> = { ...record }
  delete rest[idField]
  if (!isCanonicalJsonValue(rest)) return
  const recomputed = tryCanonicalDigest(rest)
  if (recomputed !== undefined && recomputed !== sealedId) {
    violations.push(`${where}.${idField} does not recompute from the sealed record`)
  }
}

function checkProcessGroupCheckpoint(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a process group checkpoint object`)
    return
  }
  checkKeys(
    value,
    ['id', 'owner', 'phase', 'workspace', 'adapterHandle', 'state'],
    where,
    violations,
    { allowOptional: ['ticketIssueId', 'workAttemptId'] },
  )
  checkNonEmptyString(value.id, `${where}.id`, violations)
  checkEnum(value.owner, ['worker', 'reviewer', 'command'] as const, `${where}.owner`, violations)
  checkEnum(value.phase, ['work', 'ship', 'map-completion'] as const, `${where}.phase`, violations)
  checkWorkspaceRef(value.workspace, `${where}.workspace`, violations)
  if (value.ticketIssueId !== undefined) {
    checkNonEmptyString(value.ticketIssueId, `${where}.ticketIssueId`, violations)
  }
  if (value.workAttemptId !== undefined) {
    checkNonEmptyString(value.workAttemptId, `${where}.workAttemptId`, violations)
  }
  checkNonEmptyString(value.adapterHandle, `${where}.adapterHandle`, violations)
  checkEnum(
    value.state,
    ['launch-intent', 'running', 'settled'] as const,
    `${where}.state`,
    violations,
  )
}

function checkWorkAttempt(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a work attempt checkpoint object`)
    return
  }
  checkKeys(
    value,
    ['workAttemptId', 'input', 'branch', 'workspace', 'round', 'slot', 'processGroupIds'],
    where,
    violations,
  )
  checkNonEmptyString(value.workAttemptId, `${where}.workAttemptId`, violations)
  checkWorkInput(value.input, `${where}.input`, violations)
  checkNonEmptyString(value.branch, `${where}.branch`, violations)
  checkWorkspaceRef(value.workspace, `${where}.workspace`, violations)
  checkInteger(value.round, 0, `${where}.round`, violations)
  checkEnum(
    value.slot,
    ['awaiting-reservation', 'reserved', 'released'] as const,
    `${where}.slot`,
    violations,
  )
  checkStringArray(value.processGroupIds, `${where}.processGroupIds`, violations, { unique: true })
  if (isPlainObject(value.workspace) && value.workspace.kind === 'ticket') {
    if (value.workspace.workAttemptId !== value.workAttemptId) {
      violations.push(`${where}.workspace must carry the attempt's workAttemptId`)
    }
  }
}

function checkWorkInput(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a work input object`)
    return
  }
  checkKeys(value, ['ticket', 'spec', 'target'], where, violations)
  checkStableIssueRef(value.ticket, 'ticket', `${where}.ticket`, violations)
  if (isPlainObject(value.spec)) {
    checkKeys(
      value.spec,
      ['mapTitle', 'mapBody', 'mapRevision', 'ticketTitle', 'ticketBody', 'ticketRevision'],
      `${where}.spec`,
      violations,
    )
    checkString(value.spec.mapTitle, `${where}.spec.mapTitle`, violations)
    checkString(value.spec.mapBody, `${where}.spec.mapBody`, violations)
    checkDigest(value.spec.mapRevision, `${where}.spec.mapRevision`, violations)
    checkString(value.spec.ticketTitle, `${where}.spec.ticketTitle`, violations)
    checkString(value.spec.ticketBody, `${where}.spec.ticketBody`, violations)
    checkDigest(value.spec.ticketRevision, `${where}.spec.ticketRevision`, violations)
  }
  if (isPlainObject(value.target)) {
    checkKeys(value.target, ['branch', 'baseSha', 'baseTreeOid'], `${where}.target`, violations)
    checkNonEmptyString(value.target.branch, `${where}.target.branch`, violations)
    checkObjectOid(value.target.baseSha, `${where}.target.baseSha`, violations)
    checkObjectOid(value.target.baseTreeOid, `${where}.target.baseTreeOid`, violations)
  }
}

function checkShipCheckpoint(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a ship checkpoint object`)
    return
  }
  checkKeys(
    value,
    [
      'stage', 'pushAttempts', 'zeroDelta', 'baseSha', 'integratedSha',
      'treeOid', 'tests', 'review', 'delivery',
    ],
    where,
    violations,
  )
  checkEnum(
    value.stage,
    ['prepared', 'push-verified', 'delivery-recorded', 'ticket-closed'] as const,
    `${where}.stage`,
    violations,
  )
  checkInteger(value.pushAttempts, 0, `${where}.pushAttempts`, violations)
  if (typeof value.zeroDelta !== 'boolean') {
    violations.push(`${where}.zeroDelta must be a boolean`)
  }
  checkObjectOid(value.baseSha, `${where}.baseSha`, violations)
  checkObjectOid(value.integratedSha, `${where}.integratedSha`, violations)
  checkObjectOid(value.treeOid, `${where}.treeOid`, violations)
  checkTestEvidenceList(value.tests, `${where}.tests`, violations, { phases: ['work', 'ship'] })
  checkReviewEvidence(value.review, `${where}.review`, violations)
  checkDeliveryRecordV1(value.delivery, `${where}.delivery`, violations)
}

function checkTimelineAnchor(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a timeline anchor object`)
    return
  }
  if (value.kind === 'event-id') {
    checkKeys(value, ['kind', 'eventId'], where, violations)
    checkNonEmptyString(value.eventId, `${where}.eventId`, violations)
    return
  }
  if (value.kind === 'prefix') {
    checkKeys(value, ['kind', 'timelineLength', 'prefixDigest'], where, violations)
    checkInteger(value.timelineLength, 0, `${where}.timelineLength`, violations)
    checkDigest(value.prefixDigest, `${where}.prefixDigest`, violations)
    return
  }
  checkEnum(value.kind, ['event-id', 'prefix'] as const, `${where}.kind`, violations)
}

function checkMapCompletion(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a map completion checkpoint object`)
    return
  }
  checkKeys(
    value,
    [
      'stage', 'completionAttemptId', 'timelineAnchor', 'workspace', 'mapRevision',
      'completionSha', 'treeOid', 'gate', 'tests', 'review',
    ],
    where,
    violations,
    { allowOptional: ['closingEventId', 'record'] },
  )
  checkEnum(value.stage, ['gated', 'map-closed', 'recorded'] as const, `${where}.stage`, violations)
  checkNonEmptyString(value.completionAttemptId, `${where}.completionAttemptId`, violations)
  checkTimelineAnchor(value.timelineAnchor, `${where}.timelineAnchor`, violations)
  checkWorkspaceRef(value.workspace, `${where}.workspace`, violations)
  if (isPlainObject(value.workspace) && value.workspace.kind === 'map-completion') {
    if (value.workspace.completionAttemptId !== value.completionAttemptId) {
      violations.push(`${where}.workspace must carry the completion attempt ID`)
    }
  }
  checkDigest(value.mapRevision, `${where}.mapRevision`, violations)
  checkObjectOid(value.completionSha, `${where}.completionSha`, violations)
  checkObjectOid(value.treeOid, `${where}.treeOid`, violations)
  checkEvidenceGateV1(value.gate, `${where}.gate`, violations)
  checkTestEvidenceList(value.tests, `${where}.tests`, violations, { phases: ['map-completion'] })
  checkMapCompletionReviewEvidence(value.review, `${where}.review`, violations)
  if (value.closingEventId !== undefined) {
    checkNonEmptyString(value.closingEventId, `${where}.closingEventId`, violations)
  }
  if (value.record !== undefined) {
    checkMapCompletionRecordV1(value.record, `${where}.record`, violations)
  }
  if (Array.isArray(value.tests)) {
    value.tests.forEach((entry, index) => {
      if (!isPlainObject(entry)) return
      if (entry.baseSha !== value.completionSha) {
        violations.push(
          `${where}.tests[${index}].baseSha must equal the completion commit`,
        )
      }
      if (entry.treeOid !== value.treeOid) {
        violations.push(`${where}.tests[${index}].treeOid must equal the checkpoint tree`)
      }
    })
    if (isCanonicalJsonValue(value.tests)) {
      const digest = tryCanonicalDigest(value.tests)
      if (
        isPlainObject(value.review) &&
        digest !== undefined &&
        digest !== value.review.testEvidenceDigest
      ) {
        violations.push(`${where}.review.testEvidenceDigest must match the ordered tests`)
      }
    }
  }
  if (isPlainObject(value.review)) {
    if (value.review.mapRevision !== value.mapRevision) {
      violations.push(`${where}.review.mapRevision must equal the checkpoint revision`)
    }
    if (value.review.completionSha !== value.completionSha) {
      violations.push(`${where}.review.completionSha must equal the checkpoint commit`)
    }
    if (value.review.treeOid !== value.treeOid) {
      violations.push(`${where}.review.treeOid must equal the checkpoint tree`)
    }
  }
  if (isPlainObject(value.record)) {
    if (value.record.completionId !== undefined && value.closingEventId === undefined) {
      violations.push(`${where}.record requires closingEventId`)
    }
    if (
      isPlainObject(value.record.map) &&
      value.closingEventId !== undefined &&
      value.record.map.closingEventId !== value.closingEventId
    ) {
      violations.push(`${where}.record.map.closingEventId must equal the checkpoint closing event`)
    }
    if (isPlainObject(value.record.run) && value.record.run.completionAttemptId !== undefined) {
      if (value.record.run.completionAttemptId !== value.completionAttemptId) {
        violations.push(`${where}.record.run.completionAttemptId must equal the checkpoint attempt`)
      }
    }
  }
}

function checkRunReport(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a run report object`)
    return
  }
  checkKeys(
    value,
    [
      'label', 'runId', 'initialMapRevision', 'finalMapRevision', 'acceptedExtensions',
      'tickets', 'sharedWrite', 'warnings',
    ],
    where,
    violations,
    { allowOptional: ['code', 'completionSha', 'retainedWorkspace'] },
  )
  checkEnum(value.label, ['passed', 'blocked', 'error'] as const, `${where}.label`, violations)
  if (value.code !== undefined) checkNonEmptyString(value.code, `${where}.code`, violations)
  checkNonEmptyString(value.runId, `${where}.runId`, violations)
  checkDigest(value.initialMapRevision, `${where}.initialMapRevision`, violations)
  checkDigest(value.finalMapRevision, `${where}.finalMapRevision`, violations)
  if (Array.isArray(value.acceptedExtensions)) {
    value.acceptedExtensions.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        violations.push(`${where}.acceptedExtensions[${index}] must be an object`)
        return
      }
      checkKeys(entry, ['revision', 'addedTicketIssueIds'], `${where}.acceptedExtensions[${index}]`, violations)
      checkDigest(entry.revision, `${where}.acceptedExtensions[${index}].revision`, violations)
      checkStringArray(
        entry.addedTicketIssueIds,
        `${where}.acceptedExtensions[${index}].addedTicketIssueIds`,
        violations,
      )
    })
  } else {
    violations.push(`${where}.acceptedExtensions must be an array`)
  }
  if (Array.isArray(value.tickets)) {
    value.tickets.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        violations.push(`${where}.tickets[${index}] must be an object`)
        return
      }
      checkKeys(entry, ['ticket', 'state'], `${where}.tickets[${index}]`, violations, {
        allowOptional: ['code'],
      })
      checkStableIssueRef(entry.ticket, 'ticket', `${where}.tickets[${index}].ticket`, violations)
      checkEnum(
        entry.state,
        ['completed', 'parked', 'waiting'] as const,
        `${where}.tickets[${index}].state`,
        violations,
      )
      if (entry.code !== undefined) {
        checkNonEmptyString(entry.code, `${where}.tickets[${index}].code`, violations)
      }
    })
  } else {
    violations.push(`${where}.tickets must be an array`)
  }
  checkEnum(value.sharedWrite, ['none', 'confirmed'] as const, `${where}.sharedWrite`, violations)
  if (value.completionSha !== undefined) {
    checkObjectOid(value.completionSha, `${where}.completionSha`, violations)
  }
  checkStringArray(value.warnings, `${where}.warnings`, violations)
  if (value.retainedWorkspace !== undefined) {
    checkWorkspaceRef(value.retainedWorkspace, `${where}.retainedWorkspace`, violations)
  }
  // Report invariants (§13.1).
  if (value.label === 'passed') {
    if (value.code !== undefined) violations.push(`${where}: a passed report carries no code`)
    if (value.completionSha === undefined) {
      violations.push(`${where}: a passed report requires completionSha`)
    }
    if (value.sharedWrite !== 'confirmed') {
      violations.push(`${where}: a passed report has sharedWrite "confirmed"`)
    }
  } else {
    if (value.code === undefined) violations.push(`${where}: a ${value.label} report requires a code`)
    if (value.completionSha !== undefined) {
      violations.push(`${where}: a ${value.label} report has no completionSha`)
    }
    if (value.label === 'error' && value.sharedWrite !== 'none') {
      violations.push(`${where}: a terminal error report has sharedWrite "none"`)
    }
  }
}

function checkRunStateShape(value: unknown, violations: string[]): RunState | undefined {
  if (!isPlainObject(value)) {
    violations.push('run state must be a JSON object')
    return undefined
  }
  checkKeys(
    value,
    [
      'schema', 'runId', 'map', 'acceptedMapRevisions', 'configRevision', 'nornVersion',
      'status', 'wave', 'parkedTickets', 'tickets', 'activeProcesses',
    ],
    'run state',
    violations,
    { allowOptional: ['activeWave', 'mapCompletion', 'reworks', 'report'] },
  )
  if (value.schema !== RUN_STATE_SCHEMA) {
    violations.push(`schema must be "${RUN_STATE_SCHEMA}"`)
  }
  checkNonEmptyString(value.runId, 'runId', violations)
  checkStableIssueRef(value.map, 'map', 'map', violations)
  checkDigest(value.configRevision, 'configRevision', violations)
  checkNonEmptyString(value.nornVersion, 'nornVersion', violations)
  checkEnum(value.status, ['running', 'terminal', 'aborted'] as const, 'status', violations)
  checkInteger(value.wave, 0, 'wave', violations)
  if (value.activeWave !== undefined) {
    checkWaveState(value.activeWave, 'activeWave', violations)
  }
  if (Array.isArray(value.parkedTickets)) {
    value.parkedTickets.forEach((entry, index) => {
      checkStableIssueRef(entry, 'ticket', `parkedTickets[${index}]`, violations)
    })
  } else {
    violations.push('parkedTickets must be an array')
  }
  if (isPlainObject(value.tickets)) {
    for (const [key, entry] of Object.entries(value.tickets)) {
      checkTicketRunState(entry, `tickets[${key}]`, violations)
    }
  } else {
    violations.push('tickets must be an object keyed by ticket issue ID')
  }
  if (value.reworks !== undefined) {
    checkTicketReworkLedger(value.reworks, 'reworks', violations)
  }
  if (Array.isArray(value.activeProcesses)) {
    value.activeProcesses.forEach((entry, index) => {
      checkProcessGroupCheckpoint(entry, `activeProcesses[${index}]`, violations)
    })
  } else {
    violations.push('activeProcesses must be an array')
  }
  if (value.mapCompletion !== undefined) {
    checkMapCompletion(value.mapCompletion, 'mapCompletion', violations)
  }
  if (value.report !== undefined) {
    checkRunReport(value.report, 'report', violations)
  }
  checkAcceptedMapRevisions(value.acceptedMapRevisions, violations)
  return value as unknown as RunState
}

function checkWaveState(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a wave state object`)
    return
  }
  checkKeys(
    value,
    ['number', 'mapRevision', 'target', 'frontierTicketIssueIds', 'shipQueueTicketIssueIds', 'nextShipIndex'],
    where,
    violations,
  )
  checkInteger(value.number, 1, `${where}.number`, violations)
  checkDigest(value.mapRevision, `${where}.mapRevision`, violations)
  if (isPlainObject(value.target)) {
    checkKeys(value.target, ['branch', 'baseSha', 'baseTreeOid'], `${where}.target`, violations)
    checkNonEmptyString(value.target.branch, `${where}.target.branch`, violations)
    checkObjectOid(value.target.baseSha, `${where}.target.baseSha`, violations)
    checkObjectOid(value.target.baseTreeOid, `${where}.target.baseTreeOid`, violations)
  }
  checkStringArray(value.frontierTicketIssueIds, `${where}.frontierTicketIssueIds`, violations, {
    unique: true,
  })
  checkStringArray(value.shipQueueTicketIssueIds, `${where}.shipQueueTicketIssueIds`, violations, {
    unique: true,
  })
  checkInteger(value.nextShipIndex, 0, `${where}.nextShipIndex`, violations)
}

function checkTicketReworkLedger(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be an object keyed by ticket issue ID`)
    return
  }
  for (const [issueId, entry] of Object.entries(value)) {
    if (issueId === '') violations.push(`${where} has an empty entry key`)
    checkTicketRework(entry, `${where}[${issueId}]`, violations)
  }
}

function checkTicketRework(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a ticket rework object`)
    return
  }
  checkKeys(value, ['cycles', 'conflict'], where, violations)
  checkInteger(value.cycles, 1, `${where}.cycles`, violations)
  if (!isPlainObject(value.conflict)) {
    violations.push(`${where}.conflict must be an object`)
    return
  }
  const conflict = value.conflict
  checkKeys(conflict, ['code', 'reason', 'evidence'], `${where}.conflict`, violations)
  checkNonEmptyString(conflict.code, `${where}.conflict.code`, violations)
  checkString(conflict.reason, `${where}.conflict.reason`, violations)
  if (!Array.isArray(conflict.evidence)) {
    violations.push(`${where}.conflict.evidence must be an array`)
  } else if (!conflict.evidence.every(isCanonicalJsonValue)) {
    violations.push(`${where}.conflict.evidence must be serializable machine data`)
  }
}

function checkTicketRunState(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a ticket run state object`)
    return
  }
  switch (value.phase) {
    case 'waiting': {
      checkKeys(value, ['phase'], where, violations, { allowOptional: ['wave'] })
      if (value.wave !== undefined) checkInteger(value.wave, 1, `${where}.wave`, violations)
      break
    }
    case 'working': {
      checkKeys(value, ['phase', 'wave', 'attempt'], where, violations)
      checkInteger(value.wave, 1, `${where}.wave`, violations)
      checkWorkAttempt(value.attempt, `${where}.attempt`, violations)
      break
    }
    case 'parked': {
      checkKeys(value, ['phase', 'wave', 'outcome'], where, violations, {
        allowOptional: ['workspace'],
      })
      checkInteger(value.wave, 1, `${where}.wave`, violations)
      if (value.workspace !== undefined) {
        checkWorkspaceRef(value.workspace, `${where}.workspace`, violations)
      }
      if (isPlainObject(value.outcome)) {
        checkKeys(value.outcome, ['kind', 'code', 'reason', 'evidence'], `${where}.outcome`, violations)
        checkEnum(value.outcome.kind, ['blocked', 'error'] as const, `${where}.outcome.kind`, violations)
        checkNonEmptyString(value.outcome.code, `${where}.outcome.code`, violations)
        checkString(value.outcome.reason, `${where}.outcome.reason`, violations)
        if (!Array.isArray(value.outcome.evidence)) {
          violations.push(`${where}.outcome.evidence must be an array`)
        } else if (!value.outcome.evidence.every(isCanonicalJsonValue)) {
          violations.push(`${where}.outcome.evidence must be serializable machine data`)
        }
      }
      break
    }
    case 'shippable': {
      checkKeys(value, ['phase', 'wave', 'change'], where, violations)
      checkInteger(value.wave, 1, `${where}.wave`, violations)
      checkShippableChange(value.change, `${where}.change`, violations)
      break
    }
    case 'shipping': {
      checkKeys(value, ['phase', 'wave', 'change', 'checkpoint'], where, violations)
      checkInteger(value.wave, 1, `${where}.wave`, violations)
      checkShippableChange(value.change, `${where}.change`, violations)
      checkShipCheckpoint(value.checkpoint, `${where}.checkpoint`, violations)
      break
    }
    case 'completed': {
      checkKeys(value, ['phase', 'deliveryId', 'integratedSha'], where, violations, {
        allowOptional: ['cleanupWorkspace'],
      })
      checkNonEmptyString(value.deliveryId, `${where}.deliveryId`, violations)
      checkObjectOid(value.integratedSha, `${where}.integratedSha`, violations)
      if (value.cleanupWorkspace !== undefined) {
        checkWorkspaceRef(value.cleanupWorkspace, `${where}.cleanupWorkspace`, violations)
      }
      break
    }
    default:
      violations.push(`${where}.phase must be a known ticket phase`)
  }
}

// ---------------------------------------------------------------------------
// Cross-field invariants: the §13.1 load-time agreement rules
// ---------------------------------------------------------------------------

function checkRunStateInvariants(state: RunState, violations: string[]): void {
  const document = state as unknown as Unknown

  // wave/activeWave agreement (§13.1).
  const activeWave = state.activeWave
  if (activeWave !== undefined) {
    if (state.wave !== activeWave.number) {
      violations.push(
        `wave (${state.wave}) must equal activeWave.number (${activeWave.number}) when a Wave exists`,
      )
    }
  }

  // Parked-set agreement (§13.1): parkedTickets exactly matches parked phases.
  const parkedPhaseIds = new Set(
    Object.entries(state.tickets)
      .filter(([, ticket]) => ticket.phase === 'parked')
      .map(([issueId]) => issueId),
  )
  const parkedRefIds = new Set<string>()
  for (const ref of state.parkedTickets) {
    if (parkedRefIds.has(ref.issueId)) {
      violations.push(`parkedTickets lists "${ref.issueId}" more than once`)
    }
    parkedRefIds.add(ref.issueId)
    if (ref.githubHost !== state.map.githubHost || ref.repositoryId !== state.map.repositoryId) {
      violations.push(`parkedTickets entry "${ref.issueId}" belongs to a different repository`)
    }
  }
  if (parkedPhaseIds.size !== parkedRefIds.size || ![...parkedPhaseIds].every((id) => parkedRefIds.has(id))) {
    const missing = [...parkedPhaseIds].filter((id) => !parkedRefIds.has(id))
    const extra = [...parkedRefIds].filter((id) => !parkedPhaseIds.has(id))
    violations.push(
      `parkedTickets must exactly match tickets with phase "parked" (missing: ${missing.join(', ') || 'none'}; unrecorded: ${extra.join(', ') || 'none'})`,
    )
  }

  // Ticket record keys are immutable ticket issue IDs of this map's members.
  const mapIdentity = { host: state.map.githubHost, repositoryId: state.map.repositoryId }
  const knownTicketIds = new Set(Object.keys(state.tickets))
  for (const [issueId, ticket] of Object.entries(state.tickets)) {
    if (issueId === '') violations.push('tickets has an empty record key')
    if (ticket.phase === 'working') {
      const ref = ticket.attempt.input.ticket
      if (
        ref.githubHost !== mapIdentity.host ||
        ref.repositoryId !== mapIdentity.repositoryId ||
        ref.issueId !== issueId
      ) {
        violations.push(`tickets[${issueId}].attempt.input.ticket must reference the same ticket`)
      }
      if (ticket.wave > state.wave) {
        violations.push(`tickets[${issueId}] carries wave ${ticket.wave} beyond wave ${state.wave}`)
      }
    }
    if (
      (ticket.phase === 'parked' || ticket.phase === 'shippable' || ticket.phase === 'shipping') &&
      ticket.wave > state.wave
    ) {
      violations.push(`tickets[${issueId}] carries wave ${ticket.wave} beyond wave ${state.wave}`)
    }
    if (ticket.phase === 'waiting' && ticket.wave !== undefined && ticket.wave > state.wave) {
      violations.push(`tickets[${issueId}] carries wave ${ticket.wave} beyond wave ${state.wave}`)
    }
  }

  // Rework ledger entries belong to tickets of this run (§12).
  for (const issueId of Object.keys(state.reworks ?? {})) {
    if (!knownTicketIds.has(issueId)) {
      violations.push(`reworks references unknown ticket "${issueId}"`)
    }
  }

  // The accepted lineage (§7.4, §13.1): re-hash every payload and verify every
  // recorded transition before trusting it.
  checkAcceptedLineage(state, violations)

  // Every process group referenced by a live attempt is recorded.
  const recordedGroupIds = new Set(state.activeProcesses.map((group) => group.id))
  for (const [issueId, ticket] of Object.entries(state.tickets)) {
    if (ticket.phase !== 'working') continue
    for (const groupId of ticket.attempt.processGroupIds) {
      if (!recordedGroupIds.has(groupId)) {
        violations.push(
          `tickets[${issueId}].attempt references unrecorded process group "${groupId}"`,
        )
      }
    }
  }

  // Active wave references known tickets and an accepted revision.
  if (state.activeWave !== undefined) {
    const knownIds = new Set(Object.keys(state.tickets))
    for (const issueId of state.activeWave.frontierTicketIssueIds) {
      if (!knownIds.has(issueId)) {
        violations.push(`activeWave frontier references unknown ticket "${issueId}"`)
      }
    }
    for (const issueId of state.activeWave.shipQueueTicketIssueIds) {
      if (!knownIds.has(issueId)) {
        violations.push(`activeWave ship queue references unknown ticket "${issueId}"`)
      }
    }
    if (state.activeWave.nextShipIndex > state.activeWave.shipQueueTicketIssueIds.length) {
      violations.push('activeWave.nextShipIndex exceeds the persisted ship queue length')
    }
    const acceptedRevisions = new Set<string>(state.acceptedMapRevisions.map((entry) => entry.revision))
    if (!acceptedRevisions.has(state.activeWave.mapRevision)) {
      violations.push('activeWave.mapRevision is not in the accepted revision lineage')
    }
  }

  // Shipping checkpoints agree with their change and sealed record (§13.1).
  for (const [issueId, ticket] of Object.entries(state.tickets)) {
    if (ticket.phase !== 'shipping') continue
    const { checkpoint, change } = ticket
    if (checkpoint.zeroDelta !== (checkpoint.baseSha === checkpoint.integratedSha)) {
      violations.push(
        `tickets[${issueId}].checkpoint.zeroDelta must agree with baseSha and integratedSha`,
      )
    }
    if (checkpoint.baseSha !== change.baseSha || checkpoint.treeOid !== change.candidateTreeOid) {
      // Reused Work evidence is valid only against the unchanged Work base
      // and tree (§11.2), so a work-phase checkpoint must agree with the
      // sealed change. Fresh ship evidence after target movement (§11.3)
      // may bind an advanced base and a replayed tree while the change stays
      // sealed, so only the work-evidence case is constrained.
      if (checkpoint.review.phase === 'work') {
        if (checkpoint.baseSha !== change.baseSha) {
          violations.push(
            `tickets[${issueId}].checkpoint.baseSha must equal the change base while it reuses Work evidence`,
          )
        }
        if (checkpoint.treeOid !== change.candidateTreeOid) {
          violations.push(
            `tickets[${issueId}].checkpoint.treeOid must equal the change tree while it reuses Work evidence`,
          )
        }
      }
    }
    const delivery = checkpoint.delivery as unknown as Unknown
    if (
      isPlainObject(delivery) && isPlainObject(delivery.target) &&
      (delivery.target.baseSha !== checkpoint.baseSha ||
        delivery.target.integratedSha !== checkpoint.integratedSha ||
        delivery.target.treeOid !== checkpoint.treeOid)
    ) {
      violations.push(`tickets[${issueId}].checkpoint.delivery.target must match the checkpoint`)
    }
    // Checkpoint tests — reused work evidence or fresh ship evidence — always
    // bind the persisted checkpoint base and tree (§13.1).
    checkpoint.tests.forEach((entry, index) => {
      if (entry.baseSha !== checkpoint.baseSha) {
        violations.push(
          `tickets[${issueId}].checkpoint.tests[${index}].baseSha must equal the checkpoint base`,
        )
      }
      if (entry.treeOid !== checkpoint.treeOid) {
        violations.push(
          `tickets[${issueId}].checkpoint.tests[${index}].treeOid must equal the checkpoint tree`,
        )
      }
    })
  }

  // Report/lifecycle coupling (§13.1, §13.2).
  if (state.report !== undefined && state.status !== 'terminal') {
    violations.push('a report is present only in a terminal run')
  }
  if (state.status === 'terminal' && state.report === undefined) {
    violations.push('a terminal run carries its report')
  }
  if (state.report !== undefined) {
    const report = state.report
    if (report.runId !== state.runId) {
      violations.push('report.runId must equal the run ID')
    }
    const first = state.acceptedMapRevisions[0]
    const last = state.acceptedMapRevisions.at(-1)
    if (first !== undefined && report.initialMapRevision !== first.revision) {
      violations.push('report.initialMapRevision must equal the preflight revision')
    }
    if (last !== undefined && report.finalMapRevision !== last.revision) {
      violations.push('report.finalMapRevision must equal the latest accepted revision')
    }
    const extensions = state.acceptedMapRevisions.slice(1)
    if (report.acceptedExtensions.length !== extensions.length) {
      violations.push('report.acceptedExtensions must mirror the accepted extensions')
    } else {
      extensions.forEach((entry, index) => {
        const mirrored = report.acceptedExtensions[index]
        if (
          mirrored === undefined ||
          mirrored.revision !== entry.revision ||
          !arraysEqual(mirrored.addedTicketIssueIds, entry.extension?.addedTicketIssueIds ?? [])
        ) {
          violations.push(`report.acceptedExtensions[${index}] must mirror the lineage entry`)
        }
      })
    }
    const reportIds = new Set(report.tickets.map((entry) => entry.ticket.issueId))
    for (const ref of report.tickets) {
      if (ref.ticket.githubHost !== state.map.githubHost || ref.ticket.repositoryId !== state.map.repositoryId) {
        violations.push('report.tickets entries must belong to this map\'s repository')
      }
    }
    // A blocked report lists every parked Ticket (§2.3).
    if (report.label === 'blocked') {
      for (const issueId of parkedPhaseIds) {
        if (!reportIds.has(issueId)) {
          violations.push(`report must list parked ticket "${issueId}"`)
        }
      }
    }
  }
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index])
}

// ---------------------------------------------------------------------------
// Accepted revision lineage: payload re-hash and transition verification
// ---------------------------------------------------------------------------

function checkAcceptedMapRevisions(value: unknown, violations: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    violations.push('acceptedMapRevisions must be a non-empty array')
    return
  }
  value.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      violations.push(`acceptedMapRevisions[${index}] must be an object`)
      return
    }
    const where = `acceptedMapRevisions[${index}]`
    checkKeys(entry, ['revision', 'payload'], where, violations, { allowOptional: ['extension'] })
    checkDigest(entry.revision, `${where}.revision`, violations)
    checkMapRevisionPayload(entry.payload, `${where}.payload`, violations)
    if (entry.extension !== undefined) {
      if (!isPlainObject(entry.extension)) {
        violations.push(`${where}.extension must be an object`)
      } else {
        checkKeys(entry.extension, ['fromRevision', 'addedTicketIssueIds'], `${where}.extension`, violations)
        checkDigest(entry.extension.fromRevision, `${where}.extension.fromRevision`, violations)
        checkStringArray(
          entry.extension.addedTicketIssueIds,
          `${where}.extension.addedTicketIssueIds`,
          violations,
          { unique: true },
        )
      }
    }
  })
  // The initial entry is the preflight snapshot: it carries no extension (§13.1).
  if (Array.isArray(value) && value.length > 0 && isPlainObject(value[0]) && 'extension' in value[0]) {
    violations.push('acceptedMapRevisions[0] is the preflight snapshot and carries no extension')
  }
}

function checkMapRevisionPayload(value: unknown, where: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be a map revision payload object`)
    return
  }
  checkKeys(
    value,
    ['schema', 'githubHost', 'repositoryId', 'mapIssueId', 'title', 'body', 'members', 'dependencies'],
    where,
    violations,
  )
  if (value.schema !== MAP_REVISION_SCHEMA) {
    violations.push(`${where}.schema must be "${MAP_REVISION_SCHEMA}"`)
  }
  checkNonEmptyString(value.githubHost, `${where}.githubHost`, violations)
  checkNonEmptyString(value.repositoryId, `${where}.repositoryId`, violations)
  checkNonEmptyString(value.mapIssueId, `${where}.mapIssueId`, violations)
  checkString(value.title, `${where}.title`, violations)
  checkString(value.body, `${where}.body`, violations)
  const memberIds = new Set<string>()
  if (Array.isArray(value.members)) {
    value.members.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        violations.push(`${where}.members[${index}] must be an object`)
        return
      }
      checkKeys(entry, ['ticketIssueId', 'ticketRevision'], `${where}.members[${index}]`, violations)
      checkNonEmptyString(entry.ticketIssueId, `${where}.members[${index}].ticketIssueId`, violations)
      checkDigest(entry.ticketRevision, `${where}.members[${index}].ticketRevision`, violations)
      if (typeof entry.ticketIssueId === 'string') {
        if (memberIds.has(entry.ticketIssueId)) {
          violations.push(`${where}.members lists "${entry.ticketIssueId}" more than once`)
        }
        memberIds.add(entry.ticketIssueId)
      }
    })
  } else {
    violations.push(`${where}.members must be an array`)
  }
  if (Array.isArray(value.dependencies)) {
    const edges = new Set<string>()
    value.dependencies.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        violations.push(`${where}.dependencies[${index}] must be an object`)
        return
      }
      checkKeys(
        entry,
        ['blockerIssueId', 'blockedIssueId'],
        `${where}.dependencies[${index}]`,
        violations,
      )
      checkNonEmptyString(entry.blockerIssueId, `${where}.dependencies[${index}].blockerIssueId`, violations)
      checkNonEmptyString(entry.blockedIssueId, `${where}.dependencies[${index}].blockedIssueId`, violations)
      if (entry.blockerIssueId === entry.blockedIssueId && typeof entry.blockerIssueId === 'string') {
        violations.push(`${where}.dependencies[${index}] is a self edge`)
      }
      const key = `${entry.blockerIssueId}\u0000${entry.blockedIssueId}`
      if (edges.has(key)) {
        violations.push(`${where}.dependencies[${index}] duplicates an edge`)
      }
      edges.add(key)
      if (
        typeof entry.blockerIssueId === 'string' && typeof entry.blockedIssueId === 'string' &&
        (!memberIds.has(entry.blockerIssueId) || !memberIds.has(entry.blockedIssueId))
      ) {
        violations.push(
          `${where}.dependencies[${index}] references an issue outside the member set`,
        )
      }
    })
  } else {
    violations.push(`${where}.dependencies must be an array`)
  }
  // Members and dependencies hash in sorted order (§7.3).
  if (Array.isArray(value.members)) {
    const ids = value.members
      .map((entry) => (isPlainObject(entry) ? entry.ticketIssueId : ''))
      .filter((id) => typeof id === 'string')
    const sorted = [...ids].sort()
    if (!arraysEqual(ids, sorted)) {
      violations.push(`${where}.members must be sorted by ticketIssueId`)
    }
  }
  if (Array.isArray(value.dependencies)) {
    const keys = value.dependencies.map((entry) =>
      isPlainObject(entry)
        ? `${entry.blockerIssueId}\u0000${entry.blockedIssueId}`
        : '',
    )
    const sorted = [...keys].sort()
    if (!arraysEqual(keys, sorted)) {
      violations.push(`${where}.dependencies must be sorted by blocker then blocked issue ID`)
    }
  }
}

function checkAcceptedLineage(state: RunState, violations: string[]): void {
  const entries = state.acceptedMapRevisions
  const map = state.map as unknown as Unknown
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] as unknown as Unknown
    if (!isPlainObject(entry)) continue
    const where = `acceptedMapRevisions[${index}]`

    // Re-hash the payload (§13.1): the recorded revision must recompute.
    const payload = entry.payload
    if (isPlainObject(payload) && isCanonicalJsonValue(payload)) {
      const recomputed = tryCanonicalDigest(payload)
      if (recomputed !== undefined && recomputed !== entry.revision) {
        violations.push(`${where}.revision does not re-hash from its payload`)
      }
    }

    // The payload describes this map.
    if (
      isPlainObject(payload) &&
      isPlainObject(map) &&
      (payload.githubHost !== map.githubHost ||
        payload.repositoryId !== map.repositoryId ||
        payload.mapIssueId !== map.issueId)
    ) {
      violations.push(`${where}.payload must describe this map`)
    }

    if (index === 0) continue

    // Verify the recorded transition (§13.1, §7.4).
    const previous = entries[index - 1] as unknown as Unknown
    if (!isPlainObject(previous)) continue
    const extension = entry.extension
    if (!isPlainObject(extension)) {
      violations.push(`${where} must record its extension transition`)
      continue
    }
    if (extension.fromRevision !== previous.revision) {
      violations.push(`${where}.extension.fromRevision must equal the previous revision`)
    }
    verifyCompatibleExtension(previous, entry, where, violations)
  }
}

/**
 * Verify one recorded transition is a Compatible Map Extension (§7.4):
 * unchanged map specification, every previous member retained with the same
 * revision and complete blocker set, and the added-ticket delta recorded
 * exactly, sorted.
 */
function verifyCompatibleExtension(
  previous: Unknown,
  current: Unknown,
  where: string,
  violations: string[],
): void {
  const previousPayload = previous.payload
  const currentPayload = current.payload
  if (!isPlainObject(previousPayload) || !isPlainObject(currentPayload)) return

  for (const field of ['schema', 'githubHost', 'repositoryId', 'mapIssueId', 'title', 'body'] as const) {
    if (previousPayload[field] !== currentPayload[field]) {
      violations.push(`${where}: map ${field === 'mapIssueId' ? 'identity' : field} changed`)
    }
  }

  const previousMembers = readMembers(previousPayload)
  const currentMembers = readMembers(currentPayload)
  for (const [issueId, revision] of previousMembers) {
    const currentRevision = currentMembers.get(issueId)
    if (currentRevision === undefined) {
      violations.push(`${where}: accepted member "${issueId}" was removed`)
    } else if (currentRevision !== revision) {
      violations.push(`${where}: accepted member "${issueId}" changed its revision`)
    }
  }

  const previousBlockers = readBlockers(previousPayload)
  const currentBlockers = readBlockers(currentPayload)
  for (const [issueId, blockers] of previousBlockers) {
    if (!setsEqual(blockers, currentBlockers.get(issueId) ?? new Set())) {
      violations.push(`${where}: accepted member "${issueId}" changed its complete blocker set`)
    }
  }

  const added = [...currentMembers.keys()].filter((issueId) => !previousMembers.has(issueId))
  const extension = current.extension
  if (isPlainObject(extension) && Array.isArray(extension.addedTicketIssueIds)) {
    const recorded = extension.addedTicketIssueIds as unknown[]
    const recordedSorted = [...recorded].sort()
    if (!arraysEqual(recorded as string[], recordedSorted as string[])) {
      violations.push(`${where}: added ticket IDs must be sorted`)
    }
    if (!arraysEqual(recorded as string[], added)) {
      violations.push(`${where}: recorded added-ticket delta does not match the payloads`)
    }
  }
}

function readMembers(payload: Unknown): Map<string, string> {
  const members = new Map<string, string>()
  if (!Array.isArray(payload.members)) return members
  for (const entry of payload.members) {
    if (!isPlainObject(entry)) continue
    if (typeof entry.ticketIssueId === 'string' && typeof entry.ticketRevision === 'string') {
      members.set(entry.ticketIssueId, entry.ticketRevision)
    }
  }
  return members
}

function readBlockers(payload: Unknown): Map<string, Set<string>> {
  const blockers = new Map<string, Set<string>>()
  if (!Array.isArray(payload.dependencies)) return blockers
  for (const entry of payload.dependencies) {
    if (!isPlainObject(entry)) continue
    const blocker = entry.blockerIssueId
    const blocked = entry.blockedIssueId
    if (typeof blocker !== 'string' || typeof blocked !== 'string') continue
    const set = blockers.get(blocked) ?? new Set<string>()
    set.add(blocker)
    blockers.set(blocked, set)
  }
  return blockers
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const entry of a) {
    if (!b.has(entry)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function tryCanonicalDigest(value: CanonicalJsonValue): Sha256Digest | undefined {
  try {
    return canonicalJsonDigest(value)
  } catch {
    return undefined
  }
}

function stateIntegrityError(violations: readonly string[]): Outcome<never, never, 'state-integrity'> {
  return error({
    scope: 'operation',
    code: 'state-integrity',
    reason: `run state integrity check failed: ${violations.join('; ')}`,
    evidence: [{ violations: [...violations] }],
  })
}

function controlStoreError(what: string, cause: unknown): Outcome<never, never, 'control-store'> {
  return error({
    scope: 'operation',
    code: 'control-store',
    reason: `local control store failed while ${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
  })
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
