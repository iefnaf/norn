import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { canonicalJsonDigest } from '../src/core/digest.ts'
import {
  deliveryRecordProblems,
  deliveryRemedies,
  evaluateDeliveryEvidence,
  computeDeliveryId,
} from '../src/evidence/delivery.ts'
import type { DeliveryEvidenceFinding, DeliveryEvidenceQuery } from '../src/evidence/delivery.ts'
import {
  ACTOR_ID,
  BASE_SHA,
  BASE_TREE,
  DELIVERED_TREE,
  HOST,
  INTEGRATED_SHA,
  MAP_ISSUE_ID,
  MAP_REVISION,
  OTHER_AUTHOR_ID,
  REPOSITORY_ID,
  TARGET_BRANCH,
  TICKET_ISSUE_ID,
  TIP_SHA,
  evidenceRead,
  fakeFacts,
  fixtureGate,
  fixtureTests,
  fixtureTicketRevision,
  fixtureTimeline,
  makeDeliveryRecord,
  proseComment,
  recordBody,
  recordComment,
} from './helpers/delivery-fixtures.ts'
import type { IssueEvidenceComment } from '../src/evidence/read.ts'

type QueryOverrides = {
  record?: ReturnType<typeof makeDeliveryRecord>
  ticketState?: 'OPEN' | 'CLOSED'
  ticketRevision?: string
  targetBranch?: string
  trusted?: readonly string[]
  comments?: readonly IssueEvidenceComment[]
  timeline?: ReturnType<typeof fixtureTimeline>
  facts?: ReturnType<typeof fakeFacts>
}

/** Evaluate the default healthy query with the given overrides applied. */
async function evaluate(overrides: QueryOverrides = {}, mutate?: (record: Record<string, unknown>) => void) {
  const record =
    overrides.record ??
    makeDeliveryRecord(mutate === undefined ? {} : { mutate })
  const comments = overrides.comments ?? [recordComment(record)]
  const query: DeliveryEvidenceQuery = {
    map: { issueId: MAP_ISSUE_ID, repositoryId: REPOSITORY_ID },
    ticket: {
      issueId: TICKET_ISSUE_ID,
      state: overrides.ticketState ?? 'CLOSED',
      ticketRevision: overrides.ticketRevision ?? fixtureTicketRevision(),
    },
    targetBranch: overrides.targetBranch ?? TARGET_BRANCH,
    trustedEvidenceAuthorIds: overrides.trusted ?? [ACTOR_ID],
    evidence: evidenceRead(comments, overrides.timeline ?? fixtureTimeline(comments.map((c) => c.commentId))),
    facts: overrides.facts ?? fakeFacts(),
  }
  return evaluateDeliveryEvidence(query)
}

/** The finding codes of one evaluation, for compact assertions. */
async function codes(overrides: QueryOverrides = {}, mutate?: (record: Record<string, unknown>) => void): Promise<string[]> {
  const evaluation = await evaluate(overrides, mutate)
  if (evaluation.status === 'completed' || evaluation.status === 'no-record' || evaluation.status === 'error') {
    return []
  }
  return evaluation.findings.map((finding) => finding.code)
}

describe('delivery record structure and identity', () => {
  it('seals deliveryId over the record without the ID and recomputes it', () => {
    const record = makeDeliveryRecord()
    const { deliveryId: _omit, ...sealed } = record
    assert.equal(computeDeliveryId(sealed), record.deliveryId)
    assert.match(record.deliveryId, /^sha256:[0-9a-f]{64}$/)
  })

  it('rejects a recordedAt that is not the exact §14 timestamp format', () => {
    const problems = deliveryRecordProblems(makeDeliveryRecord())
    assert.deepEqual(problems, [])
    const wrong = makeDeliveryRecord({ mutate: (draft) => { draft.recordedAt = '2025-01-02T03:04:05Z' } })
    assert.ok(deliveryRecordProblems(wrong).some((problem) => problem.includes('recordedAt')))
    const wrongMillis = makeDeliveryRecord({ mutate: (draft) => { draft.recordedAt = '2025-01-02T03:04:05.006000Z' } })
    assert.ok(deliveryRecordProblems(wrongMillis).some((problem) => problem.includes('recordedAt')))
  })

  it('reports structural problems for a wrong schema and missing fields', () => {
    assert.ok(deliveryRecordProblems({ schema: 'norn-map-completion:v1' }).length > 0)
    assert.ok(deliveryRecordProblems(null).length > 0)
  })
})

