/**
 * Agent completion sidecars (design.md §17).
 *
 * Every worker or reviewer agent invocation owns exactly one completion
 * sidecar under `<repository-home>/runs/<run-id>/completions/` — a run-owned
 * area outside any source workspace. The sidecar binds the typed handoff or
 * verdict to the run, role, phase, relevant Map or Ticket, work attempt,
 * workspace, and Pi session identity, and is created atomically by the
 * completion extension the agent loads.
 *
 * The sidecar is never business evidence: Norn independently verifies Git
 * state, tests, review bindings, and remote facts before accepting an
 * outcome. Orchestration consumes only the typed discriminants and codes
 * carried here.
 */
import { mkdir, opendir, readFile, link, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

import { canonicalJson } from '../core/canonical-json.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'

export const AGENT_COMPLETION_SCHEMA = 'norn-agent-completion:v1' as const

export type AgentRole = 'worker' | 'reviewer'

/** Phases in which Norn launches agent invocations (design.md §10, §11, §15). */
export type AgentPhase = 'work' | 'ship' | 'map-completion'

/**
 * A Git object OID with its object format, for example `sha1:<hex>` or
 * `sha256:<hex>` (design.md §10.3). Worker candidate handoffs carry claimed
 * OIDs; Norn re-reads both independently before accepting them.
 */
export type GitObjectOid = string

export const GIT_OBJECT_OID_PATTERN = /^(?:sha1:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/

export function isGitObjectOid(value: unknown): value is GitObjectOid {
  return typeof value === 'string' && GIT_OBJECT_OID_PATTERN.test(value)
}

/**
 * Closed machine codes for a typed worker block (design.md §10.2). The design
 * fixes the shape — a closed code plus an operator-facing reason — without
 * enumerating the codes; this union is the v1 closed set. Only the
 * discriminant and code control orchestration.
 */
export type WorkerBlockCode =
  | 'cannot-satisfy-spec'
  | 'requires-operator-decision'
  | 'workspace-unusable'

export const WORKER_BLOCK_CODES: readonly WorkerBlockCode[] = [
  'cannot-satisfy-spec',
  'requires-operator-decision',
  'workspace-unusable',
]

/** Closed machine codes for a typed reviewer block verdict (design.md §10.2). */
export type ReviewerBlockCode = 'spec-defect' | 'unsafe-change' | 'evidence-mismatch'

export const REVIEWER_BLOCK_CODES: readonly ReviewerBlockCode[] = [
  'spec-defect',
  'unsafe-change',
  'evidence-mismatch',
]

/**
 * A typed worker handoff (design.md §10.2): either a `candidate` carrying the
 * claimed commit and tree OIDs, or a `block` carrying a closed machine code
 * and an operator-facing reason.
 */
export type WorkerCompletion =
  | {
      readonly discriminant: 'candidate'
      readonly claimedCommit: GitObjectOid
      readonly claimedTreeOid: GitObjectOid
    }
  | {
      readonly discriminant: 'block'
      readonly code: WorkerBlockCode
      readonly reason: string
    }

/**
 * A typed reviewer verdict (design.md §10.2): `pass`, `iterate`, or `block`.
 * Findings and feedback prose travel with the verdict but are feedback only;
 * verdict discriminants control orchestration.
 */
export type ReviewerCompletion =
  | { readonly discriminant: 'pass' }
  | { readonly discriminant: 'iterate'; readonly feedback: string }
  | { readonly discriminant: 'block'; readonly code: ReviewerBlockCode; readonly reason: string }

export type AgentCompletion = WorkerCompletion | ReviewerCompletion

/** Stable identity of the Task Map the run works (design.md §7.3). */
export type AgentMapBinding = {
  readonly githubHost: string
  readonly repositoryId: string
  readonly issueId: string
}

/** Stable identity plus the display locator of the relevant member Ticket. */
export type AgentTicketBinding = AgentMapBinding & {
  readonly number: number
}

/**
 * The immutable Work input bound into Work-phase sidecars (design.md §10.1,
 * §17): the effective Ticket specification revisions and the Wave target.
 * Titles and bodies are the normalized specification text agents received.
 */
export type AgentWorkInputBinding = {
  readonly mapTitle: string
  readonly mapBody: string
  readonly mapRevision: string
  readonly ticketTitle: string
  readonly ticketBody: string
  readonly ticketRevision: string
  readonly target: {
    readonly branch: string
    readonly baseSha: GitObjectOid
    readonly baseTreeOid: GitObjectOid
  }
}

/** Extra Work identity bound into Work-phase sidecars (design.md §17). */
export type AgentWorkBinding = {
  readonly workAttemptId: string
  readonly round: number
  readonly input: AgentWorkInputBinding
}

/** The run-owned workspace the agent invocation runs in (design.md §10.1). */
export type AgentWorkspaceBinding = {
  readonly kind: 'ticket' | 'map-completion'
  readonly path: string
}

/**
 * The coordinator-owned launch context handed to an agent invocation. Every
 * field except the typed completion travels from the coordinator through the
 * child environment (`NORN_AGENT_CONTEXT`); the agent supplies only its typed
 * handoff or verdict. The completion extension echoes this context into the
 * sidecar, and settlement validates the echo field by field.
 */
export type AgentCompletionContext = {
  readonly schema: typeof AGENT_COMPLETION_SCHEMA
  readonly invocationId: string
  readonly runId: string
  readonly role: AgentRole
  readonly phase: AgentPhase
  readonly map: AgentMapBinding
  readonly ticket?: AgentTicketBinding
  readonly work?: AgentWorkBinding
  readonly workspace: AgentWorkspaceBinding
  readonly piSessionId: string
  /** Run-owned completions area, outside every source workspace. */
  readonly completionsDir: string
}

/**
 * The completion sidecar document: the launch context bindings plus the typed
 * completion and a sealed timestamp. Stored as one canonical-JSON file per
 * invocation at `<completionsDir>/<invocationId>.json`.
 */
export type AgentCompletionSidecar = Omit<AgentCompletionContext, 'completionsDir'> & {
  readonly completion: AgentCompletion
  readonly recordedAt: string
}

/** Invocation IDs become file names and Herdr agent names; keep them tame. */
export const AGENT_INVOCATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/

export function isAgentInvocationId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_INVOCATION_ID_PATTERN.test(value)
}

/** RFC 3339 UTC timestamp with exactly three fractional digits (design.md §14). */
export const AGENT_RECORDED_AT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** Render `at` (default now) in the sealed timestamp format of design.md §14. */
export function agentRecordedAt(at: Date = new Date()): string {
  const pad = (width: number, value: number): string => String(value).padStart(width, '0')
  return (
    `${pad(4, at.getUTCFullYear())}-${pad(2, at.getUTCMonth() + 1)}-${pad(2, at.getUTCDate())}` +
    `T${pad(2, at.getUTCHours())}:${pad(2, at.getUTCMinutes())}:${pad(2, at.getUTCSeconds())}` +
    `.${pad(3, at.getUTCMilliseconds())}Z`
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.getPrototypeOf(value) === Object.prototype
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function readMapBinding(value: Record<string, unknown>): AgentMapBinding | undefined {
  if (!isNonEmptyString(value.githubHost)) return undefined
  if (!isNonEmptyString(value.repositoryId)) return undefined
  if (!isNonEmptyString(value.issueId)) return undefined
  return {
    githubHost: value.githubHost,
    repositoryId: value.repositoryId,
    issueId: value.issueId,
  }
}

function readTicketBinding(value: unknown): AgentTicketBinding | undefined {
  if (!isPlainObject(value)) return undefined
  const map = readMapBinding(value)
  if (!map) return undefined
  if (!isPositiveInteger(value.number)) return undefined
  return { ...map, number: value.number }
}

function readWorkInput(value: unknown): AgentWorkInputBinding | undefined {
  if (!isPlainObject(value)) return undefined
  for (const field of [
    'mapTitle',
    'mapBody',
    'mapRevision',
    'ticketTitle',
    'ticketBody',
    'ticketRevision',
  ] as const) {
    if (typeof value[field] !== 'string') return undefined
  }
  const target = value.target
  if (!isPlainObject(target)) return undefined
  if (typeof target.branch !== 'string' || target.branch.length === 0) return undefined
  if (!isGitObjectOid(target.baseSha) || !isGitObjectOid(target.baseTreeOid)) return undefined
  return {
    mapTitle: value.mapTitle as string,
    mapBody: value.mapBody as string,
    mapRevision: value.mapRevision as string,
    ticketTitle: value.ticketTitle as string,
    ticketBody: value.ticketBody as string,
    ticketRevision: value.ticketRevision as string,
    target: {
      branch: target.branch as string,
      baseSha: target.baseSha as string,
      baseTreeOid: target.baseTreeOid as string,
    },
  }
}

/**
 * Structural validation of a typed worker handoff. `unknown` keeps this usable
 * for both tool-call parameters arriving in a Pi process and parsed sidecar
 * content; only the closed discriminants and codes pass.
 */
export function validateWorkerCompletion(value: unknown): WorkerCompletion | undefined {
  if (!isPlainObject(value)) return undefined
  switch (value.discriminant) {
    case 'candidate':
      if (!isGitObjectOid(value.claimedCommit)) return undefined
      if (!isGitObjectOid(value.claimedTreeOid)) return undefined
      return {
        discriminant: 'candidate',
        claimedCommit: value.claimedCommit,
        claimedTreeOid: value.claimedTreeOid,
      }
    case 'block':
      if (!WORKER_BLOCK_CODES.includes(value.code as WorkerBlockCode)) return undefined
      if (typeof value.reason !== 'string' || value.reason.length === 0) return undefined
      return { discriminant: 'block', code: value.code as WorkerBlockCode, reason: value.reason }
    default:
      return undefined
  }
}

/** Structural validation of a typed reviewer verdict. */
export function validateReviewerCompletion(value: unknown): ReviewerCompletion | undefined {
  if (!isPlainObject(value)) return undefined
  switch (value.discriminant) {
    case 'pass':
      return { discriminant: 'pass' }
    case 'iterate':
      if (typeof value.feedback !== 'string' || value.feedback.length === 0) return undefined
      return { discriminant: 'iterate', feedback: value.feedback }
    case 'block':
      if (!REVIEWER_BLOCK_CODES.includes(value.code as ReviewerBlockCode)) return undefined
      if (typeof value.reason !== 'string' || value.reason.length === 0) return undefined
      return { discriminant: 'block', code: value.code as ReviewerBlockCode, reason: value.reason }
    default:
      return undefined
  }
}

/** Validate the typed completion expected for `role`; the other role's shapes are rejected. */
export function validateCompletionForRole(
  value: unknown,
  role: AgentRole,
): AgentCompletion | undefined {
  return role === 'worker' ? validateWorkerCompletion(value) : validateReviewerCompletion(value)
}

function readWorkBinding(value: unknown): AgentWorkBinding | undefined {
  if (!isPlainObject(value)) return undefined
  if (!isNonEmptyString(value.workAttemptId)) return undefined
  if (!isPositiveInteger(value.round)) return undefined
  const input = readWorkInput(value.input)
  if (!input) return undefined
  return { workAttemptId: value.workAttemptId, round: value.round, input }
}

function readWorkspaceBinding(value: unknown): AgentWorkspaceBinding | undefined {
  if (!isPlainObject(value)) return undefined
  if (value.kind !== 'ticket' && value.kind !== 'map-completion') return undefined
  if (!isAbsolute(String(value.path))) return undefined
  return { kind: value.kind, path: value.path as string }
}

/**
 * Validate a completion context: every binding the sidecar protocol requires,
 * the role/phase consistency rules of design.md §17 (workers run in Work;
 * reviewers in Work, Ship, or map completion), and the run-owned placement of
 * the completions area outside the source workspace.
 */
export function validateCompletionContext(value: unknown): AgentCompletionContext | undefined {
  if (!isPlainObject(value)) return undefined
  if (value.schema !== AGENT_COMPLETION_SCHEMA) return undefined
  if (!isAgentInvocationId(value.invocationId)) return undefined
  if (!isNonEmptyString(value.runId)) return undefined
  if (value.role !== 'worker' && value.role !== 'reviewer') return undefined
  if (value.phase !== 'work' && value.phase !== 'ship' && value.phase !== 'map-completion') {
    return undefined
  }

  if (!isPlainObject(value.map)) return undefined
  const map = readMapBinding(value.map)
  if (!map) return undefined

  const ticket = 'ticket' in value ? readTicketBinding(value.ticket) : undefined
  if ('ticket' in value && ticket === undefined) return undefined

  const work = 'work' in value ? readWorkBinding(value.work) : undefined
  if ('work' in value && work === undefined) return undefined

  const workspace = readWorkspaceBinding(value.workspace)
  if (!workspace) return undefined

  if (!isNonEmptyString(value.piSessionId)) return undefined
  if (typeof value.completionsDir !== 'string' || !isAbsolute(value.completionsDir)) {
    return undefined
  }

  if (value.role === 'worker' && value.phase !== 'work') return undefined
  if (value.role === 'worker' && work === undefined) return undefined
  if (work !== undefined && value.phase !== 'work') return undefined
  if (value.phase === 'map-completion' && ticket !== undefined) return undefined
  if ((value.phase === 'work' || value.phase === 'ship') && ticket === undefined) return undefined

  const completionsDir = resolve(value.completionsDir)
  const workspacePath = resolve(workspace.path)
  if (workspacePath === completionsDir || isInsideDirectory(completionsDir, workspacePath)) {
    return undefined
  }

  return {
    schema: AGENT_COMPLETION_SCHEMA,
    invocationId: value.invocationId,
    runId: value.runId,
    role: value.role,
    phase: value.phase,
    map,
    ...(ticket === undefined ? {} : { ticket }),
    ...(work === undefined ? {} : { work }),
    workspace,
    piSessionId: value.piSessionId,
    completionsDir,
  }
}

/**
 * Build the sidecar document for `context` and `completion`. Pure: the same
 * inputs always produce the same canonical bytes for a given `recordedAt`,
 * which is what makes an identical resubmission byte-identical and a
 * differing resubmission a rejected conflict.
 */
export function sidecarDocument(
  context: AgentCompletionContext,
  completion: AgentCompletion,
  recordedAt: string,
): AgentCompletionSidecar {
  const { completionsDir: _completionsDir, ...bindings } = context
  return { ...bindings, completion, recordedAt }
}

export function encodeSidecar(sidecar: AgentCompletionSidecar): string {
  return canonicalJson(sidecar as unknown as CanonicalJsonValue) + '\n'
}

export type SidecarProblem = 'unparseable' | 'invalid-shape' | 'binding-mismatch'

export type SidecarRead =
  | { readonly status: 'valid'; readonly sidecar: AgentCompletionSidecar; readonly bytes: string }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly problem: SidecarProblem }

/**
 * Validate a parsed sidecar-shaped value against the expected launch context:
 * every binding must match exactly, the completion must be valid for the
 * role, and the timestamp must use the sealed format. Returns the validated
 * sidecar or the first problem found; the distinction between an invalid
 * document and a mismatched binding is machine data for settlement errors.
 */
export function validateSidecarAgainstContext(
  value: unknown,
  expected: AgentCompletionContext,
): { readonly sidecar: AgentCompletionSidecar } | { readonly problem: SidecarProblem } {
  if (!isPlainObject(value)) return { problem: 'invalid-shape' }
  if (value.schema !== AGENT_COMPLETION_SCHEMA) return { problem: 'invalid-shape' }
  if (!isAgentInvocationId(value.invocationId)) return { problem: 'invalid-shape' }
  if (value.recordedAt === undefined || !AGENT_RECORDED_AT_PATTERN.test(String(value.recordedAt))) {
    return { problem: 'invalid-shape' }
  }

  const completion = validateCompletionForRole(value.completion, expected.role)
  if (completion === undefined) return { problem: 'invalid-shape' }

  // The sidecar must echo the launch context exactly (design.md §17): the
  // agent supplies only the typed completion; every binding is coordinator
  // owned and a mismatch voids the settlement. Comparisons are order-safe
  // because both sides are canonicalized before comparison.
  const mismatch =
    value.invocationId !== expected.invocationId ||
    value.runId !== expected.runId ||
    value.role !== expected.role ||
    value.phase !== expected.phase ||
    !sameJson(value.map, expected.map) ||
    !sameOptionalJson(value.ticket, expected.ticket) ||
    workBindingMismatches(value.work, expected.work) ||
    !sameJson(value.workspace, expected.workspace) ||
    value.piSessionId !== expected.piSessionId
  if (mismatch) return { problem: 'binding-mismatch' }

  const { completionsDir: _drop, ...bindings } = expected
  const sidecar: AgentCompletionSidecar = { ...bindings, completion, recordedAt: String(value.recordedAt) }
  return { sidecar }
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a as CanonicalJsonValue) === canonicalJson(b as CanonicalJsonValue)
  } catch {
    return false
  }
}

