/**
 * Delivery Record, close, and the Completed Ticket
 * (design.md §11.3, §13.3 steps 3–5, §14 — ticket #12).
 *
 * Every acceptance criterion is exercised end to end over the real
 * Run-State-backed Ship Checkpoint store, the real §14 evidence predicate,
 * the real map classifier, and scriptable fake gateways (comments,
 * close/reopen events, authorship) plus fake git facts. Replay and
 * interruption are modeled exactly as the design intends: by re-invoking
 * `shipClose` over the same persisted state.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { error } from '../src/core/outcome.ts'
import { canonicalJson } from '../src/core/canonical-json.ts'
import { formatRecordEnvelope } from '../src/evidence/envelope.ts'
import { loadRunState } from '../src/runstate/run-state-store.ts'
import type { TaskMapSnapshot } from '../src/map/snapshot.ts'
import { member as memberOf, rawRef } from './helpers/map-fixtures.ts'

import {
  ACTOR_ID,
  BASE_SHA,
  BASE_TREE,
  DELIVERED_TREE,
  ENCODED_MAP,
  INTEGRATED_SHA,
  MALFORMED_MARKED_BODY,
  MOVED_TIP_SHA,
  TIP_SHA,
  completedBlockerIssue,
  divergentBodyOf,
  makeCloseHarness,
  withTicketState,
  workspaceExists,
} from './helpers/close-fixtures.ts'
import type { CloseHarness } from './helpers/close-fixtures.ts'
import { fsWorkspaceCleanup } from '../src/ship/close.ts'
import { TICKET_ISSUE_ID, memberC, snapshotOf, ticket7 } from './helpers/ship-fixtures.ts'

/** The byte-exact machine comment of the sealed record. */
function canonicalBody(harness: CloseHarness): string {
  return formatRecordEnvelope(canonicalJson(harness.fixture.record as never))
}

/** Seed the identical record comment exactly as a prior invocation left it. */
function seedRecord(harness: CloseHarness, commentId = 'P100'): void {
  harness.ticketIssue.comments.push({
    commentId,
    authorId: ACTOR_ID,
    body: canonicalBody(harness),
  })
  harness.ticketIssue.timeline.push({ kind: 'commented', eventId: `PE${commentId}`, commentId })
}

describe('the §11.3 happy path', () => {
  it('writes one canonical record comment, closes the Ticket, and persists a Completed Ticket validated against remote truth', async () => {
    const harness = makeCloseHarness({ label: 'happy' })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind !== 'ok') return

      // Exactly one canonical record comment, byte-identical to the seal.
      assert.equal(harness.ticketIssue.comments.length, 1)
      assert.equal(harness.ticketIssue.comments[0]?.body, canonicalBody(harness))
      assert.equal(harness.gateway.writeCalls.length, 1)
      assert.equal(outcome.value.commentWritten, true)
      assert.match(outcome.value.anchorCommentId ?? '', /^C/)

      // The Ticket is closed, exactly once.
      assert.equal(harness.ticketIssue.state, 'CLOSED')
      assert.equal(harness.gateway.closeCalls, 1)
      const closes = harness.ticketIssue.timeline.filter((event) => event.kind === 'closed')
      assert.equal(closes.length, 1)

      // The Completed Ticket is persisted and mirrors the sealed checkpoint.
      const completed = harness.persistedCompleted()
      assert.ok(completed)
      assert.equal(completed?.deliveryId, harness.fixture.record.deliveryId)
      assert.equal(completed?.integratedSha, INTEGRATED_SHA)
      assert.equal(completed?.cleanupWorkspace, undefined)
      assert.equal(outcome.value.deliveryId, harness.fixture.record.deliveryId)
      assert.equal(outcome.value.integratedSha, INTEGRATED_SHA)
      assert.deepEqual(outcome.value.warnings, [])
      assert.equal(harness.persisted(), undefined, 'the shipping phase is superseded')

      // Cleanup deleted the workspace; the lock was released.
      assert.equal(workspaceExists(harness), false)
      assert.equal(harness.events.at(-1), 'lock:release')
    } finally {
      harness.cleanup()
    }
  })

  it('completes a zero-delta shipment whose target still equals the gated integration', async () => {
    const harness = makeCloseHarness({ label: 'happy-zero', zeroDelta: true })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind === 'ok') {
        assert.equal(outcome.value.integratedSha, BASE_SHA)
      }
      assert.equal(harness.ticketIssue.state, 'CLOSED')
      assert.ok(harness.persistedCompleted())
    } finally {
      harness.cleanup()
    }
  })

  it('allows ordinary descendant-only target advancement after a non-zero delivery', async () => {
    const harness = makeCloseHarness({ label: 'happy-advanced-target' })
    try {
      const outcome = await harness.run({
        facts: {
          targetSha: TIP_SHA,
          commits: {
            [INTEGRATED_SHA]: { treeOid: DELIVERED_TREE, parents: [BASE_SHA] },
            [BASE_SHA]: { treeOid: BASE_TREE, parents: [] },
          },
          ancestors: [INTEGRATED_SHA, BASE_SHA],
        },
      })
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      assert.ok(harness.persistedCompleted())
    } finally {
      harness.cleanup()
    }
  })
})

