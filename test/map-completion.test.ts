/**
 * Map completion (design.md §15, §13.4, ticket #14).
 *
 * Every test drives the real coordinator (`runMap`) over the deterministic
 * five-seam harness: a real git repository with a bare remote (real
 * completion workspaces at the exact remote commit, real target reads and
 * ancestry), a fake multi-issue gateway whose map-issue timeline is plain
 * data (comments, close/reopen events, unknown-write scripts), fake agents
 * with a scriptable completion-reviewer verdict, a fake model catalog, and
 * the real control store, target lock, and Run-State checkpoint store under
 * a temporary Norn home. The acceptance criteria map one-to-one onto the
 * describes below.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { canonicalJson } from '../src/core/canonical-json.ts'
import type { CanonicalJsonValue } from '../src/core/canonical-json.ts'
import { canonicalJsonDigest } from '../src/core/digest.ts'
import { resolveRunConfigText } from '../src/config/run-config.ts'
import { computeDeliveryId } from '../src/evidence/delivery.ts'
import { computeCompletionId, mapCompletionRecordProblems } from '../src/run/completion.ts'
import { MAP_COMPLETION_RECORD_SCHEMA } from '../src/run/completion.ts'
import { formatRecordEnvelope, parseRecordEnvelope } from '../src/evidence/envelope.ts'
import type { IssueTimelineEvent } from '../src/evidence/read.ts'
import { runMap } from '../src/run/lifecycle.ts'
import { saveRunState } from '../src/runstate/run-state-store.ts'
import type {
  DeliveryRecordV1,
  EvidenceGateV1,
  MapCompletionRecordV1,
  RunState,
  TestEvidence,
} from '../src/runstate/types.ts'
import { commandFailure } from './helpers/ship-fixtures.ts'
import { recordingLock } from './helpers/push-fixtures.ts'
import { advanceRemoteTarget } from './helpers/push-fixtures.ts'
import { gitText } from './helpers/round-gate-fixtures.ts'
import {
  completionWorkspacePaths,
  craftCompletionCheckpoint,
  fixtureGate,
  makeRunHarness,
} from './helpers/run-fixtures.ts'
import type { MemberSpec, RunHarness } from './helpers/run-fixtures.ts'
import {
  ACTOR_ID,
  ENCODED_MAP,
  MAP_NUMBER,
  RUN_CONFIG_JSON,
  SEALED_AT,
} from './helpers/run-fixtures.ts'

// ---------------------------------------------------------------------------
// Map vocabulary
// ---------------------------------------------------------------------------

const ticketA = (overrides: Partial<MemberSpec> = {}): MemberSpec => ({
  issueId: 'I_A',
  number: 1,
  ...overrides,
})
const ticketB = (overrides: Partial<MemberSpec> = {}): MemberSpec => ({
  issueId: 'I_B',
  number: 2,
  ...overrides,
})
const ticket9 = (overrides: Partial<MemberSpec> = {}): MemberSpec => ({
  issueId: 'I_9',
  number: 9,
  ...overrides,
})

const configRevisionOfFixture = (() => {
  const resolved = resolveRunConfigText(RUN_CONFIG_JSON)
  if (resolved.kind !== 'ok') throw new Error('fixture config is invalid')
  return resolved.value.configRevision
})()

/** The map issue's fake gateway state. */
const mapIssueOf = (harness: RunHarness) => harness.store.issues.get(MAP_NUMBER)!

/** The one marked machine comment on the map issue, parsed. */
function completionCommentOf(harness: RunHarness) {
  const marked = mapIssueOf(harness).comments.filter(
    (comment) => parseRecordEnvelope(comment.body).kind === 'record',
  )
  assert.equal(marked.length, 1, 'exactly one marked completion comment exists')
  const envelope = parseRecordEnvelope(marked[0]!.body)
  assert.ok(envelope.kind === 'record')
  return { comment: marked[0]!, envelope }
}

/** The timeline index of one event ID. */
const eventIndexOf = (harness: RunHarness, eventId: string) =>
  mapIssueOf(harness).timeline.findIndex((event) => event.eventId === eventId)