function sameOptionalJson(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === undefined && b === undefined
  return sameJson(a, b)
}

function workBindingMismatches(a: unknown, b: AgentWorkBinding | undefined): boolean {
  if (b === undefined || !isPlainObject(a)) return b === undefined ? a !== undefined : true
  return a.workAttemptId !== b.workAttemptId || a.round !== b.round || !sameJson(a.input, b.input)
}

/**
 * The run-owned completion store (design.md §17): one canonical-JSON sidecar
 * file per agent invocation, created atomically and exclusively. A second
 * write for the same invocation is rejected unless byte-identical.
 */
export class CompletionStore {
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  /** Sidecar file path for an invocation; no other files live in `dir`. */
  pathFor(invocationId: string): string {
    return resolve(this.dir, `${invocationId}.json`)
  }

  /**
   * Atomically create the sidecar for `invocationId`. The document is written
   * to a temporary file and linked into place, so a reader either sees the
   * complete canonical bytes or nothing — never a torn write.
   *
   * Returns `identical` when the exact same bytes already exist (an idempotent
   * retry) and `conflict` when a sidecar already exists with different
   * content: the second, conflicting completion is rejected and the original
   * bytes are preserved untouched.
   */
  async write(
    context: AgentCompletionContext,
    completion: AgentCompletion,
    recordedAt: string,
  ): Promise<CompletionWriteResult> {
    const dest = this.pathFor(context.invocationId)
    const contents = encodeSidecar(sidecarDocument(context, completion, recordedAt))
    await mkdir(dirname(dest), { recursive: true })

    const tmp = dirname(dest) + `/.${basename(dest)}.${process.pid}-${randomUUID()}.tmp`
    await writeFile(tmp, contents, 'utf8')
    try {
      await link(tmp, dest)
    } catch (cause) {
      if (!isFileExistsError(cause)) throw cause
      const existing = await readFile(dest, 'utf8')
      return existing === contents
        ? { status: 'identical' }
        : { status: 'conflict', existingBytes: existing }
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
    await flushDirectory(dirname(dest))
    return { status: 'written' }
  }

  /**
   * Read and validate the sidecar for `invocationId` against `expected`.
   * A file that fails to parse is `unparseable`; a parsed document that is
   * structurally invalid is `invalid-shape`; a well-formed document whose
   * bindings do not echo the expected launch context is `binding-mismatch`.
   */
  async read(invocationId: string, expected: AgentCompletionContext): Promise<SidecarRead> {
    let bytes: string
    try {
      bytes = await readFile(this.pathFor(invocationId), 'utf8')
    } catch (cause) {
      if (isFileNotFoundError(cause)) return { status: 'missing' }
      throw cause
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(bytes)
    } catch {
      return { status: 'invalid', problem: 'unparseable' }
    }

    const validated = validateSidecarAgainstContext(parsed, expected)
    return 'sidecar' in validated
      ? { status: 'valid', sidecar: validated.sidecar, bytes }
      : { status: 'invalid', problem: validated.problem }
  }
}

export type CompletionWriteResult =
  | { readonly status: 'written' }
  | { readonly status: 'identical' }
  | { readonly status: 'conflict'; readonly existingBytes: string }

async function flushDirectory(path: string): Promise<void> {
  const handle = await opendir(path)
  await handle.close()
}

function isFileExistsError(cause: unknown): boolean {
  return isNodeError(cause) && cause.code === 'EEXIST'
}

function isFileNotFoundError(cause: unknown): boolean {
  return isNodeError(cause) && cause.code === 'ENOENT'
}

function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && 'code' in cause
}

/** True when `path` lies inside `dir` (used to keep run-owned areas disjoint). */
export function isInsideDirectory(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
