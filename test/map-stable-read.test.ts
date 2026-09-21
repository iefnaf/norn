import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isBlocked, isError, isOk } from '../src/core/outcome.ts'
import { stableReadTaskMap } from '../src/map/stable-read.ts'
import type { TaskMapLoadOutcome } from '../src/map/loader.ts'
import { evaluateTaskMapLoad } from '../src/map/snapshot.ts'
import type { RawTaskMapLoad } from '../src/map/loader.ts'
import { member, memberA, memberB, rawLoad, rawRef } from './helpers/map-fixtures.ts'

type Script = ReadonlyArray<TaskMapLoadOutcome>

/** A loader that replays a scripted sequence of outcomes, counting calls. */
function scriptedLoader(script: Script) {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    async load(): Promise<TaskMapLoadOutcome> {
      const outcome = script[calls]
      calls += 1
      if (outcome === undefined) throw new Error(`unexpected load #${calls}`)
      return outcome
    },
  }
}

const okLoad = (load: RawTaskMapLoad): TaskMapLoadOutcome => ({ kind: 'ok', value: load })

describe('stableReadTaskMap — convergence', () => {
  it('accepts after two adjacent identical loads and stops reading', async () => {
    const loader = scriptedLoader([okLoad(rawLoad([memberA()])), okLoad(rawLoad([memberA()]))])
    const outcome = await stableReadTaskMap(loader.load)
    assert.ok(isOk(outcome))
    assert.equal(loader.calls, 2)
    if (outcome.kind === 'ok') {
      assert.equal(outcome.value.ref.issueId, 'I_map')
      assert.equal(outcome.value.tickets.length, 1)
    }
  })

  it('accepts on the third load when only the second and third agree', async () => {
    const loader = scriptedLoader([
      okLoad(rawLoad([memberA()])),
      okLoad(rawLoad([memberA(), memberB()])),
      okLoad(rawLoad([memberA(), memberB()])),
    ])
    const outcome = await stableReadTaskMap(loader.load)
    assert.ok(isOk(outcome))
    assert.equal(loader.calls, 3)
    // The accepted snapshot is the later of the agreeing pair.
    if (outcome.kind === 'ok') assert.equal(outcome.value.tickets.length, 2)
  })

  it('compares map and ticket states, not just the revision', async () => {
    // Same revision, but ticket B moves OPEN → CLOSED between loads: the
    // first pair disagrees and acceptance needs the adjacent CLOSED pair.
    const loader = scriptedLoader([
      okLoad(rawLoad([memberA(), memberB()])),
      okLoad(rawLoad([memberA(), member('I_B', 2, { blockers: [rawRef('I_A', 1)], state: 'CLOSED' })])),
      okLoad(rawLoad([memberA(), member('I_B', 2, { blockers: [rawRef('I_A', 1)], state: 'CLOSED' })])),
    ])
    const outcome = await stableReadTaskMap(loader.load)
    assert.ok(isOk(outcome))
    assert.equal(loader.calls, 3)
    if (outcome.kind === 'ok') assert.equal(outcome.value.tickets[1]?.state, 'CLOSED')
  })

  it('is unaffected by display order differences between loads', async () => {
    const loader = scriptedLoader([
      okLoad(rawLoad([memberA(), memberB()])),
      okLoad(rawLoad([memberB(), memberA()])),
    ])
    const outcome = await stableReadTaskMap(loader.load)
    assert.ok(isOk(outcome))
    assert.equal(loader.calls, 2)
  })
})

describe('stableReadTaskMap — divergence', () => {
  it('reports blocked(changed-input) after three loads with no adjacent agreement', async () => {
    const loader = scriptedLoader([
      okLoad(rawLoad([memberA()])),
      okLoad(rawLoad([memberA(), memberB()])),
      okLoad(rawLoad([memberA(), memberB(), member('I_C', 3)])),
    ])
    const outcome = await stableReadTaskMap(loader.load)
    assert.ok(isBlocked(outcome))
    assert.equal(loader.calls, 3)
    if (outcome.kind === 'blocked') {
      assert.equal(outcome.code, 'changed-input')
      assert.equal(outcome.scope, 'operation')
      assert.equal(outcome.sharedWrite, 'none')
      const observed = outcome.evidence[0] as { observedLoads?: unknown[] }
      assert.equal(observed.observedLoads?.length, 3)
    }
  })

  it('does not accept a non-adjacent agreement: ABA divergence still blocks', async () => {
    const first = rawLoad([memberA()])
    const loader = scriptedLoader([
      okLoad(first),
      okLoad(rawLoad([memberA(), memberB()])),
      okLoad(first),
    ])
    const outcome = await stableReadTaskMap(loader.load)
    assert.ok(isBlocked(outcome))
    if (outcome.kind === 'blocked') assert.equal(outcome.code, 'changed-input')
  })

  it('never performs more than three loads', async () => {
    const loader = scriptedLoader([
      okLoad(rawLoad([memberA()])),
      okLoad(rawLoad([memberA(), memberB()])),
      okLoad(rawLoad([memberA(), memberB(), member('I_C', 3)])),
    ])
    await stableReadTaskMap(loader.load)
    assert.equal(loader.calls, 3)
  })
})