/**
 * A fully valid `norn-delivery:v1` record for one member against the real
 * remote target (base = the initial commit, integration = the advanced tip),
 * exactly as an earlier Norn run would have written it (§14).
 */
function memberDeliveryRecord(
  harness: RunHarness,
  init: { readonly baseSha: string; readonly integratedSha: string; readonly treeOid: string },
): DeliveryRecordV1 {
  const snapshot = harness.snapshot()
  const member = snapshot.tickets[0]!
  const tests: TestEvidence[] = [
    {
      phase: 'work',
      testIndex: 0,
      argv: ['npm', 'test'],
      timeoutMs: 60_000,
      baseSha: init.baseSha,
      treeOid: init.treeOid,
      exitCode: 0,
      outputDigest: canonicalJsonDigest({ fixture: 'member-test-output' } as never),
    },
  ]
  const draft: Omit<DeliveryRecordV1, 'deliveryId'> = {
    schema: 'norn-delivery:v1',
    run: { id: 'run-earlier', configRevision: configRevisionOfFixture, nornVersion: '0.1.0' },
    gate: fixtureGate(),
    map: { issueId: snapshot.ref.issueId, revision: snapshot.mapRevision },
    ticket: { issueId: member.ref.issueId, revision: member.ticketRevision },
    target: {
      repositoryId: snapshot.ref.repositoryId,
      branch: 'main',
      baseSha: init.baseSha,
      integratedSha: init.integratedSha,
      treeOid: init.treeOid,
    },
    review: {
      phase: 'work',
      provider: 'provider-b',
      model: 'provider-b/model-y',
      family: 'provider-b',
      thinking: 'high',
      verdict: 'pass',
      mapRevision: snapshot.mapRevision,
      ticketRevision: member.ticketRevision,
      baseSha: init.baseSha,
      treeOid: init.treeOid,
      testEvidenceDigest: canonicalJsonDigest(tests as never),
    },
    tests,
    actorId: ACTOR_ID,
    recordedAt: SEALED_AT,
  }
  return { ...draft, deliveryId: computeDeliveryId(draft) }
}

/** Seed one externally Completed member: closed, with its delivery record (§14). */
function seedCompletedMember(harness: RunHarness, record: DeliveryRecordV1): void {
  const issue = harness.store.issues.get(1)!
  issue.state = 'CLOSED'
  issue.comments.push({
    commentId: 'D1',
    authorId: ACTOR_ID,
    body: formatRecordEnvelope(canonicalJson(record as never)),
  })
  issue.timeline.push(
    { kind: 'commented', eventId: 'DE1', commentId: 'D1' },
    { kind: 'closed', eventId: 'DE2', actorId: ACTOR_ID },
  )
}

/** The sealed completion record of one crafted checkpoint, as §15 seals it. */
function craftedCompletionRecord(
  harness: RunHarness,
  checkpoint: ReturnType<typeof craftCompletionCheckpoint>,
): MapCompletionRecordV1 {
  const snapshot = harness.snapshot()
  const draft: Omit<MapCompletionRecordV1, 'completionId'> = {
    schema: MAP_COMPLETION_RECORD_SCHEMA,
    run: {
      id: 'run-crafted',
      completionAttemptId: checkpoint.completionAttemptId,
      configRevision: configRevisionOfFixture,
      nornVersion: '0.1.0',
    },
    gate: checkpoint.gate,
    map: {
      issueId: snapshot.ref.issueId,
      revision: checkpoint.mapRevision,
      closingEventId: checkpoint.closingEventId!,
    },
    target: {
      repositoryId: snapshot.ref.repositoryId,
      branch: 'main',
      completionSha: checkpoint.completionSha,
      treeOid: checkpoint.treeOid,
    },
    review: checkpoint.review,
    tests: [...checkpoint.tests],
    actorId: ACTOR_ID,
    recordedAt: SEALED_AT,
  }
  return { ...draft, completionId: computeCompletionId(draft) }
}

/** Persist one crafted running state for the harness's current map world. */
function seedRunningState(
  harness: RunHarness,
  craft: (base: RunState) => RunState,
): void {
  const state = craft(harness.craftRunningState([], { completed: ['I_A'] }))
  const saved = saveRunState(harness.repositoryHome, ENCODED_MAP, state)
  assert.equal(saved.kind, 'ok', 'crafted run state passed its integrity checks')
}