describe('the Completed Ticket predicate — valid evidence', () => {
  it('accepts a fully valid closed member with a work-phase record', async () => {
    const evaluation = await evaluate()
    assert.equal(evaluation.status, 'completed')
    if (evaluation.status === 'completed') {
      assert.equal(evaluation.anchorCommentId, 'C1')
      assert.deepEqual(evaluation.warnings, [])
      assert.equal(evaluation.record.deliveryId, makeDeliveryRecord().deliveryId)
    }
  })

  it('accepts a ship-phase record bound to a reconciled base and tree', async () => {
    const newBase = `sha1:${'a'.repeat(40)}`
    const record = makeDeliveryRecord({ phase: 'ship', baseSha: newBase })
    const evaluation = await evaluate({
      comments: [recordComment(record)],
      timeline: fixtureTimeline(['C1']),
      facts: fakeFacts({
        commits: {
          [record.target.integratedSha]: { treeOid: DELIVERED_TREE, parents: [newBase] },
          [newBase]: { treeOid: BASE_TREE, parents: [] },
        },
      }),
    })
    assert.equal(evaluation.status, 'completed')
  })

  it('accepts a zero-delta delivery where integratedSha equals baseSha', async () => {
    const record = makeDeliveryRecord({ integratedSha: BASE_SHA, treeOid: BASE_TREE })
    const evaluation = await evaluate({
      comments: [recordComment(record)],
      facts: fakeFacts({
        commits: { [BASE_SHA]: { treeOid: BASE_TREE, parents: [`sha1:${'9'.repeat(40)}`] } },
        ancestors: [BASE_SHA, TIP_SHA],
      }),
    })
    assert.equal(evaluation.status, 'completed')
  })

  it('ignores prose comments entirely', async () => {
    const evaluation = await evaluate({
      comments: [proseComment('C0', 'hand-written summary mentioning ```json fences'), recordComment(makeDeliveryRecord())],
      timeline: fixtureTimeline(['C0', 'C1']),
    })
    assert.equal(evaluation.status, 'completed')
  })

  it('keeps a record whose map revision is historical: only ticket revision is current-bound', async () => {
    const evaluation = await evaluate({
      record: makeDeliveryRecord({ mapRevision: canonicalJsonDigest({ older: 'map' }) }),
    })
    assert.equal(evaluation.status, 'completed')
  })
})

