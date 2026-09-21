import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { evaluateTaskMapLoad } from '../src/map/snapshot.ts'
import { snapshotStableState } from '../src/map/snapshot.ts'
import type { TaskMapSnapshot } from '../src/map/snapshot.ts'
import { canonicalJson } from '../src/core/canonical-json.ts'
import { computeMapRevision, computeTicketRevision } from '../src/core/revision.ts'
import { member, memberA, memberB, rawLoad, rawRef } from './helpers/map-fixtures.ts'
import type { MemberOverrides } from './helpers/map-fixtures.ts'

function snapshotOf(
  members: readonly ReturnType<typeof member>[],
  mapOverrides: Parameters<typeof rawLoad>[1] = {},
): TaskMapSnapshot {
  const evaluation = evaluateTaskMapLoad(rawLoad(members, mapOverrides))
  assert.ok(evaluation.valid)
  return evaluation.snapshot
}

describe('evaluateTaskMapLoad — valid loads produce snapshots (§7.3)', () => {
  it('returns role-tagged stable refs: map and tickets never mix', () => {
    const snapshot = snapshotOf([memberA(), memberB()])
    assert.equal(snapshot.ref.role, 'map')
    assert.equal(snapshot.ref.githubHost, 'github.com')
    assert.equal(snapshot.ref.repositoryId, 'R_kgDOMAP')
    assert.equal(snapshot.ref.issueId, 'I_map')
    assert.equal(snapshot.ref.number, 6)
    for (const ticket of snapshot.tickets) {
      assert.equal(ticket.ref.role, 'ticket')
      assert.equal(ticket.ref.repositoryId, 'R_kgDOMAP')
    }
  })

  it('carries normalized title and body, hashing a null body as the empty string', () => {
    const crlf = member('I_A', 1, { title: '  Title\t', body: 'Line\r\nEnd  \n' })
    const snapshot = snapshotOf([crlf])
    assert.equal(snapshot.tickets[0]?.title, 'Title')
    assert.equal(snapshot.tickets[0]?.body, 'Line\nEnd')
    const nullBody = snapshotOf([member('I_A', 1, { body: null })])
    assert.equal(nullBody.tickets[0]?.body, '')
  })

  it('sorts tickets and blockedBy lists by immutable issue ID, not display order', () => {
    const shuffled = rawLoad([memberB(), memberA()])
    const evaluation = evaluateTaskMapLoad(shuffled)
    assert.ok(evaluation.valid)
    const tickets = evaluation.snapshot.tickets
    assert.deepEqual(
      tickets.map((ticket) => ticket.ref.issueId),
      ['I_A', 'I_B'],
    )
    assert.deepEqual(
      tickets[1]?.blockedBy.map((ref) => ref.issueId),
      ['I_A'],
    )
  })

  it('maps issue states onto the snapshot as dynamic facts', () => {
    const snapshot = snapshotOf([member('I_A', 1, { state: 'CLOSED' })], { state: 'CLOSED' })
    assert.equal(snapshot.state, 'CLOSED')
    assert.equal(snapshot.tickets[0]?.state, 'CLOSED')
  })

  it('computes ticketRevision from the §7.3 payload for each member', () => {
    const a = memberA()
    const snapshot = snapshotOf([a, memberB()])
    const expected = computeTicketRevision({
      githubHost: 'github.com',
      repositoryId: 'R_kgDOMAP',
      ticketIssueId: 'I_A',
      title: a.title,
      body: a.body,
    })
    assert.equal(snapshot.tickets[0]?.ticketRevision, expected.revision)
  })

  it('computes mapRevision from the §7.3 payload over the complete topology', () => {
    const snapshot = snapshotOf([memberA(), memberB()])
    const expected = computeMapRevision({
      githubHost: 'github.com',
      repositoryId: 'R_kgDOMAP',
      mapIssueId: 'I_map',
      title: snapshot.title,
      body: snapshot.body,
      members: snapshot.tickets.map((ticket) => ({
        ticketIssueId: ticket.ref.issueId,
        ticketRevision: ticket.ticketRevision,
      })),
      dependencies: [{ blockerIssueId: 'I_A', blockedIssueId: 'I_B' }],
    })
    assert.equal(snapshot.mapRevision, expected.revision)
  })
})