/** Run the harness with wrapped writer and lock seams, recording events. */
async function runWithEvents(
  harness: RunHarness,
  events: string[],
): Promise<ReturnType<RunHarness['run']>> {
  const base = harness.deps()
  const writer = {
    ...base.writer,
    async writeIssueComment(locator: Parameters<typeof base.writer.writeIssueComment>[0], body: string) {
      const outcome = await base.writer.writeIssueComment(locator, body)
      if (locator.number === MAP_NUMBER && outcome.kind === 'ok') events.push('write:comment')
      return outcome
    },
    async closeIssue(locator: Parameters<typeof base.writer.closeIssue>[0]) {
      const outcome = await base.writer.closeIssue(locator)
      if (locator.number === MAP_NUMBER && outcome.kind === 'ok') events.push('write:close')
      return outcome
    },
    async reopenIssue(locator: Parameters<typeof base.writer.reopenIssue>[0]) {
      const outcome = await base.writer.reopenIssue(locator)
      if (locator.number === MAP_NUMBER && outcome.kind === 'ok') events.push('write:reopen')
      return outcome
    },
  }
  return runMap({ ...base, writer, targetLockFor: () => recordingLock({}, events) }, mapUrlOf())
}

const mapUrlOf = (): string => 'https://github.com/acme/widget/issues/6'

// ---------------------------------------------------------------------------
// AC1 + AC6: the happy path closes the map, writes a validated completion
// record bound to the closing event, and reports passed with completionSha.
// ---------------------------------------------------------------------------