describe('write-or-reuse and interrupted-close replay (§13.3)', () => {
  it('reuses the identical record without rewriting when the checkpoint already confirms it', async () => {
    const harness = makeCloseHarness({ label: 'reuse-recorded', stage: 'delivery-recorded' })
    try {
      seedRecord(harness)
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind === 'ok') {
        assert.equal(outcome.value.commentWritten, false)
        assert.equal(outcome.value.anchorCommentId, 'P100')
      }
      assert.equal(harness.gateway.writeCalls.length, 0)
      assert.equal(harness.ticketIssue.comments.length, 1)
      assert.ok(harness.persistedCompleted())
    } finally {
      harness.cleanup()
    }
  })

  it('resumes an interrupted close by reusing the identical record, never divergent content', async () => {
    const harness = makeCloseHarness({ label: 'replay-close-unknown' })
    try {
      // First invocation: the comment landed, the close result is unknown.
      const interrupted = await harness.run({ closeFails: 'scripted close failure' })
      assert.equal(interrupted.kind, 'error')
      if (interrupted.kind === 'error') {
        assert.equal(interrupted.code, 'issue-close')
        assert.equal(interrupted.sharedWrite, 'unknown')
        assert.equal(interrupted.scope, 'run')
      }
      assert.equal(harness.ticketIssue.comments.length, 1)
      assert.equal(harness.ticketIssue.state, 'OPEN')
      assert.equal(harness.persisted()?.stage, 'delivery-recorded')

      // Replay over the same persisted state: reuse, complete.
      const resumed = await harness.run()
      assert.equal(resumed.kind, 'ok', JSON.stringify(resumed))
      assert.equal(harness.gateway.writeCalls.length, 1, 'the record was never written twice')
      assert.deepEqual(
        harness.ticketIssue.comments.map((comment) => comment.body),
        [canonicalBody(harness)],
      )
      assert.equal(harness.ticketIssue.state, 'CLOSED')
      assert.equal(harness.gateway.closeCalls, 1)
      assert.ok(harness.persistedCompleted())
      assert.equal(harness.events.at(-1), 'lock:release')
    } finally {
      harness.cleanup()
    }
  })

  it('reuses the record when a crash followed the comment write but preceded the stage update', async () => {
    const harness = makeCloseHarness({ label: 'replay-crash-stage' })
    try {
      const crashed = await harness.run({ failMarkStageOnce: 'delivery-recorded' })
      assert.equal(crashed.kind, 'error')
      if (crashed.kind === 'error') {
        assert.equal(crashed.code, 'control-store')
        assert.equal(crashed.sharedWrite, 'confirmed')
      }
      assert.equal(harness.ticketIssue.comments.length, 1)
      assert.equal(harness.persisted()?.stage, 'push-verified')

      const resumed = await harness.run()
      assert.equal(resumed.kind, 'ok', JSON.stringify(resumed))
      assert.equal(harness.gateway.writeCalls.length, 1)
      assert.ok(harness.persistedCompleted())
    } finally {
      harness.cleanup()
    }
  })

  it('retries only the cleanup of a Completed Ticket with a retained workspace', async () => {
    const harness = makeCloseHarness({ label: 'replay-cleanup' })
    try {
      const first = await harness.run({ cleanupFails: 'scripted cleanup failure' })
      assert.equal(first.kind, 'ok', JSON.stringify(first))
      assert.equal(workspaceExists(harness), true)
      const retained = harness.persistedCompleted()
      assert.ok(retained?.cleanupWorkspace)

      const second = await harness.run()
      assert.equal(second.kind, 'ok', JSON.stringify(second))
      assert.equal(workspaceExists(harness), false)
      assert.equal(harness.persistedCompleted()?.cleanupWorkspace, undefined)
      // A cleanup replay performs no map reads and no gateway writes.
      assert.equal(harness.gateway.writeCalls.length, 1)
      assert.equal(harness.gateway.closeCalls, 1)
      assert.equal(harness.counts.mapReads(), 2)
    } finally {
      harness.cleanup()
    }
  })

  it('reuses byte-identical duplicates with a warning and anchors on the earliest trusted copy', async () => {
    const harness = makeCloseHarness({ label: 'reuse-duplicates', stage: 'delivery-recorded' })
    try {
      seedRecord(harness, 'P100')
      seedRecord(harness, 'P101')
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind === 'ok') {
        assert.equal(outcome.value.anchorCommentId, 'P100')
        assert.equal(
          outcome.value.warnings.length,
          1,
          `expected the duplicate warning, got ${JSON.stringify(outcome.value.warnings)}`,
        )
        assert.match(outcome.value.warnings[0] ?? '', /duplicate byte-identical/)
      }
      assert.equal(harness.gateway.writeCalls.length, 0)
      assert.ok(harness.persistedCompleted())
    } finally {
      harness.cleanup()
    }
  })

  it('blocks on the same deliveryId with divergent canonical content before anything is written', async () => {
    const harness = makeCloseHarness({ label: 'divergent' })
    try {
      harness.ticketIssue.comments.push({
        commentId: 'P100',
        authorId: ACTOR_ID,
        body: divergentBodyOf(harness.fixture.record),
      })
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'changed-input')
        assert.equal(outcome.scope, 'run')
        assert.equal(outcome.sharedWrite, 'confirmed')
        assert.deepEqual(outcome.evidence[0], {
          stage: 'record-scan',
          divergent: ['P100'],
          invalidMarked: [],
        })
      }
      assert.equal(harness.gateway.writeCalls.length, 0)
      assert.equal(harness.gateway.closeCalls, 0)
      assert.equal(harness.ticketIssue.state, 'OPEN')
      assert.equal(harness.ticketIssue.comments.length, 1, 'nothing was overwritten')
    } finally {
      harness.cleanup()
    }
  })

  it('blocks on a malformed marked comment before any close', async () => {
    const harness = makeCloseHarness({
      label: 'malformed-marked',
      preseedComments: [{ body: MALFORMED_MARKED_BODY }],
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked')
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'changed-input')
      }
      assert.equal(harness.gateway.writeCalls.length, 0)
      assert.equal(harness.gateway.closeCalls, 0)
    } finally {
      harness.cleanup()
    }
  })

  it('treats an unknown comment-write result as a recoverable error', async () => {
    const harness = makeCloseHarness({ label: 'comment-unknown' })
    try {
      const outcome = await harness.run({ writeCommentFails: 'scripted gateway failure' })
      assert.equal(outcome.kind, 'error')
      if (outcome.kind === 'error') {
        assert.equal(outcome.code, 'comment-write')
        assert.equal(outcome.sharedWrite, 'unknown')
        assert.equal(outcome.scope, 'run')
      }
      assert.equal(harness.persisted()?.stage, 'push-verified')
      assert.equal(harness.ticketIssue.comments.length, 0)
      assert.equal(harness.events.at(-1), 'lock:release')
    } finally {
      harness.cleanup()
    }
  })
})

