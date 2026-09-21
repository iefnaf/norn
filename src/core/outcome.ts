/**
 * The Outcome model (design.md §9).
 *
 * Every Norn operation answers three independent questions in code, not in
 * terminal prose: what Norn knows (`kind`), how far a non-success propagates
 * (`scope`), and whether an externally visible shared write may have occurred
 * (`sharedWrite`).
 *
 * The constructors below enforce the structural invariants of design.md §9 at
 * the only place values may be created, and `validateOutcome` re-checks them
 * for outcomes arriving from untrusted or persisted shapes. Pure data and
 * functions only: no adapter, I/O, or clock.
 */
import type { CanonicalJsonValue } from './canonical-json.ts'
import { isCanonicalJsonValue } from './canonical-json.ts'

export type OutcomeScope = 'operation' | 'ticket' | 'run'

export type SharedWriteState = 'none' | 'confirmed' | 'unknown'

/** A shared-write state whose exact remote effect is proved (design.md §9). */
export type KnownSharedWriteState = Exclude<SharedWriteState, 'unknown'>

/**
 * Serializable, operation-specific machine data. Terminal text and unbound
 * agent claims are not evidence (design.md §9).
 */
export type Evidence = CanonicalJsonValue

export type OutcomeOk<T> = {
  readonly kind: 'ok'
  readonly value: T
}

export type OutcomeBlocked<BlockCode extends string> = {
  readonly kind: 'blocked'
  readonly scope: OutcomeScope
  readonly code: BlockCode
  readonly reason: string
  /** `blocked` never carries `unknown`; its shared-write state is known. */
  readonly sharedWrite: KnownSharedWriteState
  readonly evidence: readonly Evidence[]
}

export type OutcomeError<ErrorCode extends string> = {
  readonly kind: 'error'
  readonly scope: OutcomeScope
  readonly code: ErrorCode
  readonly reason: string
  readonly sharedWrite: SharedWriteState
  readonly evidence: readonly Evidence[]
}

/**
 * The generic outcome type. Each operation fixes `BlockCode` and `ErrorCode`
 * to closed string-literal unions and defines its allowed evidence payloads;
 * production code never branches on `reason` or rendered prose.
 */
export type Outcome<T, BlockCode extends string, ErrorCode extends string> =
  | OutcomeOk<T>
  | OutcomeBlocked<BlockCode>
  | OutcomeError<ErrorCode>

export type OutcomeKind = Outcome<unknown, string, string>['kind']

function checkSharedWrite(
  kind: 'blocked' | 'error',
  scope: OutcomeScope,
  sharedWrite: SharedWriteState,
): void {
  if (kind === 'blocked' && sharedWrite === 'unknown') {
    throw new TypeError("a 'blocked' outcome never carries sharedWrite 'unknown' (design.md §9)")
  }
  if (scope === 'ticket' && sharedWrite !== 'none') {
    throw new TypeError("a ticket-scoped non-'ok' outcome must have sharedWrite 'none' (design.md §9)")
  }
}

function checkEvidence(kind: 'blocked' | 'error', evidence: readonly unknown[]): void {
  for (const entry of evidence) {
    if (!isCanonicalJsonValue(entry)) {
      throw new TypeError(
        `${kind} outcome evidence must be serializable machine data, got ${String(entry)}`,
      )
    }
  }
}

/**
 * Build an `ok`: the operation completed and its value was validated. Any
 * protocol-required evidence travels inside the value, not in a generic
 * evidence array (design.md §9).
 */
export function ok<T>(value: T): OutcomeOk<T> {
  return { kind: 'ok', value }
}

export type BlockedInit<BlockCode extends string> = {
  readonly scope: OutcomeScope
  readonly code: BlockCode
  readonly reason: string
  /** Defaults to `'none'`; a ticket scope permits only `'none'`. */
  readonly sharedWrite?: KnownSharedWriteState
  readonly evidence?: readonly Evidence[]
}

/**
 * Build a `blocked`: trustworthy facts establish that progress requires
 * changed code, input, configuration, or an operator decision. Its
 * shared-write state is known — `unknown` is rejected — and a ticket scope
 * requires `sharedWrite: 'none'`.
 */