describe('the Completed Ticket predicate — duplicate rules', () => {
  it('counts byte-identical duplicate comments as one record and warns', async () => {
    const record = makeDeliveryRecord()
    const evaluation = await evaluate({
      comments: [recordComment(record, { commentId: 'C1' }), recordComment(record, { commentId: 'C2' })],
      timeline: fixtureTimeline(['C1', 'C2']),
    })
    assert.equal(evaluation.status, 'completed')
    if (evaluation.status === 'completed') {
      assert.equal(evaluation.anchorCommentId, 'C1')
      assert.equal(evaluation.warnings.length, 1)
      assert.match(evaluation.warnings[0]!, /C1, C2/)
    }
  })

  it('uses the earliest trusted identical copy when an earlier copy is untrusted', async () => {
    const record = makeDeliveryRecord()
    const evaluation = await evaluate({
      comments: [
        recordComment(record, { commentId: 'C1', authorId: OTHER_AUTHOR_ID }),
        recordComment(record, { commentId: 'C2' }),
      ],
      timeline: fixtureTimeline(['C1', 'C2']),
    })
    assert.equal(evaluation.status, 'completed')
    if (evaluation.status === 'completed') assert.equal(evaluation.anchorCommentId, 'C2')
  })

  it('blocks when the same deliveryId carries divergent canonical content', async () => {
    const first = makeDeliveryRecord()
    // The divergent copy keeps the claimed deliveryId while its content was
    // edited — the shape §14's duplicate rule exists for.
    const divergent = makeDeliveryRecord()
    ;(divergent as unknown as Record<string, unknown>).actorId = OTHER_AUTHOR_ID
    assert.equal(first.deliveryId, divergent.deliveryId)
    assert.notEqual(recordBody(first), recordBody(divergent))
    const evaluation = await evaluate({
      comments: [recordComment(first), recordComment(divergent, { commentId: 'C2' })],
      timeline: fixtureTimeline(['C1', 'C2']),
    })
    assert.equal(evaluation.status, 'findings')
    if (evaluation.status === 'findings') {
      assert.deepEqual(evaluation.findings.map((f) => f.code), ['divergent-duplicate'])
      const finding = evaluation.findings[0]!
      assert.equal(finding.code, 'divergent-duplicate')
      if (finding.code === 'divergent-duplicate') assert.deepEqual(finding.commentIds, ['C1', 'C2'])
    }
  })

  it('blocks when distinct valid records exist for the current ticket revision', async () => {
    const first = makeDeliveryRecord()
    const second = makeDeliveryRecord({ integratedSha: `sha1:${'5'.repeat(40)}` })
    assert.notEqual(first.deliveryId, second.deliveryId)
    assert.deepEqual(await codes({
      comments: [recordComment(first), recordComment(second, { commentId: 'C2' })],
      timeline: fixtureTimeline(['C1', 'C2']),
      facts: fakeFacts({
        commits: {
          [first.target.integratedSha]: { treeOid: DELIVERED_TREE, parents: [BASE_SHA] },
          [second.target.integratedSha]: { treeOid: DELIVERED_TREE, parents: [BASE_SHA] },
          [BASE_SHA]: { treeOid: BASE_TREE, parents: [] },
        },
        ancestors: [first.target.integratedSha, second.target.integratedSha, BASE_SHA, TIP_SHA],
      }),
    }), ['ambiguous-records'])
  })

  it('treats a record for an older ticket revision as historical, not ambiguous', async () => {
    const older = makeDeliveryRecord({
      ticketRevision: canonicalJsonDigest({ older: 'revision' }),
    })
    const evaluation = await evaluate({
      comments: [recordComment(older)],
      timeline: fixtureTimeline(['C1']),
    })
    // The current revision has no record at all: stale revision.
    assert.deepEqual(await evaluate({
      comments: [recordComment(older)],
    }).then((e) => (e.status === 'recorded' || e.status === 'findings' ? e.findings.map((f) => f.code) : [`status:${e.status}`])),
    ['stale-ticket-revision'])
  })
})