describe('timeline inspection after the anchor (§11.3)', () => {
  it('a close-then-reopen sequence after the anchor stops the Ship instead of overwriting operator intent', async () => {
    const harness = makeCloseHarness({ label: 'close-reopen-open' })
    try {
      seedRecord(harness)
      harness.ticketIssue.timeline.push(
        { kind: 'closed', eventId: 'PEc', actorId: 'I_operator' },
        { kind: 'reopened', eventId: 'PEr', actorId: 'I_operator' },
      )
      harness.ticketIssue.state = 'OPEN'
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'changed-input')
        assert.equal(outcome.scope, 'run')
        assert.equal(outcome.sharedWrite, 'confirmed')
        assert.deepEqual(outcome.evidence, [
          { stage: 'close-then-reopen', anchorCommentId: 'P100' },
        ])
      }
      assert.equal(harness.gateway.closeCalls, 0)
      assert.equal(harness.ticketIssue.state, 'OPEN')
      assert.equal(harness.gateway.writeCalls.length, 0, 'the identical record was reused')
    } finally {
      harness.cleanup()
    }
  })

  it('a close-then-reopen sequence blocks even when the Ticket was closed again afterwards', async () => {
    const harness = makeCloseHarness({ label: 'close-reopen-close' })
    try {
      seedRecord(harness)
      harness.ticketIssue.timeline.push(
        { kind: 'closed', eventId: 'PEc1', actorId: 'I_operator' },
        { kind: 'reopened', eventId: 'PEr', actorId: 'I_operator' },
        { kind: 'closed', eventId: 'PEc2', actorId: 'I_operator' },
      )
      harness.ticketIssue.state = 'CLOSED'
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked')
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'changed-input')
      }
      assert.equal(harness.gateway.closeCalls, 0)
      assert.equal(harness.ticketIssue.state, 'CLOSED')
      assert.equal(harness.persistedCompleted(), undefined)
    } finally {
      harness.cleanup()
    }
  })

  it('skips the close call for a Ticket already closed after its record', async () => {
    const harness = makeCloseHarness({ label: 'skip-close' })
    try {
      seedRecord(harness)
      harness.ticketIssue.timeline.push({ kind: 'closed', eventId: 'PEc', actorId: ACTOR_ID })
      harness.ticketIssue.state = 'CLOSED'
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      assert.equal(harness.gateway.closeCalls, 0)
      assert.equal(harness.gateway.writeCalls.length, 0)
      assert.equal(harness.ticketIssue.state, 'CLOSED')
      assert.ok(harness.persistedCompleted())
    } finally {
      harness.cleanup()
    }
  })

  it('ignores close-then-reopen sequences that predate the record anchor', async () => {
    const harness = makeCloseHarness({ label: 'pre-anchor-history' })
    try {
      harness.ticketIssue.timeline.push(
        { kind: 'closed', eventId: 'PEc', actorId: 'I_operator' },
        { kind: 'reopened', eventId: 'PEr', actorId: 'I_operator' },
      )
      harness.ticketIssue.state = 'OPEN'
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      assert.equal(harness.gateway.closeCalls, 1)
      assert.ok(harness.persistedCompleted())
    } finally {
      harness.cleanup()
    }
  })

  it('fails validation for a Ticket whose close predates the record and repairs it', async () => {
    const harness = makeCloseHarness({ label: 'record-after-close', ticketState: 'CLOSED' })
    try {
      harness.ticketIssue.timeline.push({ kind: 'closed', eventId: 'PEc', actorId: 'I_operator' })
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'changed-input')
        assert.equal(outcome.sharedWrite, 'confirmed')
        const findings = (outcome.evidence[0] as { findings?: { code: string }[] }).findings
        assert.ok(findings?.some((finding) => finding.code === 'record-after-close'))
      }
      // The record was written after the close, so the chronology predicate
      // fails and the stale close is repaired.
      assert.equal(harness.gateway.writeCalls.length, 1)
      assert.equal(harness.gateway.closeCalls, 0)
      assert.equal(harness.gateway.reopenCalls, 1)
      assert.equal(harness.ticketIssue.state, 'OPEN')
      assert.equal(harness.persistedCompleted(), undefined)
    } finally {
      harness.cleanup()
    }
  })
})