export function blocked<BlockCode extends string>(
  init: BlockedInit<BlockCode>,
): OutcomeBlocked<BlockCode> {
  const sharedWrite = init.sharedWrite ?? 'none'
  checkSharedWrite('blocked', init.scope, sharedWrite)
  const evidence = [...(init.evidence ?? [])]
  checkEvidence('blocked', evidence)
  return {
    kind: 'blocked',
    scope: init.scope,
    code: init.code,
    reason: init.reason,
    sharedWrite,
    evidence,
  }
}

export type ErrorInit<ErrorCode extends string> = {
  readonly scope: OutcomeScope
  readonly code: ErrorCode
  readonly reason: string
  /** Defaults to `'none'`; a ticket scope permits only `'none'`. */
  readonly sharedWrite?: SharedWriteState
  readonly evidence?: readonly Evidence[]
}

/**
 * Build an `error`: the facts required for a safe domain decision could not be
 * established. This is the only kind permitted to carry
 * `sharedWrite: 'unknown'`; a ticket scope still requires `'none'`.
 */
export function error<ErrorCode extends string>(
  init: ErrorInit<ErrorCode>,
): OutcomeError<ErrorCode> {
  const sharedWrite = init.sharedWrite ?? 'none'
  checkSharedWrite('error', init.scope, sharedWrite)
  const evidence = [...(init.evidence ?? [])]
  checkEvidence('error', evidence)
  return {
    kind: 'error',
    scope: init.scope,
    code: init.code,
    reason: init.reason,
    sharedWrite,
    evidence,
  }
}

export function isOk<T, BlockCode extends string, ErrorCode extends string>(
  outcome: Outcome<T, BlockCode, ErrorCode>,
): outcome is OutcomeOk<T> {
  return outcome.kind === 'ok'
}

export function isBlocked<T, BlockCode extends string, ErrorCode extends string>(
  outcome: Outcome<T, BlockCode, ErrorCode>,
): outcome is OutcomeBlocked<BlockCode> {
  return outcome.kind === 'blocked'
}

export function isError<T, BlockCode extends string, ErrorCode extends string>(
  outcome: Outcome<T, BlockCode, ErrorCode>,
): outcome is OutcomeError<ErrorCode> {
  return outcome.kind === 'error'
}

/**
 * Structural validation of an outcome-shaped value, enforcing every invariant
 * of design.md §9. Use for outcomes arriving from persistence or an adapter;
 * values built with `ok`, `blocked`, and `error` always satisfy it.
 *
 * Rejects unknown kinds, non-`ok` kinds carrying `'unknown'` shared writes out
 * of turn, ticket-scoped non-`ok` values with a shared write, non-serializable
 * evidence, and fields that must not exist on the given kind (an `ok` carries
 * no scope, code, reason, shared-write state, or evidence array).
 */
export function validateOutcome(value: unknown): value is Outcome<unknown, string, string> {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>

  switch (candidate.kind) {
    case 'ok': {
      const carriesNonOkFields =
        'scope' in candidate ||
        'code' in candidate ||
        'reason' in candidate ||
        'sharedWrite' in candidate ||
        'evidence' in candidate
      return 'value' in candidate && !carriesNonOkFields
    }
    case 'blocked':
    case 'error': {
      if (!isOutcomeScope(candidate.scope)) return false
      if (typeof candidate.code !== 'string') return false
      if (typeof candidate.reason !== 'string') return false
      if (!isSharedWriteState(candidate.sharedWrite)) return false
      if (candidate.kind === 'blocked' && candidate.sharedWrite === 'unknown') return false
      if (candidate.scope === 'ticket' && candidate.sharedWrite !== 'none') return false
      if (!Array.isArray(candidate.evidence)) return false
      return candidate.evidence.every(isCanonicalJsonValue)
    }
    default:
      return false
  }
}

function isOutcomeScope(value: unknown): value is OutcomeScope {
  return value === 'operation' || value === 'ticket' || value === 'run'
}

function isSharedWriteState(value: unknown): value is SharedWriteState {
  return value === 'none' || value === 'confirmed' || value === 'unknown'
}
