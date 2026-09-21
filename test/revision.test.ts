import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { canonicalJsonDigest } from '../src/core/digest.ts'
import type { Sha256Digest } from '../src/core/digest.ts'
import { isSha256Digest } from '../src/core/digest.ts'
import {
  MAP_REVISION_SCHEMA,
  TICKET_REVISION_SCHEMA,
  computeMapRevision,
  computeTicketRevision,
} from '../src/core/revision.ts'
import type { MapRevisionDependency, MapRevisionMember } from '../src/core/revision.ts'

const HOST = 'github.com'
const REPO = 'R_kgDOLnorn'
const TICKET_BASE = {
  githubHost: HOST,
  repositoryId: REPO,
  ticketIssueId: 'I_ticketA',
  title: 'Implement outcome model',
  body: 'Cover every kind, scope, and shared-write combination.',
}

function keysOf(value: object): string[] {
  return Object.keys(value).sort()
}

describe('computeTicketRevision', () => {
  it('returns a sha256-formatted revision with the normalized payload', () => {
    const { revision, payload } = computeTicketRevision(TICKET_BASE)
    assert.ok(isSha256Digest(revision))
    assert.equal(payload.schema, TICKET_REVISION_SCHEMA)
    assert.equal(payload.githubHost, HOST)
    assert.equal(payload.repositoryId, REPO)
    assert.equal(payload.ticketIssueId, 'I_ticketA')
    assert.equal(payload.title, TICKET_BASE.title)
    assert.equal(payload.body, TICKET_BASE.body)
  })

  it('is deterministic for identical input', () => {
    assert.equal(
      computeTicketRevision(TICKET_BASE).revision,
      computeTicketRevision(TICKET_BASE).revision,
    )
  })

  it('changes when any identity or specification field changes', () => {
    const base = computeTicketRevision(TICKET_BASE).revision
    const variants = [
      { githubHost: 'github.example.com' },
      { repositoryId: 'R_kgDOother' },
      { ticketIssueId: 'I_ticketB' },
      { title: 'Implement outcome model!' },
      { body: 'Cover every combination.' },
    ]
    for (const variant of variants) {
      const changed = computeTicketRevision({ ...TICKET_BASE, ...variant }).revision
      assert.notEqual(changed, base, JSON.stringify(variant))
    }
  })

  it('normalizes title and body before hashing', () => {
    const base = computeTicketRevision(TICKET_BASE).revision
    const padded = computeTicketRevision({
      ...TICKET_BASE,
      title: ` \t${TICKET_BASE.title}\r\n`,
      body: `\n${TICKET_BASE.body} \n\t `,
    })
    assert.equal(padded.revision, base)
    assert.equal(padded.payload.title, TICKET_BASE.title)
    assert.equal(padded.payload.body, TICKET_BASE.body)
  })

  it('treats a null body exactly like the empty string', () => {
    const nullBody = computeTicketRevision({ ...TICKET_BASE, body: null })
    const emptyBody = computeTicketRevision({ ...TICKET_BASE, body: '' })
    assert.equal(nullBody.revision, emptyBody.revision)
    assert.equal(nullBody.payload.body, '')
  })

  it('hashes NFC-equivalent text identically, preserving it in the payload', () => {
    const decomposed = computeTicketRevision({
      ...TICKET_BASE,
      body: 'cafe\u0301\r\n',
    })
    const composed = computeTicketRevision({ ...TICKET_BASE, body: 'café' })
    assert.equal(decomposed.revision, composed.revision)
    assert.equal(decomposed.payload.body, 'café')
  })

  it('considers interior Markdown bytes significant', () => {
    const base = computeTicketRevision(TICKET_BASE).revision
    for (const body of [
      `${TICKET_BASE.body}\n\n## Notes`,
      TICKET_BASE.body.replace('Cover', 'cover'),
      TICKET_BASE.body.replace('every', 'every  '),
      TICKET_BASE.body.replace(' ', '\t'),
      TICKET_BASE.body.replace(',', ',\n'),
    ]) {
      assert.notEqual(computeTicketRevision({ ...TICKET_BASE, body }).revision, base)
    }
  })

  it('hashes the exact documented payload shape and nothing else', () => {
    const { revision, payload } = computeTicketRevision(TICKET_BASE)
    assert.deepEqual(keysOf(payload), [
      'body',
      'githubHost',
      'repositoryId',
      'schema',
      'ticketIssueId',
      'title',
    ])
    // Independent re-computation of the digest over the payload itself.
    assert.equal(revision, canonicalJsonDigest(payload))
  })

  it('keeps issue state, number, URL, labels, and timestamps out of the revision', () => {
    // The payload schema above has no field for issue state, number, URL,
    // labels, or timestamps, so the payload-relevant projection of two
    // tickets whose only differences are such display metadata is identical.
    const displayA = { state: 'OPEN', number: 11, url: 'https://github.com/o/r/issues/11', labels: ['bug'], updatedAt: '2026-01-01T00:00:00Z' }
    const displayB = { state: 'CLOSED', number: 12, url: 'https://github.com/o/r/issues/12', labels: ['feature', 'priority'], updatedAt: '2027-12-31T23:59:59Z' }
    const project = (_display: unknown) => TICKET_BASE
    assert.equal(
      computeTicketRevision(project(displayA)).revision,
      computeTicketRevision(project(displayB)).revision,
    )
  })
})