describe('post-close stale facts reopen-repair and block the run (§11.3)', () => {
  it('a drifted map specification after the close reopens the Ticket and blocks with the partial writes recorded', async () => {
    const drifted = snapshotOf([ticket7({ body: 'edited after the close', state: 'CLOSED' })])
    const harness = makeCloseHarness({
      label: 'stale-map',
      mapScript: (read, live) => (read <= 0 ? live() : drifted),
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'changed-input')
        assert.equal(outcome.scope, 'run')
        assert.equal(outcome.sharedWrite, 'confirmed')
        assert.equal((outcome.evidence[0] as { stage?: string }).stage, 'map-classification')
        const repair = outcome.evidence[1] as { repair?: string; partialDeliveryId?: string }
        assert.equal(repair.repair, 'reopened')
        assert.equal(repair.partialDeliveryId, harness.fixture.record.deliveryId)
      }
      assert.equal(harness.gateway.reopenCalls, 1)
      assert.equal(harness.ticketIssue.state, 'OPEN')
      assert.equal(harness.gateway.writeCalls.length, 1)
      assert.equal(harness.persistedCompleted(), undefined)
      assert.equal(harness.persisted()?.stage, 'ticket-closed')
    } finally {
      harness.cleanup()
    }
  })

  it('a blocker invalidated after the close reopens the Ticket and blocks', async () => {
    const blockerMapOf = (t7: 'OPEN' | 'CLOSED', blocker: 'OPEN' | 'CLOSED'): TaskMapSnapshot =>
      snapshotOf([
        ticket7({ blockers: [rawRef('I_C', 9)], state: t7 }),
        memberOf('I_C', 9, { state: blocker }),
      ])
    const accepted = blockerMapOf('OPEN', 'CLOSED')
    const blockerIssue = completedBlockerIssue(accepted, 'I_C')
    const harness = makeCloseHarness({
      label: 'stale-blocker',
      map: accepted,
      issues: new Map([[9, blockerIssue]]),
      mapScript: (read) =>
        read <= 0 ? blockerMapOf('OPEN', 'CLOSED') : blockerMapOf('CLOSED', 'OPEN'),
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'changed-input')
        const failure = outcome.evidence.find(
          (entry) => (entry as { stage?: string }).stage === 'blocker-completion',
        )
        assert.ok(failure, JSON.stringify(outcome.evidence))
      }
      assert.equal(harness.gateway.reopenCalls, 1)
      assert.equal(harness.ticketIssue.state, 'OPEN')
      assert.equal(harness.persistedCompleted(), undefined)
    } finally {
      harness.cleanup()
    }
  })

  it('a zero-delta delivery whose target moved after the close reopens and blocks', async () => {
    const harness = makeCloseHarness({ label: 'stale-zero-target', zeroDelta: true })
    try {
      const outcome = await harness.run({
        facts: {
          targetSha: MOVED_TIP_SHA,
          commits: { [BASE_SHA]: { treeOid: BASE_TREE, parents: [] } },
          ancestors: [BASE_SHA, MOVED_TIP_SHA],
        },
      })
      assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'changed-input')
        assert.equal(outcome.sharedWrite, 'confirmed')
        const stale = outcome.evidence.find(
          (entry) => (entry as { stage?: string }).stage === 'zero-delta-target-moved',
        )
        assert.ok(stale, JSON.stringify(outcome.evidence))
      }
      assert.equal(harness.gateway.reopenCalls, 1)
      assert.equal(harness.ticketIssue.state, 'OPEN')
      assert.equal(harness.persistedCompleted(), undefined)
    } finally {
      harness.cleanup()
    }
  })

  it('a record comment authored by someone other than the sealed actor fails the §14 predicate and is repaired', async () => {
    const harness = makeCloseHarness({ label: 'stale-untrusted-author' })
    try {
      const outcome = await harness.run({ writeAuthorId: 'I_other' })
      assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'changed-input')
        const findings = (outcome.evidence[0] as { findings?: { code: string }[] }).findings
        assert.ok(findings?.some((finding) => finding.code === 'author-mismatch'))
      }
      assert.equal(harness.gateway.reopenCalls, 1)
      assert.equal(harness.ticketIssue.state, 'OPEN')
      assert.equal(harness.persistedCompleted(), undefined)
    } finally {
      harness.cleanup()
    }
  })

  it('a post-close target-read failure stays recoverable with confirmed shared writes', async () => {
    const harness = makeCloseHarness({ label: 'stale-target-read-error', zeroDelta: true })
    try {
      const outcome = await harness.run({
        facts: { error: { code: 'git-unavailable', reason: 'scripted target read failure' } },
      })
      assert.equal(outcome.kind, 'error', JSON.stringify(outcome))
      if (outcome.kind === 'error') {
        assert.equal(outcome.code, 'target-read')
        // The record comment and close already happened: an error here is
        // recoverable, never a terminal sharedWrite 'none' (§9, §13.2).
        assert.equal(outcome.sharedWrite, 'confirmed')
      }
      assert.equal(harness.ticketIssue.state, 'CLOSED')
      assert.equal(harness.persistedCompleted(), undefined)
    } finally {
      harness.cleanup()
    }
  })

  it('an unknown reopen result during repair is a recoverable run-scoped error', async () => {
    const drifted = snapshotOf([ticket7({ body: 'edited after the close', state: 'CLOSED' })])
    const harness = makeCloseHarness({
      label: 'reopen-unknown',
      mapScript: (read, live) => (read <= 0 ? live() : drifted),
    })
    try {
      const outcome = await harness.run({ reopenFails: 'scripted reopen failure' })
      assert.equal(outcome.kind, 'error', JSON.stringify(outcome))
      if (outcome.kind === 'error') {
        assert.equal(outcome.code, 'issue-reopen')
        assert.equal(outcome.sharedWrite, 'unknown')
        assert.equal(outcome.scope, 'run')
      }
      assert.equal(harness.ticketIssue.state, 'CLOSED', 'the close could not be undone')
      assert.equal(harness.persistedCompleted(), undefined)
    } finally {
      harness.cleanup()
    }
  })
})