describe('stableReadTaskMap — loader failures and trustworthy facts', () => {
  it('propagates an adapter error immediately', async () => {
    const loader = scriptedLoader([
      { kind: 'error', scope: 'operation', code: 'github-unavailable', reason: 'dial tcp: timeout', sharedWrite: 'none', evidence: [] },
    ])
    const outcome = await stableReadTaskMap(loader.load)
    assert.ok(isError(outcome))
    assert.equal(loader.calls, 1)
    if (outcome.kind === 'error') assert.equal(outcome.code, 'github-unavailable')
  })

  it('propagates an error that arrives after a valid first load', async () => {
    const loader = scriptedLoader([
      okLoad(rawLoad([memberA()])),
      { kind: 'error', scope: 'operation', code: 'github-unavailable', reason: 'mid-read failure', sharedWrite: 'none', evidence: [] },
    ])
    const outcome = await stableReadTaskMap(loader.load)
    assert.ok(isError(outcome))
    assert.equal(loader.calls, 2)
  })

  it('returns a loader-reported trustworthy fact without retrying', async () => {
    const loader = scriptedLoader([
      {
        kind: 'blocked',
        scope: 'operation',
        code: 'issue-not-found',
        reason: 'no such issue',
        sharedWrite: 'none',
        evidence: [],
      },
    ])
    const outcome = await stableReadTaskMap(loader.load)
    assert.ok(isBlocked(outcome))
    assert.equal(loader.calls, 1)
    if (outcome.kind === 'blocked') assert.equal(outcome.code, 'issue-not-found')
  })
})

describe('stableReadTaskMap — structurally invalid loads', () => {
  // An invalid load is torn the same way a valid one can be; its finding set
  // must stabilize across two adjacent loads before it is reported.
  const invalidLoad = (): RawTaskMapLoad => rawLoad([memberA(), member('I_B', 2, { parents: [] })])

  it('accepts an invalid finding set after two adjacent identical loads', async () => {
    const loader = scriptedLoader([okLoad(invalidLoad()), okLoad(invalidLoad())])
    const outcome = await stableReadTaskMap(loader.load)
    assert.ok(isBlocked(outcome))
    assert.equal(loader.calls, 2)
    if (outcome.kind === 'blocked') {
      assert.equal(outcome.code, 'invalid-map')
      const first = outcome.evidence[0] as { findings?: Array<{ code: string }> }
      assert.deepEqual(first?.findings?.map((finding) => finding.code), ['member-not-child-of-map'])
    }
  })

  it('blocks with changed-input when findings keep changing across three loads', async () => {
    const otherInvalid = (): RawTaskMapLoad =>
      rawLoad([memberA(), member('I_B', 2, { subIssues: [rawRef('I_child', 9)] })])
    const loader = scriptedLoader([
      okLoad(invalidLoad()),
      okLoad(otherInvalid()),
      okLoad(invalidLoad()),
    ])
    const outcome = await stableReadTaskMap(loader.load)
    assert.ok(isBlocked(outcome))
    assert.equal(loader.calls, 3)
    if (outcome.kind === 'blocked') assert.equal(outcome.code, 'changed-input')
  })

  it('does not report findings from a single torn invalid read', async () => {
    // Load 1 invalid, load 2 valid, load 3 valid: the valid pair accepts.
    const loader = scriptedLoader([
      okLoad(invalidLoad()),
      okLoad(rawLoad([memberA()])),
      okLoad(rawLoad([memberA()])),
    ])
    const outcome = await stableReadTaskMap(loader.load)
    assert.ok(isOk(outcome))
    assert.equal(loader.calls, 3)
  })
})

describe('stableReadTaskMap — the accepted snapshot is the evaluated one', () => {
  it('round-trips through evaluateTaskMapLoad: revisions are recomputed, not copied', async () => {
    const load = rawLoad([memberA(), memberB()])
    const loader = scriptedLoader([okLoad(load), okLoad(load)])
    const outcome = await stableReadTaskMap(loader.load)
    assert.ok(isOk(outcome))
    if (outcome.kind === 'ok') {
      const direct = evaluateTaskMapLoad(load)
      assert.ok(direct.valid)
      assert.equal(outcome.value.mapRevision, direct.snapshot.mapRevision)
    }
  })
})
