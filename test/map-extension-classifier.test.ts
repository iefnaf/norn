import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyMapChange } from '../src/map/map-extension.ts'
import { evaluateTaskMapLoad } from '../src/map/snapshot.ts'
import type { TaskMapSnapshot } from '../src/map/snapshot.ts'
import { member, memberA, memberB, rawLoad, rawRef } from './helpers/map-fixtures.ts'

function snapshotOf(members: readonly ReturnType<typeof member>[]): TaskMapSnapshot {
  const evaluation = evaluateTaskMapLoad(rawLoad(members))
  assert.ok(evaluation.valid)
  return evaluation.snapshot
}

/** Previously accepted tickets A and B, with `A → B`. */
function acceptedMap(): TaskMapSnapshot {
  return snapshotOf([memberA(), memberB()])
}

describe('classifyMapChange — identical continuation', () => {
  it('classifies the same snapshot as identical', () => {
    const accepted = acceptedMap()
    assert.deepEqual(classifyMapChange(accepted, snapshotOf([memberA(), memberB()])), {
      kind: 'identical',
    })
  })

  it('treats issue-state movement alone as identical — state is not specification', () => {
    const accepted = acceptedMap()
    const current = snapshotOf([
      member('I_A', 1, { state: 'CLOSED' }),
      memberB(),
    ])
    assert.deepEqual(classifyMapChange(accepted, current), { kind: 'identical' })
  })
})

describe('classifyMapChange — every design.md §7.4 table row', () => {
  it('add C with no blockers → compatible', () => {
    const current = snapshotOf([memberA(), memberB(), member('I_C', 3)])
    assert.deepEqual(classifyMapChange(acceptedMap(), current), {
      kind: 'compatible-extension',
      addedTicketIssueIds: ['I_C'],
    })
  })

  it('add `A → C` → compatible: a new ticket may depend on an existing one', () => {
    const current = snapshotOf([
      memberA(),
      memberB(),
      member('I_C', 3, { blockers: [rawRef('I_A', 1)] }),
    ])
    assert.deepEqual(classifyMapChange(acceptedMap(), current), {
      kind: 'compatible-extension',
      addedTicketIssueIds: ['I_C'],
    })
  })

  it('add `C → D` with C and D together → compatible', () => {
    const current = snapshotOf([
      memberA(),
      memberB(),
      member('I_C', 3),
      member('I_D', 4, { blockers: [rawRef('I_C', 3)] }),
    ])
    assert.deepEqual(classifyMapChange(acceptedMap(), current), {
      kind: 'compatible-extension',
      addedTicketIssueIds: ['I_C', 'I_D'],
    })
  })

  it('add `C → A` → incompatible: an existing ticket gains a blocker', () => {
    const current = snapshotOf([
      member('I_A', 1, { blockers: [rawRef('I_C', 3)] }),
      memberB(),
      member('I_C', 3),
    ])
    const classification = classifyMapChange(acceptedMap(), current)
    assert.equal(classification.kind, 'incompatible')
    if (classification.kind === 'incompatible') {
      assert.deepEqual(classification.reasons, [
        { code: 'ticket-blockers-changed', ticketIssueId: 'I_A' },
      ])
    }
  })

  it('edit A → incompatible: the ticket revision changed', () => {
    const current = snapshotOf([
      member('I_A', 1, { title: 'Edited specification' }),
      memberB(),
    ])
    const classification = classifyMapChange(acceptedMap(), current)
    assert.equal(classification.kind, 'incompatible')
    if (classification.kind === 'incompatible') {
      assert.deepEqual(classification.reasons, [
        { code: 'ticket-revision-changed', ticketIssueId: 'I_A' },
      ])
    }
  })

  it('remove one of A\u2019s blockers → incompatible', () => {
    const accepted = snapshotOf([
      memberA(),
      memberB(),
      member('I_C', 3, { blockers: [rawRef('I_A', 1)] }),
    ])
    const current = snapshotOf([
      memberA(),
      memberB(),
      member('I_C', 3),
    ])
    const classification = classifyMapChange(accepted, current)
    assert.equal(classification.kind, 'incompatible')
    if (classification.kind === 'incompatible') {
      assert.deepEqual(classification.reasons, [
        { code: 'ticket-blockers-changed', ticketIssueId: 'I_C' },
      ])
    }
  })

  it('remove an accepted member → incompatible', () => {
    const current = snapshotOf([memberA()])
    const classification = classifyMapChange(acceptedMap(), current)
    assert.equal(classification.kind, 'incompatible')
    if (classification.kind === 'incompatible') {
      assert.deepEqual(classification.reasons, [{ code: 'member-removed', ticketIssueId: 'I_B' }])
    }
  })
})

describe('classifyMapChange — map-level rules (§7.4 rule 1)', () => {
  it('a map title edit is incompatible even when membership is unchanged', () => {
    const current = evaluateTaskMapLoad(rawLoad([memberA(), memberB()], { title: 'New intent' }))
    assert.ok(current.valid)
    const classification = classifyMapChange(acceptedMap(), current.snapshot)
    assert.equal(classification.kind, 'incompatible')
    if (classification.kind === 'incompatible') {
      assert.deepEqual(classification.reasons, [{ code: 'map-specification-changed' }])
    }
  })

  it('a map body edit is incompatible', () => {
    const current = evaluateTaskMapLoad(rawLoad([memberA(), memberB()], { body: 'New body' }))
    assert.ok(current.valid)
    const classification = classifyMapChange(acceptedMap(), current.snapshot)
    assert.equal(classification.kind, 'incompatible')
    if (classification.kind === 'incompatible') {
      assert.deepEqual(classification.reasons, [{ code: 'map-specification-changed' }])
    }
  })
})

describe('classifyMapChange — every reason is reported, not just the first', () => {
  it('collects member removal, revision change, and blocker change together', () => {
    const accepted = acceptedMap()
    const current = snapshotOf([
      member('I_A', 1, { title: 'Edited', blockers: [rawRef('I_C', 3)] }),
      member('I_C', 3),
    ])
    const classification = classifyMapChange(accepted, current)
    assert.equal(classification.kind, 'incompatible')
    if (classification.kind === 'incompatible') {
      assert.deepEqual(classification.reasons, [
        { code: 'ticket-revision-changed', ticketIssueId: 'I_A' },
        { code: 'ticket-blockers-changed', ticketIssueId: 'I_A' },
        { code: 'member-removed', ticketIssueId: 'I_B' },
      ])
    }
  })

  it('never lets a new ticket become a new blocker of an existing one, even mid-extension', () => {
    // A valid-looking "extension" that adds C but also rewires B to be
    // blocked by C is incompatible: B's complete blocker set changed.
    const current = snapshotOf([
      memberA(),
      member('I_B', 2, { blockers: [rawRef('I_A', 1), rawRef('I_C', 3)] }),
      member('I_C', 3),
    ])
    const classification = classifyMapChange(acceptedMap(), current)
    assert.equal(classification.kind, 'incompatible')
    if (classification.kind === 'incompatible') {
      assert.deepEqual(classification.reasons, [
        { code: 'ticket-blockers-changed', ticketIssueId: 'I_B' },
      ])
    }
  })

  it('an added ticket may depend on existing and new tickets at once', () => {
    const current = snapshotOf([
      memberA(),
      memberB(),
      member('I_C', 3),
      member('I_D', 4, { blockers: [rawRef('I_A', 1), rawRef('I_C', 3)] }),
    ])
    assert.deepEqual(classifyMapChange(acceptedMap(), current), {
      kind: 'compatible-extension',
      addedTicketIssueIds: ['I_C', 'I_D'],
    })
  })
})