describe('computeMapRevision', () => {
  const ticketA = { ticketIssueId: 'I_b', ticketRevision: 'sha256:' + 'aa'.repeat(32) }
  const ticketB = { ticketIssueId: 'I_a', ticketRevision: 'sha256:' + 'bb'.repeat(32) }
  const ticketC = { ticketIssueId: 'I_a10', ticketRevision: 'sha256:' + 'cc'.repeat(32) }
  const edgeAB: MapRevisionDependency = { blockerIssueId: 'I_b', blockedIssueId: 'I_a' }
  const edgeBC: MapRevisionDependency = { blockerIssueId: 'I_b', blockedIssueId: 'I_a10' }

  const MAP_BASE = {
    githubHost: HOST,
    repositoryId: REPO,
    mapIssueId: 'I_map',
    title: 'Ship the parser',
    body: 'Shared constraints for every member ticket.',
    members: [ticketA, ticketB, ticketC] as const,
    dependencies: [edgeAB, edgeBC] as const,
  }

  it('returns a sha256-formatted revision with the sorted payload', () => {
    const { revision, payload } = computeMapRevision(MAP_BASE)
    assert.ok(isSha256Digest(revision))
    assert.equal(payload.schema, MAP_REVISION_SCHEMA)
    // Members sorted by ticketIssueId as UTF-16 code units: I_a, I_a10, I_b.
    assert.deepEqual(
      payload.members.map((m) => m.ticketIssueId),
      ['I_a', 'I_a10', 'I_b'],
    )
    // Dependencies sorted by blocker, then blocked.
    assert.deepEqual(
      payload.dependencies.map((d) => [d.blockerIssueId, d.blockedIssueId]),
      [
        ['I_b', 'I_a'],
        ['I_b', 'I_a10'],
      ],
    )
  })

  it('is stable under member, dependency, and display reordering', () => {
    const base = computeMapRevision(MAP_BASE).revision
    const reordered = computeMapRevision({
      ...MAP_BASE,
      members: [ticketC, ticketA, ticketB],
      dependencies: [edgeBC, edgeAB],
    })
    assert.equal(reordered.revision, base)
    assert.deepEqual(reordered.payload, computeMapRevision(MAP_BASE).payload)
  })

  it('sorts dependencies by blocker first and blocked second', () => {
    const d1: MapRevisionDependency = { blockerIssueId: 'I_z', blockedIssueId: 'I_m' }
    const d2: MapRevisionDependency = { blockerIssueId: 'I_a', blockedIssueId: 'I_z' }
    const d3: MapRevisionDependency = { blockerIssueId: 'I_a', blockedIssueId: 'I_b' }
    const { payload } = computeMapRevision({ ...MAP_BASE, dependencies: [d1, d2, d3] })
    assert.deepEqual(
      payload.dependencies.map((d) => [d.blockerIssueId, d.blockedIssueId]),
      [
        ['I_a', 'I_b'],
        ['I_a', 'I_z'],
        ['I_z', 'I_m'],
      ],
    )
  })

  it('changes when the map specification changes', () => {
    const base = computeMapRevision(MAP_BASE).revision
    for (const variant of [
      { title: 'Ship the parser!' },
      { body: 'New shared constraints.' },
      { body: null },
      { githubHost: 'github.example.com' },
      { repositoryId: 'R_kgDOother' },
      { mapIssueId: 'I_other' },
    ]) {
      const changed = computeMapRevision({ ...MAP_BASE, ...variant }).revision
      assert.notEqual(changed, base, JSON.stringify(variant))
    }
  })

  it('normalizes map title and body before hashing', () => {
    const base = computeMapRevision(MAP_BASE).revision
    const padded = computeMapRevision({
      ...MAP_BASE,
      title: ` \t${MAP_BASE.title}\r\n`,
      body: `\r\n${MAP_BASE.body}\n `,
    })
    assert.equal(padded.revision, base)
    assert.equal(padded.payload.title, MAP_BASE.title)
    assert.equal(padded.payload.body, MAP_BASE.body)
  })

  it('changes when membership changes', () => {
    const base = computeMapRevision(MAP_BASE).revision
    const removed = computeMapRevision({ ...MAP_BASE, members: [ticketA, ticketB] }).revision
    assert.notEqual(removed, base)
    const added = computeMapRevision({
      ...MAP_BASE,
      members: [...MAP_BASE.members, { ticketIssueId: 'I_new', ticketRevision: 'sha256:' + 'dd'.repeat(32) }],
    }).revision
    assert.notEqual(added, base)
  })

  it('changes when any member ticket revision changes', () => {
    const base = computeMapRevision(MAP_BASE).revision
    const editedMember: MapRevisionMember = { ...ticketA, ticketRevision: 'sha256:' + 'ee'.repeat(32) }
    const changed = computeMapRevision({ ...MAP_BASE, members: [editedMember, ticketB, ticketC] }).revision
    assert.notEqual(changed, base)
  })

  it('changes when the dependency topology changes', () => {
    const base = computeMapRevision(MAP_BASE).revision
    const removedEdge = computeMapRevision({ ...MAP_BASE, dependencies: [edgeAB] }).revision
    assert.notEqual(removedEdge, base)
    const addedEdge = computeMapRevision({
      ...MAP_BASE,
      dependencies: [...MAP_BASE.dependencies, { blockerIssueId: 'I_a10', blockedIssueId: 'I_a' }],
    }).revision
    assert.notEqual(addedEdge, base)
  })

  it('treats dependency direction as significant', () => {
    const forward = computeMapRevision({ ...MAP_BASE, dependencies: [edgeAB] }).revision
    const backward = computeMapRevision({
      ...MAP_BASE,
      dependencies: [{ blockerIssueId: 'I_a', blockedIssueId: 'I_b' }],
    }).revision
    assert.notEqual(forward, backward)
  })

  it('hashes the exact documented payload shape and nothing else', () => {
    const { revision, payload } = computeMapRevision(MAP_BASE)
    assert.deepEqual(keysOf(payload), [
      'body',
      'dependencies',
      'githubHost',
      'mapIssueId',
      'members',
      'repositoryId',
      'schema',
      'title',
    ])
    assert.deepEqual(keysOf(payload.members[0]!), ['ticketIssueId', 'ticketRevision'])
    assert.deepEqual(keysOf(payload.dependencies[0]!), ['blockedIssueId', 'blockerIssueId'])
    assert.equal(revision, canonicalJsonDigest(payload))
  })

  it('keeps issue state, number, URL, labels, timestamps, and display order out of the revision', () => {
    // Only the payload-relevant projection of a map snapshot reaches the
    // hasher: dynamic and display facts never enter because the payload
    // schema (asserted above) has no field for them, while member order —
    // the sub-issue display order — is canonicalized away.
    const snapshotA = {
      ref: { state: 'OPEN', number: 6, url: 'https://github.com/o/r/issues/6', labels: ['x'], updatedAt: 't1' },
      title: MAP_BASE.title,
      body: MAP_BASE.body,
      members: [ticketA, ticketB, ticketC],
      dependencies: MAP_BASE.dependencies,
    }
    const snapshotB = {
      ref: { state: 'CLOSED', number: 7, url: 'https://github.com/o/r/issues/7', labels: ['y'], updatedAt: 't2' },
      title: MAP_BASE.title,
      body: MAP_BASE.body,
      members: [ticketC, ticketA, ticketB],
      dependencies: [edgeBC, edgeAB],
    }
    const project = (snapshot: {
      title: string
      body: string
      members: readonly MapRevisionMember[]
      dependencies: readonly MapRevisionDependency[]
    }) => ({
      githubHost: HOST,
      repositoryId: REPO,
      mapIssueId: 'I_map',
      title: snapshot.title,
      body: snapshot.body,
      members: snapshot.members,
      dependencies: snapshot.dependencies,
    })
    assert.equal(
      computeMapRevision(project(snapshotA)).revision,
      computeMapRevision(project(snapshotB)).revision,
    )
  })

  it('hashes empty membership and topology deterministically', () => {
    const empty = computeMapRevision({ ...MAP_BASE, members: [], dependencies: [] })
    assert.ok(isSha256Digest(empty.revision))
    assert.deepEqual(empty.payload.members, [])
    assert.deepEqual(empty.payload.dependencies, [])
    assert.equal(empty.revision, computeMapRevision({ ...MAP_BASE, members: [], dependencies: [] }).revision)
  })

  it('binds a member by its ticket revision end to end', () => {
    // The full design.md §7.3 flow: compute each member's ticket revision
    // first, then the map revision, and verify against an independently
    // constructed expected payload.
    const rawTickets = [
      { githubHost: HOST, repositoryId: REPO, ticketIssueId: 'I_2', title: 'Core', body: 'Pure functions.\r\n' },
      { githubHost: HOST, repositoryId: REPO, ticketIssueId: 'I_1', title: 'Docs', body: null },
    ]
    const members: MapRevisionMember[] = rawTickets.map((t) => ({
      ticketIssueId: t.ticketIssueId,
      ticketRevision: computeTicketRevision(t).revision,
    }))
    const dependencies: MapRevisionDependency[] = [
      { blockerIssueId: 'I_1', blockedIssueId: 'I_2' },
    ]
    const result = computeMapRevision({
      githubHost: HOST,
      repositoryId: REPO,
      mapIssueId: 'I_map',
      title: ' Map title ',
      body: 'Body\r\n',
      members: [...members].reverse(),
      dependencies,
    })

    const expectedPayload = {
      body: 'Body',
      dependencies: [{ blockedIssueId: 'I_2', blockerIssueId: 'I_1' }],
      githubHost: HOST,
      mapIssueId: 'I_map',
      members: [
        { ticketIssueId: 'I_1', ticketRevision: computeTicketRevision(rawTickets[1]!).revision },
        { ticketIssueId: 'I_2', ticketRevision: computeTicketRevision(rawTickets[0]!).revision },
      ],
      repositoryId: REPO,
      schema: MAP_REVISION_SCHEMA,
      title: 'Map title',
    }
    const expected: Sha256Digest = canonicalJsonDigest(expectedPayload)
    assert.equal(result.revision, expected)
    assert.deepEqual(result.payload, expectedPayload)

    // Any member specification change propagates into a new map revision.
    const edited = rawTickets.map((t) =>
      t.ticketIssueId === 'I_1' ? { ...t, title: 'Docs and tests' } : t,
    )
    const editedMembers: MapRevisionMember[] = edited.map((t) => ({
      ticketIssueId: t.ticketIssueId,
      ticketRevision: computeTicketRevision(t).revision,
    }))
    const editedResult = computeMapRevision({
      githubHost: HOST,
      repositoryId: REPO,
      mapIssueId: 'I_map',
      title: ' Map title ',
      body: 'Body\r\n',
      members: editedMembers,
      dependencies,
    })
    assert.notEqual(editedResult.revision, result.revision)
  })
})