describe('map handling around the close (§7.4, §11.3)', () => {
  it('adopts a Compatible Map Extension before the record with the lock-order dance and completes', async () => {
    const extended = snapshotOf([ticket7(), memberC()])
    const harness = makeCloseHarness({
      label: 'extension',
      mapScript: (read) => withTicketState(extended, TICKET_ISSUE_ID, harness.ticketIssue.state),
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind === 'ok') {
        assert.equal(outcome.value.adoptedExtensions.length, 1)
        assert.deepEqual(outcome.value.adoptedExtensions[0]?.addedTicketIssueIds, ['I_C'])
      }
      assert.ok(harness.persistedCompleted())
      const loaded = loadRunState(harness.repositoryHome, ENCODED_MAP)
      if (loaded.kind === 'ok' && loaded.value) {
        assert.equal(loaded.value.acceptedMapRevisions.length, 2)
        assert.deepEqual(loaded.value.acceptedMapRevisions[1]?.extension?.addedTicketIssueIds, ['I_C'])
      } else {
        assert.fail('the adopted extension was not persisted')
      }
      // The dance released the target lock before adoption and reacquired it.
      const release = harness.events.indexOf('lock:release')
      const adopt = harness.events.indexOf('adopt')
      const reacquire = harness.events.indexOf('lock:acquire', release + 1)
      assert.ok(release >= 0 && adopt > release && reacquire > adopt, harness.events.join(','))
      assert.equal(harness.events.at(-1), 'lock:release')
    } finally {
      harness.cleanup()
    }
  })

  it('an incompatible map change before the record blocks without writing evidence or closing', async () => {
    const drifted = snapshotOf([ticket7({ body: 'incompatible edit' })])
    const harness = makeCloseHarness({
      label: 'incompatible',
      mapScript: () => drifted,
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'changed-input')
        assert.equal(outcome.sharedWrite, 'confirmed', 'a verified non-zero push already happened')
      }
      assert.equal(harness.gateway.writeCalls.length, 0)
      assert.equal(harness.gateway.closeCalls, 0)
      assert.equal(harness.ticketIssue.state, 'OPEN')
    } finally {
      harness.cleanup()
    }
  })

  it('a zero-delta shipment without earlier shared writes blocks with sharedWrite none', async () => {
    const drifted = snapshotOf([ticket7({ body: 'incompatible edit' })])
    const harness = makeCloseHarness({
      label: 'incompatible-zero',
      zeroDelta: true,
      mapScript: () => drifted,
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked')
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.sharedWrite, 'none')
      }
      assert.equal(harness.gateway.writeCalls.length, 0)
    } finally {
      harness.cleanup()
    }
  })

  it('a closed Task Map blocks the close before any evidence write', async () => {
    const closedMap = snapshotOf([ticket7()], { state: 'CLOSED' })
    const harness = makeCloseHarness({
      label: 'map-closed',
      mapScript: () => closedMap,
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked')
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'changed-input')
      }
      assert.equal(harness.gateway.writeCalls.length, 0)
      assert.equal(harness.gateway.closeCalls, 0)
    } finally {
      harness.cleanup()
    }
  })

  it('a failed map read is a run-scoped error', async () => {
    const harness = makeCloseHarness({ label: 'map-read-error' })
    try {
      const outcome = await harness.run({
        mapScript: () =>
          error({ scope: 'operation', code: 'github-unavailable', reason: 'scripted read failure' }),
      })
      assert.equal(outcome.kind, 'error')
      if (outcome.kind === 'error') {
        assert.equal(outcome.code, 'map-read')
        assert.equal(outcome.scope, 'run')
      }
      assert.equal(harness.gateway.writeCalls.length, 0)
    } finally {
      harness.cleanup()
    }
  })
})

