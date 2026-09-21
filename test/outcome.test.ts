import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { canonicalJson } from '../src/core/canonical-json.ts'
import {
  blocked,
  error,
  isBlocked,
  isError,
  isOk,
  ok,
  validateOutcome,
} from '../src/core/outcome.ts'
import type { Evidence, Outcome, OutcomeScope, SharedWriteState } from '../src/core/outcome.ts'

const SCOPES: readonly OutcomeScope[] = ['operation', 'ticket', 'run']
const SHARED_WRITES: readonly SharedWriteState[] = ['none', 'confirmed', 'unknown']

/** Every kind/scope/shared-write combination the design permits. */
function sharedWriteAllowed(kind: 'blocked' | 'error', scope: OutcomeScope, sharedWrite: SharedWriteState): boolean {
  if (sharedWrite === 'unknown' && kind === 'blocked') return false // §9: only error may carry unknown
  if (scope === 'ticket' && sharedWrite !== 'none') return false // §9: ticket-scoped non-ok is none
  return true
}

describe('Outcome constructors: full kind/scope/shared-write cross product', () => {
  for (const scope of SCOPES) {
    for (const sharedWrite of SHARED_WRITES) {
      const legalBlocked = sharedWriteAllowed('blocked', scope, sharedWrite)
      const legalError = sharedWriteAllowed('error', scope, sharedWrite)

      it(`blocked ${scope}/${sharedWrite} -> ${legalBlocked ? 'ok' : 'rejected'}`, () => {
        const init = {
          scope,
          code: 'changed-input' as const,
          reason: 'map moved',
          sharedWrite: sharedWrite as never,
        }
        if (legalBlocked) {
          const outcome = blocked(init)
          assert.equal(outcome.kind, 'blocked')
          assert.equal(outcome.scope, scope)
          assert.equal(outcome.sharedWrite, sharedWrite)
          assert.equal(outcome.code, 'changed-input')
          assert.equal(outcome.reason, 'map moved')
          assert.deepEqual(outcome.evidence, [])
        } else {
          assert.throws(() => blocked(init), TypeError)
        }
      })

      it(`error ${scope}/${sharedWrite} -> ${legalError ? 'ok' : 'rejected'}`, () => {
        const init = {
          scope,
          code: 'gateway-unreachable' as const,
          reason: 'fetch failed',
          sharedWrite: sharedWrite as never,
        }
        if (legalError) {
          const outcome = error(init)
          assert.equal(outcome.kind, 'error')
          assert.equal(outcome.scope, scope)
          assert.equal(outcome.sharedWrite, sharedWrite)
          assert.equal(outcome.code, 'gateway-unreachable')
          assert.equal(outcome.reason, 'fetch failed')
          assert.deepEqual(outcome.evidence, [])
        } else {
          assert.throws(() => error(init), TypeError)
        }
      })
    }
  }

  it('counts the legal combinations exactly: blocked none/confirmed everywhere except ticket, error adds unknown', () => {
    const legalBlocked = SCOPES.flatMap((s) => SHARED_WRITES.filter((w) => sharedWriteAllowed('blocked', s, w)).map((w) => [s, w]))
    const legalError = SCOPES.flatMap((s) => SHARED_WRITES.filter((w) => sharedWriteAllowed('error', s, w)).map((w) => [s, w]))
    // blocked: operation/none, operation/confirmed, ticket/none, run/none, run/confirmed = 5
    assert.deepEqual(legalBlocked, [
      ['operation', 'none'],
      ['operation', 'confirmed'],
      ['ticket', 'none'],
      ['run', 'none'],
      ['run', 'confirmed'],
    ])
    // error: the same five plus operation/unknown and run/unknown = 7
    assert.deepEqual(legalError, [
      ['operation', 'none'],
      ['operation', 'confirmed'],
      ['operation', 'unknown'],
      ['ticket', 'none'],
      ['run', 'none'],
      ['run', 'confirmed'],
      ['run', 'unknown'],
    ])
  })
})

describe('ok', () => {
  it('carries exactly the validated value and nothing else', () => {
    const outcome = ok({ count: 3 })
    assert.deepEqual(outcome, { kind: 'ok', value: { count: 3 } })
  })

  it('accepts any operation value type', () => {
    assert.deepEqual(ok<null>(null), { kind: 'ok', value: null })
    assert.deepEqual(ok('passed'), { kind: 'ok', value: 'passed' })
    assert.deepEqual(ok([1, 2]), { kind: 'ok', value: [1, 2] })
  })
})

describe('Outcome constructor defaults and evidence handling', () => {
  it('defaults sharedWrite to none and evidence to an empty array', () => {
    const b = blocked({ scope: 'run', code: 'changed-input', reason: 'r' })
    assert.equal(b.sharedWrite, 'none')
    assert.deepEqual(b.evidence, [])
    const e = error({ scope: 'run', code: 'lock-lost', reason: 'r' })
    assert.equal(e.sharedWrite, 'none')
    assert.deepEqual(e.evidence, [])
  })

  it('carries serializable machine evidence verbatim', () => {
    const evidence: Evidence[] = [{ kind: 'test-report', exitCode: 1, argv: ['npm', 'test'] }]
    const outcome = blocked({ scope: 'operation', code: 'preflight-failed', reason: 'r', evidence })
    assert.deepEqual(outcome.evidence, evidence)
  })

  it('returns a fresh evidence array per call', () => {
    const outcome = blocked({ scope: 'run', code: 'changed-input', reason: 'r' })
    ;(outcome.evidence as Evidence[]).push({ sneak: true })
    assert.deepEqual(
      blocked({ scope: 'run', code: 'changed-input', reason: 'r' }).evidence,
      [],
    )
  })

  it('rejects evidence that is not serializable machine data', () => {
    for (const bad of [
      { nested: undefined },
      { fn: () => 1 },
      [NaN],
      { deep: { bad: 1n } },
      undefined,
    ]) {
      assert.throws(
        () => blocked({ scope: 'run', code: 'c', reason: 'r', evidence: [bad as never] }),
        TypeError,
        String(bad),
      )
      assert.throws(
        () => error({ scope: 'run', code: 'c', reason: 'r', evidence: [bad as never] }),
        TypeError,
      )
    }
  })

  it('builds outcomes that serialize as canonical JSON for run-state persistence', () => {
    const outcome = error({
      scope: 'run',
      code: 'push-unknown',
      reason: 'r',
      sharedWrite: 'unknown',
      evidence: [{ stage: 'push' }],
    })
    assert.equal(
      canonicalJson(outcome as never),
      '{"code":"push-unknown","evidence":[{"stage":"push"}],"kind":"error","reason":"r","scope":"run","sharedWrite":"unknown"}',
    )
  })
})