describe('the Completed Ticket predicate — per-predicate violations', () => {
  it('reports an untrusted record author (predicate 4)', async () => {
    const findings = await collectFindings({ trusted: [] })
    assert.deepEqual(findings.map((f) => f.code), ['untrusted-author'])
  })

  it('reports a comment author that differs from the recorded actor (predicate 4)', async () => {
    const findings = await collectFindings({}, (record) => {
      record.actorId = OTHER_AUTHOR_ID
    })
    // The comment author (ACTOR_ID) no longer equals the recorded actor, and
    // the recorded actor is not trusted either: both findings appear.
    assert.deepEqual(findings.map((f) => f.code).sort(), ['author-mismatch', 'untrusted-author'])
  })

  it('reports identity mismatches for map, ticket, repository, and branch (predicate 3)', async () => {
    const mapFinding = await oneFindingWithDetail((record) => {
      ;(record.map as Record<string, unknown>).issueId = 'I_other_map'
    })
    assert.equal(mapFinding.code, 'identity-mismatch')
    assert.equal(mapFinding.code === 'identity-mismatch' ? mapFinding.detail : undefined, 'map')

    const ticketFinding = await oneFindingWithDetail((record) => {
      ;(record.ticket as Record<string, unknown>).issueId = 'I_other_ticket'
    })
    assert.equal(ticketFinding.code === 'identity-mismatch' ? ticketFinding.detail : undefined, 'ticket')

    const repositoryFinding = await oneFindingWithDetail((record) => {
      ;(record.target as Record<string, unknown>).repositoryId = 'R_other'
    })
    assert.equal(repositoryFinding.code === 'identity-mismatch' ? repositoryFinding.detail : undefined, 'repository')

    const branchFinding = await oneFindingWithDetail(undefined, { targetBranch: 'trunk' })
    assert.equal(branchFinding.code === 'identity-mismatch' ? branchFinding.detail : undefined, 'branch')
  })

  it('reports a delivery record that follows the current closing event (predicate 5)', async () => {
    const evaluation = await evaluate({
      timeline: [
        { kind: 'closed', eventId: 'E_close', actorId: ACTOR_ID },
        { kind: 'commented', eventId: 'E2', commentId: 'C1' },
      ],
    })
    if (evaluation.status === 'recorded' || evaluation.status === 'findings') {
      assert.deepEqual(evaluation.findings.map((f) => f.code), ['record-after-close'])
    } else {
      assert.fail(`expected findings, got ${evaluation.status}`)
    }
  })

  it('reports a close-then-reopen whose record precedes the (missing) current close (predicate 5)', async () => {
    const evaluation = await evaluate({
      timeline: [
        { kind: 'commented', eventId: 'E1', commentId: 'C1' },
        { kind: 'closed', eventId: 'E_close', actorId: ACTOR_ID },
        { kind: 'reopened', eventId: 'E_reopen', actorId: ACTOR_ID },
      ],
    })
    if (evaluation.status !== 'completed' && evaluation.status !== 'no-record' && evaluation.status !== 'error') {
      assert.ok(evaluation.findings.some((f) => f.code === 'missing-closing-event'))
    } else {
      assert.fail(`expected findings, got ${evaluation.status}`)
    }
  })

  it('reports a record comment absent from the timeline (predicate 5)', async () => {
    const evaluation = await evaluate({ timeline: fixtureTimeline([]) })
    if (evaluation.status !== 'completed' && evaluation.status !== 'no-record' && evaluation.status !== 'error') {
      assert.deepEqual(evaluation.findings.map((f) => f.code), ['record-not-in-timeline'])
    } else {
      assert.fail(`expected findings, got ${evaluation.status}`)
    }
  })

  it('reports a stale ticket revision (predicate 6)', async () => {
    const stale = canonicalJsonDigest({ changed: 'ticket' })
    const findings = await collectFindings({ ticketRevision: stale })
    assert.deepEqual(findings.map((f) => f.code), ['stale-ticket-revision'])
  })

  it('reports a gate whose worker and reviewer share a family (predicate 7)', async () => {
    const findings = await collectFindings({}, (record) => {
      ;((record.gate as Record<string, unknown>).reviewer as Record<string, unknown>).family = 'provider-a'
    })
    const gateFinding = findings.find((f) => f.code === 'invalid-gate')
    assert.ok(gateFinding !== undefined)
    const mismatch = findings.find((f) => f.code === 'reviewer-gate-mismatch')
    assert.ok(mismatch !== undefined) // the review no longer matches the edited gate
  })

  it('reports a review that does not exactly match the gate reviewer (predicate 7)', async () => {
    const findings = await collectFindings({}, (record) => {
      (record.review as Record<string, unknown>).model = 'provider-b/model-z'
    })
    assert.deepEqual(findings.map((f) => f.code), ['reviewer-gate-mismatch'])
  })

  it('reports each review binding mismatch with its specific field (predicate 7)', async () => {
    const revision = await oneFindingWithDetail((record) => {
      ;(record.review as Record<string, unknown>).mapRevision = canonicalJsonDigest({ other: 'map' })
    })
    assert.equal(revision.code === 'review-binding-mismatch' ? revision.detail : undefined, 'mapRevision')

    const digest = await oneFindingWithDetail((record) => {
      ;(record.review as Record<string, unknown>).testEvidenceDigest = canonicalJsonDigest({ tampered: true })
    })
    assert.equal(digest.code === 'review-binding-mismatch' ? digest.detail : undefined, 'testEvidenceDigest')
  })

  it('reports an extra test entry beyond the sealed gate tests (predicate 8)', async () => {
    const extra = [...fixtureTests()]
    extra.push({ ...extra[0]!, testIndex: 1, outputDigest: canonicalJsonDigest({ extra: true }) })
    const findings = await collectFindingsForRecord(makeDeliveryRecord({ tests: extra }))
    assert.deepEqual(findings.map((f) => f.code), ['tests-gate-mismatch'])
    const finding = findings[0]!
    assert.ok(finding.code === 'tests-gate-mismatch' && finding.problems.some((p) => p.includes('2 test entries for 1')))
  })

  it('reports a missing test entry (predicate 8)', async () => {
    const base = fixtureGate()
    const gate = { ...base, tests: [...base.tests, { argv: ['npm', 'run', 'lint'], timeoutMs: 30_000 }] }
    const findings = await collectFindingsForRecord(makeDeliveryRecord({ gate }))
    const testFinding = findings.find((f) => f.code === 'tests-gate-mismatch')
    assert.ok(testFinding !== undefined)
    if (testFinding.code === 'tests-gate-mismatch') {
      assert.ok(testFinding.problems.some((problem) => problem.includes('1 test entries for 2')))
    }
  })

  it('reports a test with wrong argv, timeout, phase, index, base, or tree (predicate 8)', async () => {
    const wrongArgv = fixtureTests()
    wrongArgv[0] = { ...wrongArgv[0]!, argv: ['npm', 'run', 'other'] }
    const argvFinding = (await collectFindingsForRecord(makeDeliveryRecord({ tests: wrongArgv }))).find((f) => f.code === 'tests-gate-mismatch')
    assert.ok(argvFinding !== undefined && argvFinding.code === 'tests-gate-mismatch' && argvFinding.problems.some((p) => p.includes('argv')))

    const wrongTimeout = fixtureTests()
    wrongTimeout[0] = { ...wrongTimeout[0]!, timeoutMs: 1_000 }
    const timeoutFinding = (await collectFindingsForRecord(makeDeliveryRecord({ tests: wrongTimeout }))).find((f) => f.code === 'tests-gate-mismatch')
    assert.ok(timeoutFinding !== undefined && timeoutFinding.code === 'tests-gate-mismatch' && timeoutFinding.problems.some((p) => p.includes('timeoutMs')))

    const wrongPhase = fixtureTests({ phase: 'ship' })
    const phaseFinding = (await collectFindingsForRecord(makeDeliveryRecord({ tests: wrongPhase }))).find((f) => f.code === 'tests-gate-mismatch')
    assert.ok(phaseFinding !== undefined && phaseFinding.code === 'tests-gate-mismatch' && phaseFinding.problems.some((p) => p.includes('phase')))

    const wrongIndex = fixtureTests()
    wrongIndex[0] = { ...wrongIndex[0]!, testIndex: 3 }
    const indexFinding = (await collectFindingsForRecord(makeDeliveryRecord({ tests: wrongIndex }))).find((f) => f.code === 'tests-gate-mismatch')
    assert.ok(indexFinding !== undefined && indexFinding.code === 'tests-gate-mismatch' && indexFinding.problems.some((p) => p.includes('testIndex')))

    const wrongTree = fixtureTests({ treeOid: `sha1:${'7'.repeat(40)}` })
    const treeFinding = (await collectFindingsForRecord(makeDeliveryRecord({ tests: wrongTree }))).find((f) => f.code === 'tests-gate-mismatch')
    assert.ok(treeFinding !== undefined && treeFinding.code === 'tests-gate-mismatch' && treeFinding.problems.some((p) => p.includes('treeOid')))
  })

  it('reports a tampered deliveryId that no longer recomputes (predicate 9)', async () => {
    const tampered = makeDeliveryRecord()
    ;(tampered as unknown as Record<string, unknown>).recordedAt = '2026-01-01T00:00:00.000Z'
    const evaluation = await evaluateDeliveryEvidence({
      map: { issueId: MAP_ISSUE_ID, repositoryId: REPOSITORY_ID },
      ticket: { issueId: TICKET_ISSUE_ID, state: 'CLOSED', ticketRevision: fixtureTicketRevision() },
      targetBranch: TARGET_BRANCH,
      trustedEvidenceAuthorIds: [ACTOR_ID],
      evidence: evidenceRead([recordComment(tampered)], fixtureTimeline()),
      facts: fakeFacts(),
    })
    assert.equal(evaluation.status, 'findings')
    if (evaluation.status === 'findings') {
      assert.deepEqual(evaluation.findings.map((f) => f.code), ['delivery-id-mismatch'])
    }
  })

  it('reports an integrated commit with the wrong parent shape (predicate 9)', async () => {
    const findings = await collectFindings({
      facts: fakeFacts({
        commits: { [INTEGRATED_SHA]: { treeOid: DELIVERED_TREE, parents: [`sha1:${'8'.repeat(40)}`, BASE_SHA] } },
      }),
    })
    const shape = findings.find((f) => f.code === 'wrong-integration-shape')
    assert.ok(shape !== undefined && shape.code === 'wrong-integration-shape' && shape.detail.includes('parent'))
  })

  it('reports a non-zero delivery whose tree equals the base tree (predicate 9)', async () => {
    const findings = await collectFindings({
      facts: fakeFacts({
        commits: { [INTEGRATED_SHA]: { treeOid: DELIVERED_TREE, parents: [BASE_SHA] }, [BASE_SHA]: { treeOid: DELIVERED_TREE, parents: [] } },
      }),
    })
    const shape = findings.find((f) => f.code === 'wrong-integration-shape')
    assert.ok(shape !== undefined && shape.code === 'wrong-integration-shape' && shape.detail.includes('different from the base tree'))
  })

  it('reports an integrated commit whose tree differs from the recorded tree (predicate 9)', async () => {
    const findings = await collectFindings({
      facts: fakeFacts({ commits: { [INTEGRATED_SHA]: { treeOid: `sha1:${'6'.repeat(40)}`, parents: [BASE_SHA] }, [BASE_SHA]: { treeOid: BASE_TREE, parents: [] } } }),
    })
    const shape = findings.find((f) => f.code === 'wrong-integration-shape')
    assert.ok(shape !== undefined && shape.code === 'wrong-integration-shape' && shape.detail.includes('recorded tree'))
  })

  it('reports an absent integrated commit after the fetch (predicate 9)', async () => {
    const findings = await collectFindings({
      facts: fakeFacts({ commits: { [BASE_SHA]: { treeOid: BASE_TREE, parents: [] } } }),
    })
    assert.deepEqual(findings.map((f) => f.code), ['integrated-commit-absent'])
  })

  it('reports an integrated commit that is not an ancestor of the fetched target (predicate 9)', async () => {
    const findings = await collectFindings({ facts: fakeFacts({ ancestors: [BASE_SHA, TIP_SHA] }) })
    assert.deepEqual(findings.map((f) => f.code), ['not-target-ancestor'])
  })

  it('accumulates every independently discoverable finding in one pass', async () => {
    const findings = await collectFindings({
      trusted: [],
      targetBranch: 'trunk',
      facts: fakeFacts({ ancestors: [BASE_SHA, TIP_SHA] }),
    })
    assert.deepEqual(
      findings.map((f) => f.code).sort(),
      ['identity-mismatch', 'not-target-ancestor', 'untrusted-author'],
    )
  })
})