describe('map completion — happy path', () => {
  it('closes the map and writes a validated record after the close event', async () => {
    const harness = await makeRunHarness({ label: 'mc-happy', members: [ticketA(), ticketB({ blockers: ['I_A'] })] })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')
      const report = outcome.value
      assert.equal(report.label, 'passed')
      assert.equal(report.code, undefined)
      assert.equal(report.completionSha, harness.remoteMainSha())
      assert.equal(report.sharedWrite, 'confirmed')
      for (const entry of report.tickets) assert.equal(entry.state, 'completed')

      // The map is closed and the checkpoint is at its final stage.
      const state = harness.runState()!
      assert.equal(state.status, 'terminal')
      assert.equal(mapIssueOf(harness).state, 'CLOSED')
      assert.equal(state.mapCompletion?.stage, 'recorded')
      assert.equal(state.mapCompletion?.completionSha, report.completionSha)

      // AC6: the completion comment is written AFTER the close event, as the
      // remote finalization marker, and names that closing event.
      const { envelope } = completionCommentOf(harness)
      const record = envelope.value as unknown as MapCompletionRecordV1
      const closing = state.mapCompletion!.closingEventId!
      assert.ok(eventIndexOf(harness, closing) >= 0)
      const closeEvent = mapIssueOf(harness).timeline.find((event) => event.eventId === closing)!
      assert.equal(closeEvent.kind, 'closed')
      const commentEvent = mapIssueOf(harness).timeline.find(
        (event) => event.kind === 'commented' && event.commentId === completionCommentOf(harness).comment.commentId,
      )!
      assert.ok(
        mapIssueOf(harness).timeline.indexOf(commentEvent) > mapIssueOf(harness).timeline.indexOf(closeEvent),
        'the record comment follows the close event',
      )
      assert.equal(record.map.closingEventId, closing)

      // The record is well-formed and its sealed ID recomputes exactly (§15).
      assert.deepEqual(mapCompletionRecordProblems(record), [])
      const { completionId, ...rest } = record
      assert.equal(completionId, computeCompletionId(rest as never))
      assert.equal(record.target.completionSha, report.completionSha)
      assert.equal(record.run.id, state.runId)

      // The completion gates ran exactly once, in the run-owned map workspace.
      assert.equal(harness.store.observed.completionReviewerLaunches, 1)
      assert.ok(
        harness.commands.requests.some((request) => request.cwd.includes(join('workspaces', 'map'))),
        'the completion test list ran in the map-completion workspace',
      )
      // Completion pushed nothing: the remote log keeps exactly the two
      // member integrations over the initial commit.
      assert.equal(harness.remoteLog().length, 3)

      // Terminal cleanup removed the completion workspace (§15).
      assert.deepEqual(completionWorkspacePaths(harness), [])
    } finally {
      harness.cleanup()
    }
  })

  it('persists the exact timeline prefix when the head event has no ID', async () => {
    // GitHub's timeline union exposes `id` only through per-type fragments,
    // so "other" events (sub-issue added, …) read back with an empty
    // eventId. Falling back to ME0 would lose the position of both trailing
    // items; the synthetic prefix anchor preserves the exact boundary.
    const harness = await makeRunHarness({ label: 'mc-anchor', members: [ticketA(), ticketB({ blockers: ['I_A'] })] })
    try {
      mapIssueOf(harness).timeline.push({ kind: 'commented', eventId: 'ME0', commentId: 'MC0' })
      mapIssueOf(harness).timeline.push({ kind: 'other', eventId: '' })
      mapIssueOf(harness).timeline.push({ kind: 'other', eventId: '' })

      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')
      assert.equal(outcome.value.label, 'passed')
      const anchor = harness.runState()!.mapCompletion?.timelineAnchor
      assert.equal(anchor?.kind, 'prefix')
      if (anchor?.kind === 'prefix') {
        assert.equal(anchor.timelineLength, 3)
        assert.match(anchor.prefixDigest, /^sha256:[0-9a-f]{64}$/)
      }
    } finally {
      harness.cleanup()
    }
  })

  it('does not mistake an ID-less historical close-then-reopen for post-anchor interference', async () => {
    const harness = await makeRunHarness({ label: 'mc-anchor-history', members: [ticketA()] })
    try {
      // The map is currently OPEN; this old repair sequence predates the
      // completion attempt, but no event in the timeline has an ID.
      mapIssueOf(harness).timeline.push(
        { kind: 'closed', eventId: '', actorId: ACTOR_ID },
        { kind: 'reopened', eventId: '', actorId: ACTOR_ID },
        { kind: 'other', eventId: '' },
      )

      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')
      assert.equal(outcome.value.label, 'passed')
      const anchor = harness.runState()!.mapCompletion?.timelineAnchor
      assert.equal(anchor?.kind, 'prefix')
      if (anchor?.kind === 'prefix') assert.equal(anchor.timelineLength, 3)
    } finally {
      harness.cleanup()
    }
  })

  it('detects an ID-less close-then-reopen appended after the synthetic anchor', async () => {
    const harness = await makeRunHarness({ label: 'mc-anchor-interference', members: [ticketA()] })
    try {
      mapIssueOf(harness).timeline.push({ kind: 'other', eventId: '' })
      const deps = harness.deps()
      const loadIssueEvidence = deps.evidence.loadIssueEvidence.bind(deps.evidence)
      let interfered = false
      const outcome = await runMap(
        {
          ...deps,
          evidence: {
            async loadIssueEvidence(locator) {
              if (
                locator.number === MAP_NUMBER &&
                !interfered &&
                harness.runState()?.mapCompletion !== undefined
              ) {
                interfered = true
                mapIssueOf(harness).timeline.push(
                  { kind: 'closed', eventId: '', actorId: ACTOR_ID },
                  { kind: 'reopened', eventId: '', actorId: ACTOR_ID },
                )
              }
              return loadIssueEvidence(locator)
            },
          },
        },
        mapUrlOf(),
      )

      assert.equal(interfered, true)
      assert.equal(outcome.kind, 'blocked')
      assert.equal(outcome.code, 'changed-input')
      assert.equal(harness.store.observed.mapCloseCalls, 0)
      assert.equal(mapIssueOf(harness).state, 'OPEN')
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AC2: an extension arriving during completion adopts and returns to
// planning or restarts completion; the prior gates are discarded.
// ---------------------------------------------------------------------------

describe('map completion — extensions during completion', () => {
  it('returns to wave planning when an added ticket is not a Completed Ticket', async () => {
    const harness = await makeRunHarness({
      label: 'mc-replan',
      members: [ticketA()],
    })
    try {
      harness.store.changes.push({
        when: (observed) => observed.completionReviewerLaunches >= 1,
        apply: (store) => store.addMember(ticket9()),
      })
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')
      const report = outcome.value
      assert.equal(report.label, 'passed')

      // The extension was adopted; the added ticket was worked and shipped.
      const state = harness.runState()!
      assert.equal(state.acceptedMapRevisions.length, 2)
      assert.deepEqual(state.acceptedMapRevisions[1]?.extension?.addedTicketIssueIds, ['I_9'])
      assert.equal(report.finalMapRevision, state.acceptedMapRevisions[1]!.revision)
      assert.ok(harness.workedTickets().includes('I_9'))
      assert.equal(harness.store.issues.get(9)?.state, 'CLOSED')

      // The prior gates were discarded: the completion reviewer ran again
      // against the extended revision, and only one record was written.
      assert.equal(harness.store.observed.completionReviewerLaunches, 2)
      assert.equal(harness.store.observed.mapCommentCalls, 1)
      assert.equal(mapIssueOf(harness).state, 'CLOSED')
      const record = completionCommentOf(harness).envelope.value as unknown as MapCompletionRecordV1
      assert.equal(record.map.revision, report.finalMapRevision)
    } finally {
      harness.cleanup()
    }
  })

  it('restarts completion against the new revision when every added ticket is already completed', async () => {
    const harness = await makeRunHarness({ label: 'mc-restart-extension', members: [ticketA()] })
    try {
      harness.store.changes.push({
        // The map gains a member that is already a valid Completed Ticket
        // (a zero-delta delivery bound to the current remote tip) while the
        // first completion attempt is in flight.
        when: (observed) => observed.completionReviewerLaunches >= 1,
        apply: (store) => {
          store.addMember(ticket9())
          const issue = store.issues.get(9)!
          issue.state = 'CLOSED'
          const completionSha = harness.remoteMainSha()
          const treeOid = `sha1:${gitText(harness.remote.path, ['rev-parse', 'main^{tree}'])}`
          const snapshot = harness.snapshot()
          const member = snapshot.tickets.find((ticket) => ticket.ref.issueId === 'I_9')!
          const tests: TestEvidence[] = [
            {
              phase: 'work',
              testIndex: 0,
              argv: ['npm', 'test'],
              timeoutMs: 60_000,
              baseSha: completionSha,
              treeOid,
              exitCode: 0,
              outputDigest: canonicalJsonDigest({ fixture: 'ticket9-test-output' } as never),
            },
          ]
          const draft = {
            schema: 'norn-delivery:v1',
            run: { id: 'run-earlier', configRevision: configRevisionOfFixture, nornVersion: '0.1.0' },
            gate: fixtureGate(),
            map: { issueId: snapshot.ref.issueId, revision: snapshot.mapRevision },
            ticket: { issueId: 'I_9', revision: member.ticketRevision },
            target: {
              repositoryId: snapshot.ref.repositoryId,
              branch: 'main',
              baseSha: completionSha,
              integratedSha: completionSha,
              treeOid,
            },
            review: {
              phase: 'work',
              provider: 'provider-b',
              model: 'provider-b/model-y',
              family: 'provider-b',
              thinking: 'high',
              verdict: 'pass',
              mapRevision: snapshot.mapRevision,
              ticketRevision: member.ticketRevision,
              baseSha: completionSha,
              treeOid,
              testEvidenceDigest: canonicalJsonDigest(tests as never),
            },
            tests,
            actorId: ACTOR_ID,
            recordedAt: SEALED_AT,
          } as const
          const record = { ...draft, deliveryId: computeDeliveryId(draft) }
          issue.comments.push({
            commentId: 'D9',
            authorId: ACTOR_ID,
            body: formatRecordEnvelope(canonicalJson(record as never)),
          })
          issue.timeline.push(
            { kind: 'commented', eventId: 'DE9', commentId: 'D9' },
            { kind: 'closed', eventId: 'DE10', actorId: ACTOR_ID },
          )
        },
      })
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')
      const report = outcome.value
      assert.equal(report.label, 'passed')

      // The extension was adopted and completion RESTARTED against the new
      // revision: no wave planning happened for the already-completed member.
      const state = harness.runState()!
      assert.equal(state.acceptedMapRevisions.length, 2)
      assert.deepEqual(state.acceptedMapRevisions[1]?.extension?.addedTicketIssueIds, ['I_9'])
      assert.equal(report.finalMapRevision, state.acceptedMapRevisions[1]!.revision)
      assert.ok(!harness.workedTickets().includes('I_9'), 'no new Work was planned')
      assert.equal(harness.store.observed.completionReviewerLaunches, 2)
      assert.equal(mapIssueOf(harness).state, 'CLOSED')
      const record = completionCommentOf(harness).envelope.value as unknown as MapCompletionRecordV1
      assert.equal(record.map.revision, report.finalMapRevision)
    } finally {
      harness.cleanup()
    }
  })

  it('restarts completion against the new tip when only the target changed', async () => {
    const harness = await makeRunHarness({ label: 'mc-restart', members: [ticketA()] })
    try {
      const before = harness.remoteMainSha()
      harness.store.changes.push({
        // A ship from another map advances the target under the completion.
        when: (observed) => observed.completionReviewerLaunches >= 1,
        apply: () => advanceRemoteTarget(harness.remote, 'foreign.txt'),
      })
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')
      const report = outcome.value
      assert.equal(report.label, 'passed')
      assert.notEqual(report.completionSha, before)
      assert.equal(report.completionSha, harness.remoteMainSha())

      // The stale gates were discarded and re-run at the new tip; the map
      // closed exactly once, after the restart.
      assert.equal(harness.store.observed.completionReviewerLaunches, 2)
      assert.equal(harness.store.observed.mapCloseCalls, 1)
      const record = completionCommentOf(harness).envelope.value as unknown as MapCompletionRecordV1
      assert.equal(record.target.completionSha, report.completionSha)
      assert.equal(harness.runState()!.mapCompletion?.completionAttemptId, 'run-1-mc2')
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AC3: failed completion gates return run-scoped blocked(map-completion-
// gate-failed) with sharedWrite confirmed iff the run already shipped.
// ---------------------------------------------------------------------------

describe('map completion — gate failures', () => {
  it('reports confirmed when this run already shipped a ticket', async () => {
    const harness = await makeRunHarness({
      label: 'mc-gate-confirmed',
      members: [ticketA()],
      completionReviewer: () => ({ discriminant: 'iterate', feedback: 'the map is not done' }),
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked')
      assert.equal(outcome.code, 'map-completion-gate-failed')
      assert.equal(outcome.scope, 'run')
      assert.equal(outcome.sharedWrite, 'confirmed')

      // The Map remains open with findings; nothing closed or commented.
      assert.equal(mapIssueOf(harness).state, 'OPEN')
      assert.equal(harness.store.observed.mapCloseCalls, 0)
      assert.equal(harness.store.observed.mapCommentCalls, 0)
      const state = harness.runState()!
      assert.equal(state.status, 'terminal')
      assert.equal(state.report?.code, 'map-completion-gate-failed')
      // The shipped ticket stays completed; only the completion failed.
      assert.equal(state.tickets['I_A']?.phase, 'completed')
    } finally {
      harness.cleanup()
    }
  })

  it('reports none when every member was already completed externally', async () => {
    const harness = await makeRunHarness({
      label: 'mc-gate-none',
      members: [ticketA()],
      commandScript: (request) =>
        request.cwd.includes(join('workspaces', 'map'))
          ? commandFailure('completion tests fail')
          : undefined,
    })
    try {
      const baseSha = harness.remoteMainSha()
      const advanced = advanceRemoteTarget(harness.remote, 'delivered.txt')
      const record = memberDeliveryRecord(harness, {
        baseSha,
        integratedSha: `sha1:${advanced}`,
        treeOid: `sha1:${gitText(harness.remote.path, ['rev-parse', 'main^{tree}'])}`,
      })
      seedCompletedMember(harness, record)
      seedRunningState(harness, (base) => base)

      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked')
      assert.equal(outcome.code, 'map-completion-gate-failed')
      assert.equal(outcome.scope, 'run')
      assert.equal(outcome.sharedWrite, 'none')

      assert.equal(mapIssueOf(harness).state, 'OPEN')
      assert.equal(harness.store.observed.mapCloseCalls, 0)
      const state = harness.runState()!
      assert.equal(state.report?.sharedWrite, 'none')
      assert.equal(state.report?.code, 'map-completion-gate-failed')
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AC4: stale-fact closes are repaired by reopening while holding the target
// lock; repaired-attempt records are historical.
// ---------------------------------------------------------------------------

describe('map completion — stale-close repair', () => {
  it('reopens the closed map under the lock and leaves the record historical', async () => {
    const harness = await makeRunHarness({
      label: 'mc-repair',
      members: [ticketA()],
    })
    try {
      harness.store.changes.push({
        // The map's member specification is edited incompatibly right after
        // the completion record comment lands (§15 step 11).
        when: (observed) => observed.mapCommentCalls >= 1,
        apply: (store) => store.editMember('I_A', { title: 'Edited during completion' }),
      })
      const events: string[] = []
      const outcome = await runWithEvents(harness, events)
      assert.equal(outcome.kind, 'blocked')
      assert.equal(outcome.code, 'changed-input')
      assert.equal(outcome.sharedWrite, 'confirmed')

      // The record was written, then the close was repaired by a reopen that
      // happened while the completion still held the target lock.
      assert.equal(harness.store.observed.mapCommentCalls, 1)
      assert.equal(harness.store.observed.mapReopenCalls, 1)
      const closeAt = events.indexOf('write:close')
      const commentAt = events.indexOf('write:comment')
      const reopenAt = events.indexOf('write:reopen')
      assert.ok(closeAt >= 0 && commentAt > closeAt && reopenAt > commentAt)
      const acquireBefore = events.lastIndexOf('lock:acquire', reopenAt)
      const releaseAfter = events.indexOf('lock:release', reopenAt)
      assert.ok(acquireBefore >= 0, 'a lock acquire precedes the reopen')
      assert.ok(releaseAfter > reopenAt, 'the lock is released only after the reopen')

      // The map is open again and the record of the repaired attempt stays
      // on the issue as a well-formed but historical marker.
      assert.equal(mapIssueOf(harness).state, 'OPEN')
      const { envelope } = completionCommentOf(harness)
      assert.deepEqual(mapCompletionRecordProblems(envelope.value), [])
      const state = harness.runState()!
      assert.equal(state.status, 'terminal')
      assert.equal(state.report?.code, 'changed-input')
      assert.equal(state.mapCompletion, undefined, 'the repaired attempt gates were discarded')
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AC5: recovery distinguishes a close whose post-check finished (record
// present and valid) from one that did not.
// ---------------------------------------------------------------------------

describe('map completion — recovery reconciliation (§13.4)', () => {
  /** Advance the remote once and seed one externally Completed member (§14). */
  function seedExternallyCompletedMember(harness: RunHarness): void {
    const baseSha = harness.remoteMainSha()
    const advanced = advanceRemoteTarget(harness.remote, 'delivered.txt')
    const delivery = memberDeliveryRecord(harness, {
      baseSha,
      integratedSha: `sha1:${advanced}`,
      treeOid: `sha1:${gitText(harness.remote.path, ['rev-parse', 'main^{tree}'])}`,
    })
    seedCompletedMember(harness, delivery)
  }

  function seedClosedMapWorld(harness: RunHarness, withRecord: boolean): MapCompletionRecordV1 | undefined {
    seedExternallyCompletedMember(harness)

    const snapshot = harness.snapshot()
    const map = mapIssueOf(harness)
    map.state = 'CLOSED'
    map.timeline.push({ kind: 'closed', eventId: 'ME1', actorId: ACTOR_ID })
    let record: MapCompletionRecordV1 | undefined
    if (withRecord) {
      const checkpoint = craftCompletionCheckpoint(harness, {
        stage: 'map-closed',
        mapRevision: snapshot.mapRevision,
        closingEventId: 'ME1',
      })
      record = craftedCompletionRecord(harness, checkpoint)
      map.comments.push({
        commentId: 'MC1',
        authorId: ACTOR_ID,
        body: formatRecordEnvelope(canonicalJson(record as never)),
      })
      // The comment is the remote finalization marker: after the close event.
      map.timeline.push({ kind: 'commented', eventId: 'ME2', commentId: 'MC1' })
    }
    return record
  }

  it('terminalizes from a present, valid record without redoing any gate', async () => {
    const harness = await makeRunHarness({ label: 'mc-recover-recorded', members: [ticketA()] })
    try {
      const snapshot = harness.snapshot()
      const record = seedClosedMapWorld(harness, true)!
      const checkpoint = craftCompletionCheckpoint(harness, {
        stage: 'recorded',
        mapRevision: snapshot.mapRevision,
        closingEventId: 'ME1',
      })
      seedRunningState(harness, (base) => ({
        ...base,
        mapCompletion: { ...checkpoint, record },
      }))

      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')
      const report = outcome.value
      assert.equal(report.label, 'passed')
      assert.equal(report.runId, 'run-crafted')
      assert.equal(report.completionSha, harness.remoteMainSha())

      // Recovery recognized the finished post-check: no gates, no close, and
      // no comment write were repeated (§13.4 rule 3).
      assert.equal(harness.store.observed.completionReviewerLaunches, 0)
      assert.equal(harness.store.observed.mapCloseCalls, 0)
      assert.equal(harness.store.observed.mapCommentCalls, 0)
      assert.equal(mapIssueOf(harness).state, 'CLOSED')
      const state = harness.runState()!
      assert.equal(state.status, 'terminal')
      assert.equal(state.mapCompletion?.stage, 'recorded')
    } finally {
      harness.cleanup()
    }
  })

  it('completes the missing record for a confirmed close without reclosing', async () => {
    const harness = await makeRunHarness({ label: 'mc-recover-closed', members: [ticketA()] })
    try {
      const snapshot = harness.snapshot()
      seedClosedMapWorld(harness, false)
      const checkpoint = craftCompletionCheckpoint(harness, {
        stage: 'map-closed',
        mapRevision: snapshot.mapRevision,
        closingEventId: 'ME1',
      })
      seedRunningState(harness, (base) => ({ ...base, mapCompletion: checkpoint }))

      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')
      assert.equal(outcome.value.label, 'passed')
      assert.equal(outcome.value.completionSha, harness.remoteMainSha())

      // The close was already remotely confirmed: recovery only sealed and
      // wrote the missing record comment (§13.4 rule 2).
      assert.equal(harness.store.observed.completionReviewerLaunches, 0)
      assert.equal(harness.store.observed.mapCloseCalls, 0)
      assert.equal(harness.store.observed.mapCommentCalls, 1)
      assert.equal(mapIssueOf(harness).state, 'CLOSED')
      const state = harness.runState()!
      assert.equal(state.mapCompletion?.stage, 'recorded')
      const record = completionCommentOf(harness).envelope.value as unknown as MapCompletionRecordV1
      assert.equal(record.map.closingEventId, 'ME1')
    } finally {
      harness.cleanup()
    }
  })

  it('retries the close of a gated checkpoint without re-running the gates', async () => {
    const harness = await makeRunHarness({ label: 'mc-recover-gated', members: [ticketA()] })
    try {
      seedExternallyCompletedMember(harness)
      const snapshot = harness.snapshot()
      const checkpoint = craftCompletionCheckpoint(harness, {
        stage: 'gated',
        mapRevision: snapshot.mapRevision,
      })
      seedRunningState(harness, (base) => ({ ...base, mapCompletion: checkpoint }))

      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')
      assert.equal(outcome.value.label, 'passed')
      assert.equal(outcome.value.completionSha, harness.remoteMainSha())

      // The persisted gates were reused: no fresh reviewer launch, one close.
      assert.equal(harness.store.observed.completionReviewerLaunches, 0)
      assert.equal(harness.store.observed.mapCloseCalls, 1)
      const state = harness.runState()!
      assert.equal(state.mapCompletion?.stage, 'recorded')
      assert.equal(state.mapCompletion?.completionAttemptId, checkpoint.completionAttemptId)
    } finally {
      harness.cleanup()
    }
  })
})