describe('revisions change exactly when specification content changes (§7.3)', () => {
  it('changes the map revision when the map title or body changes', () => {
    const base = snapshotOf([memberA()])
    const newTitle = snapshotOf([memberA()], { title: 'Different intent' })
    const newBody = snapshotOf([memberA()], { body: 'Different body' })
    assert.notEqual(base.mapRevision, newTitle.mapRevision)
    assert.notEqual(base.mapRevision, newBody.mapRevision)
    assert.equal(base.tickets[0]?.ticketRevision, newTitle.tickets[0]?.ticketRevision)
  })

  it('changes both revisions when a member title or body changes', () => {
    const base = snapshotOf([memberA(), memberB()])
    const edited = snapshotOf([
      memberA(),
      member('I_B', 2, { blockers: [rawRef('I_A', 1)], title: 'Edited' }),
    ])
    assert.notEqual(base.mapRevision, edited.mapRevision)
    assert.notEqual(base.tickets[1]?.ticketRevision, edited.tickets[1]?.ticketRevision)
    assert.equal(base.tickets[0]?.ticketRevision, edited.tickets[0]?.ticketRevision)
  })

  it('changes the map revision on membership change, keeping existing ticket revisions', () => {
    const before = snapshotOf([memberA(), memberB()])
    const added = snapshotOf([memberA(), memberB(), member('I_C', 3)])
    const removed = snapshotOf([memberA()])
    assert.notEqual(before.mapRevision, added.mapRevision)
    assert.notEqual(before.mapRevision, removed.mapRevision)
    for (const ticket of before.tickets) {
      const still = added.tickets.find((candidate) => candidate.ref.issueId === ticket.ref.issueId)
      assert.equal(still?.ticketRevision, ticket.ticketRevision)
    }
  })

  it('changes the map revision when topology changes but no text does', () => {
    const chained = snapshotOf([
      memberA(),
      memberB(),
      member('I_C', 3, { blockers: [rawRef('I_B', 2)] }),
    ])
    const rewired = snapshotOf([
      memberA(),
      memberB(),
      member('I_C', 3, { blockers: [rawRef('I_A', 1)] }),
    ])
    assert.notEqual(chained.mapRevision, rewired.mapRevision)
    assert.equal(chained.tickets[2]?.ticketRevision, rewired.tickets[2]?.ticketRevision)
  })
})

describe('revisions ignore dynamic facts, display order, and renames (§7.3)', () => {
  it('ignores issue state changes entirely', () => {
    const open = snapshotOf([memberA(), memberB()])
    const closed = snapshotOf(
      [member('I_A', 1, { state: 'CLOSED' }), memberB()],
      { state: 'CLOSED' },
    )
    assert.equal(open.mapRevision, closed.mapRevision)
    assert.equal(open.tickets[0]?.ticketRevision, closed.tickets[0]?.ticketRevision)
  })

  it('ignores member, blocker, and dependency display order', () => {
    const ordered = snapshotOf([memberA(), memberB()])
    const reordered = snapshotOf([memberB(), memberA()])
    assert.equal(ordered.mapRevision, reordered.mapRevision)
  })

  it('ignores issue numbers and URLs — repository renames cannot change identity', () => {
    const before = snapshotOf([memberA(), memberB()])
    const renamed = snapshotOf(
      [
        member('I_A', 1, { ref: rawRef('I_A', 1, { url: 'https://github.com/acme/renamed/issues/1' }) }),
        memberB(),
      ],
      { title: 'Ship widget v2' },
    )
    const renumberedUrl = 'https://ghe.example.com/acme/widget/issues/999'
    const oddLocator = snapshotOf([
      member('I_A', 1, { ref: rawRef('I_A', 77, { url: renumberedUrl }) }),
      memberB(),
    ])
    assert.equal(before.mapRevision, renamed.mapRevision)
    assert.equal(before.mapRevision, oddLocator.mapRevision)
    assert.equal(before.tickets[0]?.ticketRevision, oddLocator.tickets[0]?.ticketRevision)
  })

  it('normalizes host case before hashing, so identity is canonical', () => {
    const lower = snapshotOf([memberA()])
    const mixed = snapshotOf([
      member('I_A', 1, { ref: rawRef('I_A', 1, { githubHost: 'GitHub.Com' }) }),
    ])
    assert.equal(lower.mapRevision, mixed.mapRevision)
  })
})

describe('snapshotStableState', () => {
  it('keys on revision plus map and ticket states', () => {
    const base = snapshotOf([memberA(), memberB()])
    const sameState = snapshotOf([memberA(), memberB()])
    assert.equal(canonicalJson(snapshotStableState(base)), canonicalJson(snapshotStableState(sameState)))

    const closedTicket = snapshotOf([member('I_A', 1, { state: 'CLOSED' }), memberB()])
    assert.notEqual(
      canonicalJson(snapshotStableState(base)),
      canonicalJson(snapshotStableState(closedTicket)),
    )

    const closedMap = snapshotOf([memberA(), memberB()], { state: 'CLOSED' })
    assert.notEqual(
      canonicalJson(snapshotStableState(base)),
      canonicalJson(snapshotStableState(closedMap)),
    )
  })

  it('does not key on number or URL locators', () => {
    const base = snapshotOf([memberA()])
    const moved = snapshotOf([
      member('I_A', 1, { ref: rawRef('I_A', 42, { url: 'https://github.com/acme/renamed/issues/42' }) }),
    ])
    assert.equal(
      canonicalJson(snapshotStableState(base)),
      canonicalJson(snapshotStableState(moved)),
    )
  })
})