describe('the Completed Ticket predicate — issue state', () => {
  it('reports ticket-open for an open member with an otherwise-valid record', async () => {
    const evaluation = await evaluate({ ticketState: 'OPEN' })
    assert.equal(evaluation.status, 'recorded')
    if (evaluation.status === 'recorded') {
      assert.deepEqual(evaluation.findings.map((f) => f.code), ['ticket-open'])
    }
  })

  it('skips chronology for an open member but still validates everything else', async () => {
    const evaluation = await evaluate({
      ticketState: 'OPEN',
      facts: fakeFacts({ ancestors: [] }),
    })
    if (evaluation.status === 'recorded') {
      assert.deepEqual(evaluation.findings.map((f) => f.code).sort(), ['not-target-ancestor', 'ticket-open'])
    } else {
      assert.fail(`expected recorded, got ${evaluation.status}`)
    }
  })

  it('returns no-record for an issue with no marked comments at all', async () => {
    const evaluation = await evaluate({ comments: [proseComment('C1')] })
    assert.equal(evaluation.status, 'no-record')
  })

  it('reports an invalid envelope and an invalid record as findings', async () => {
    const brokenEnvelope: IssueEvidenceComment = {
      commentId: 'C0',
      authorId: ACTOR_ID,
      body: '<!-- norn:record -->\nnot a fence',
    }
    const wrongSchema = makeDeliveryRecord({ mutate: (draft) => { draft.schema = 'norn-map-completion:v1' } })
    const evaluation = await evaluate({
      comments: [brokenEnvelope, recordComment(wrongSchema, { commentId: 'C2' }), recordComment(makeDeliveryRecord())],
      timeline: fixtureTimeline(['C0', 'C2', 'C1']),
    })
    if (evaluation.status === 'recorded' || evaluation.status === 'findings') {
      const kinds = evaluation.findings.map((f) => f.code).sort()
      assert.deepEqual(kinds, ['invalid-envelope', 'invalid-record'])
    } else {
      assert.fail(`expected findings, got ${evaluation.status}`)
    }
  })

  it('propagates Git-facts failures as errors', async () => {
    const evaluation = await evaluate({
      facts: fakeFacts({ error: { code: 'git-failed', reason: 'corrupt object store' } }),
    })
    assert.equal(evaluation.status, 'error')
    if (evaluation.status === 'error') {
      assert.equal(evaluation.code, 'git-failed')
      assert.equal(evaluation.reason, 'corrupt object store')
    }
  })

  it('derives the closed-member remedies and the open-with-record remedies', () => {
    assert.deepEqual(deliveryRemedies('CLOSED', [{ code: 'no-valid-record' }]), [
      'reopen-for-fresh-work',
      'remove-from-map',
      'restore-recorded-facts',
    ])
    assert.deepEqual(deliveryRemedies('OPEN', [{ code: 'ticket-open' }]), [
      'reclose-ticket',
      'change-ticket-specification',
    ])
  })
})