describe('workspace cleanup (§11.3)', () => {
  it('a cleanup failure after a verified Completed Ticket is recorded as a warning only', async () => {
    const harness = makeCloseHarness({ label: 'cleanup-warning' })
    try {
      const outcome = await harness.run({ cleanupFails: 'scripted cleanup failure' })
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      if (outcome.kind === 'ok') {
        assert.equal(outcome.value.warnings.length, 1)
        assert.match(outcome.value.warnings[0] ?? '', /cleanup failed.*warning/)
      }
      // The Completed Ticket stands.
      const completed = harness.persistedCompleted()
      assert.ok(completed)
      assert.equal(completed?.deliveryId, harness.fixture.record.deliveryId)
      assert.ok(completed?.cleanupWorkspace, 'the failed cleanup retains the workspace record')
      assert.equal(harness.ticketIssue.state, 'CLOSED')
    } finally {
      harness.cleanup()
    }
  })

  it('the production fs cleanup removes a workspace directory idempotently', async () => {
    const path = mkdtempSync(join(tmpdir(), 'norn-close-fscleanup-'))
    const workspace = {
      kind: 'ticket' as const,
      repositoryId: 'R_kgDOMAP',
      runId: 'run-9',
      path,
      branch: 'norn/run-9/7/wa-1',
      workAttemptId: 'wa-1',
    }
    const cleanup = fsWorkspaceCleanup()
    assert.equal((await cleanup(workspace)).kind, 'ok')
    assert.equal((await cleanup(workspace)).kind, 'ok', 'cleanup is idempotent on an absent path')
  })
})