describe('Outcome type guards', () => {
  type CheckOutcome = Outcome<number, 'changed-input' | 'invalid-config', 'lock-lost'>

  it('narrows each kind of a closed outcome union', () => {
    const outcomes: CheckOutcome[] = [
      ok(7),
      blocked({ scope: 'run', code: 'changed-input', reason: 'r', sharedWrite: 'confirmed' }),
      error({ scope: 'ticket', code: 'lock-lost', reason: 'r' }),
    ]
    for (const outcome of outcomes) {
      if (isOk(outcome)) {
        assert.equal(typeof outcome.value, 'number')
      } else if (isBlocked(outcome)) {
        assert.equal(outcome.kind, 'blocked')
        assert.notEqual(outcome.sharedWrite, 'unknown')
      } else if (isError(outcome)) {
        assert.equal(outcome.kind, 'error')
      }
    }
  })

  it('keeps the closed code unions on each narrowed branch', () => {
    const outcome: CheckOutcome = blocked({ scope: 'ticket', code: 'invalid-config', reason: 'r' })
    if (isBlocked(outcome)) {
      const code: 'changed-input' | 'invalid-config' = outcome.code
      assert.equal(code, 'invalid-config')
    } else {
      assert.fail('expected blocked')
    }
  })
})

describe('validateOutcome', () => {
  it('accepts every constructor-produced legal combination', () => {
    const samples: unknown[] = [ok(1), ok({ any: 'value' })]
    for (const scope of SCOPES) {
      for (const sharedWrite of SHARED_WRITES) {
        if (sharedWriteAllowed('blocked', scope, sharedWrite)) {
          samples.push(
            blocked({ scope, code: 'c', reason: 'r', sharedWrite: sharedWrite as never }),
          )
        }
        if (sharedWriteAllowed('error', scope, sharedWrite)) {
          samples.push(error({ scope, code: 'c', reason: 'r', sharedWrite: sharedWrite as never }))
        }
      }
    }
    for (const sample of samples) {
      assert.equal(validateOutcome(sample), true)
    }
  })

  it('rejects structural violations of the outcome model', () => {
    for (const invalid of [
      null,
      'ok',
      {},
      { kind: 'skipped' },
      { kind: 'ok' },
      { kind: 'ok', value: 1, sharedWrite: 'none' },
      { kind: 'ok', value: 1, scope: 'operation' },
      { kind: 'ok', value: 1, evidence: [] },
      { kind: 'blocked', code: 'c', reason: 'r', sharedWrite: 'none', evidence: [] },
      { kind: 'blocked', scope: 'wave', code: 'c', reason: 'r', sharedWrite: 'none', evidence: [] },
      { kind: 'blocked', scope: 'run', reason: 'r', sharedWrite: 'none', evidence: [] },
      { kind: 'blocked', scope: 'run', code: 7, reason: 'r', sharedWrite: 'none', evidence: [] },
      { kind: 'blocked', scope: 'run', code: 'c', sharedWrite: 'none', evidence: [] },
      { kind: 'blocked', scope: 'run', code: 'c', reason: 7, sharedWrite: 'none', evidence: [] },
      { kind: 'blocked', scope: 'run', code: 'c', reason: 'r', sharedWrite: 'maybe', evidence: [] },
      { kind: 'blocked', scope: 'run', code: 'c', reason: 'r', sharedWrite: 'none', evidence: 'x' },
      { kind: 'blocked', scope: 'run', code: 'c', reason: 'r', sharedWrite: 'none', evidence: [undefined] },
      { kind: 'blocked', scope: 'run', code: 'c', reason: 'r', sharedWrite: 'none', evidence: [{ x: NaN }] },
      // blocked never carries unknown:
      { kind: 'blocked', scope: 'run', code: 'c', reason: 'r', sharedWrite: 'unknown', evidence: [] },
      { kind: 'blocked', scope: 'operation', code: 'c', reason: 'r', sharedWrite: 'unknown', evidence: [] },
      // ticket-scoped non-ok must be none:
      { kind: 'blocked', scope: 'ticket', code: 'c', reason: 'r', sharedWrite: 'confirmed', evidence: [] },
      { kind: 'error', scope: 'ticket', code: 'c', reason: 'r', sharedWrite: 'confirmed', evidence: [] },
      { kind: 'error', scope: 'ticket', code: 'c', reason: 'r', sharedWrite: 'unknown', evidence: [] },
    ]) {
      assert.equal(validateOutcome(invalid), false, JSON.stringify(invalid))
    }
  })
})