/** Collect the findings of one overridden evaluation. */
async function collectFindings(overrides: QueryOverrides = {}, mutate?: (record: Record<string, unknown>) => void): Promise<readonly DeliveryEvidenceFinding[]> {
  const evaluation = await evaluate(overrides, mutate)
  if (evaluation.status === 'recorded' || evaluation.status === 'findings') return evaluation.findings
  assert.fail(`expected findings, got ${evaluation.status}`)
}

/** Evaluate a record built through `mutate` with default surroundings. */
async function collectFindingsForRecord(record: ReturnType<typeof makeDeliveryRecord>): Promise<readonly DeliveryEvidenceFinding[]> {
  const evaluation = await evaluateDeliveryEvidence({
    map: { issueId: MAP_ISSUE_ID, repositoryId: REPOSITORY_ID },
    ticket: { issueId: TICKET_ISSUE_ID, state: 'CLOSED', ticketRevision: fixtureTicketRevision() },
    targetBranch: TARGET_BRANCH,
    trustedEvidenceAuthorIds: [ACTOR_ID],
    evidence: evidenceRead([recordComment(record)], fixtureTimeline()),
    facts: fakeFacts(),
  })
  if (evaluation.status === 'recorded' || evaluation.status === 'findings') return evaluation.findings
  assert.fail(`expected findings, got ${evaluation.status}`)
}

/** The single finding of an evaluation expected to produce exactly one. */
async function oneFindingWithDetail(
  mutate?: (record: Record<string, unknown>) => void,
  overrides: QueryOverrides = {},
): Promise<DeliveryEvidenceFinding> {
  const findings = await collectFindings(overrides, mutate)
  assert.equal(findings.length, 1, `expected one finding, got ${JSON.stringify(findings)}`)
  return findings[0]!
}