describe('entry-state discipline (§13.1, §13.3)', () => {
  it('refuses to close from a checkpoint whose push stage is not verified', async () => {
    const harness = makeCloseHarness({ label: 'entry-prepared', stage: 'prepared' })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'error')
      if (outcome.kind === 'error') {
        assert.equal(outcome.code, 'state-integrity')
      }
      assert.equal(harness.gateway.writeCalls.length, 0)
    } finally {
      harness.cleanup()
    }
  })

  it('resumes a ticket-closed checkpoint through skip-close validation rather than re-closing', async () => {
    const harness = makeCloseHarness({ label: 'entry-ticket-closed', stage: 'ticket-closed' })
    try {
      // The crashed invocation wrote the record and closed the Ticket.
      seedRecord(harness)
      harness.ticketIssue.timeline.push({ kind: 'closed', eventId: 'PEc', actorId: ACTOR_ID })
      harness.ticketIssue.state = 'CLOSED'
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
      assert.equal(harness.gateway.writeCalls.length, 0)
      assert.equal(harness.gateway.closeCalls, 0)
      assert.ok(harness.persistedCompleted())
    } finally {
      harness.cleanup()
    }
  })

  it('reports a close-then-reopen detected on resume of a ticket-closed checkpoint', async () => {
    const harness = makeCloseHarness({
      label: 'entry-ticket-closed-reopened',
      stage: 'ticket-closed',
    })
    try {
      // The crashed invocation closed the Ticket (the checkpoint says so);
      // an operator reopened it afterwards.
      seedRecord(harness)
      harness.ticketIssue.timeline.push(
        { kind: 'closed', eventId: 'PEc', actorId: ACTOR_ID },
        { kind: 'reopened', eventId: 'PEr', actorId: 'I_operator' },
      )
      harness.ticketIssue.state = 'OPEN'
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'changed-input')
        assert.equal(outcome.sharedWrite, 'confirmed')
      }
      assert.equal(harness.gateway.closeCalls, 0, 'operator intent is never overwritten')
      assert.equal(harness.ticketIssue.state, 'OPEN')
      assert.equal(harness.persistedCompleted(), undefined)
    } finally {
      harness.cleanup()
    }
  })
})
