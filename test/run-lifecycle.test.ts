/**
 * Wave execution and run lifecycle (design.md §2.3, §12, §13, ticket #13).
 *
 * Every test drives the real coordinator (`runMap`) over the deterministic
 * five-seam harness: a real git repository with a bare remote (real
 * branches, workspaces, replays, pushes, fetches), a fake multi-issue
 * gateway (map loader, evidence reader, issue writer), fake agents with
 * scripted worker effects, a fake model catalog, and the real control store,
 * locks, and Work-slot registry under a temporary Norn home. The acceptance
 * criteria map one-to-one onto the describes below.
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { resolveRunConfigText } from '../src/config/run-config.ts'
import { runGit } from '../src/adapters/git-repository.ts'
import { gitText } from './helpers/round-gate-fixtures.ts'
import { encodePathSegment } from '../src/config/paths.ts'
import { acquireMapLock } from '../src/runstate/locks.ts'
import { saveRunState } from '../src/runstate/run-state-store.ts'
import type { RunState } from '../src/runstate/types.ts'
import { createTicketWorkspace } from '../src/work/workspace.ts'
import { makeRunHarness } from './helpers/run-fixtures.ts'
import type { MemberSpec, RunHarness } from './helpers/run-fixtures.ts'
import {
  ACTOR_ID,
  ENCODED_MAP,
  MAP_ISSUE_ID,
  REPOSITORY_ID,
  RUN_CONFIG_JSON,
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
const ticketC = (overrides: Partial<MemberSpec> = {}): MemberSpec => ({
  issueId: 'I_C',
  number: 3,
  ...overrides,
})
const ticketD = (overrides: Partial<MemberSpec> = {}): MemberSpec => ({
  issueId: 'I_D',
  number: 4,
  ...overrides,
})
const ticket9 = (overrides: Partial<MemberSpec> = {}): MemberSpec => ({
  issueId: 'I_9',
  number: 9,
  ...overrides,
})

/** Pre-create the crafted run's attempt workspace, as Work would have it. */
async function createTicketWorkspaceFor(
  harness: RunHarness,
  baseSha: string,
  baseTreeOid: string,
) {
  return createTicketWorkspace(
    { git: runGit },
    {
      repositoryRoot: harness.repo.root,
      repositoryHome: harness.repositoryHome,
      repositoryId: REPOSITORY_ID,
      runId: 'run-crafted',
      ticketNumber: 1,
      workAttemptId: 'wa-w1-t1',
      base: { sha: baseSha, treeOid: baseTreeOid },
    },
  )
}

const ticketStateOf = (harness: RunHarness, issueId: string) => {
  const state = harness.runState()
  assert.ok(state !== undefined, 'a run state exists')
  const record = state.tickets[issueId]
  assert.ok(record !== undefined, `ticket ${issueId} is recorded`)
  return record
}

const configRevisionOfFixture = (() => {
  const resolved = resolveRunConfigText(RUN_CONFIG_JSON)
  if (resolved.kind !== 'ok') throw new Error('fixture config is invalid')
  return resolved.value.configRevision
})()

// ---------------------------------------------------------------------------
// AC1: multi-wave execution with parked tickets, waiting descendants, and
// independent branches reaches the correct terminal report.
// ---------------------------------------------------------------------------

describe('wave execution — parked tickets, waiting descendants, independent branches', () => {
  it('works A and B in wave 1, ships A while B parks, then works C in wave 2', async () => {
    const harness = await makeRunHarness({
      label: 'multi-wave',
      members: [
        ticketA(),
        ticketB({ worker: { kind: 'block' } }),
        ticketC({ blockers: ['I_A'] }),
      ],
    })
    try {
      const outcome = await harness.run()

      // Terminal: blocked, listing the parked ticket — never completion.
      assert.equal(outcome.kind, 'blocked')
      assert.equal(outcome.code, 'no-eligible-frontier')
      const report = outcome.evidence[0] as { label: string; tickets: { ticket: { number: number }; state: string; code?: string }[] }
      assert.equal(report.label, 'blocked')

      const state = harness.runState()!
      assert.equal(state.status, 'terminal')
      assert.equal(state.wave, 2)

      // A completed in wave 1; B parked with the worker block; C — A's
      // descendant — stayed waiting through wave 1 and completed in wave 2.
      assert.equal(ticketStateOf(harness, 'I_A').phase, 'completed')
      const parkedB = ticketStateOf(harness, 'I_B')
      assert.equal(parkedB.phase, 'parked')
      assert.equal(parkedB.phase === 'parked' ? parkedB.outcome.code : '', 'worker-block')
      assert.equal(ticketStateOf(harness, 'I_C').phase, 'completed')

      // Wave 1 worked both A and B (independent branches); wave 2 worked C.
      assert.deepEqual(harness.workedTickets(), ['I_A', 'I_B', 'I_C'])

      // The report lists every member with its state and the parked code.
      const byNumber = new Map(report.tickets.map((entry) => [entry.ticket.number, entry]))
      assert.equal(byNumber.get(1)?.state, 'completed')
      assert.equal(byNumber.get(2)?.state, 'parked')
      assert.equal(byNumber.get(2)?.code, 'worker-block')
      assert.equal(byNumber.get(3)?.state, 'completed')

      // A shipped before C: the remote log carries their canonical commits
      // in wave order, and the run records the confirmed shared write.
      const log = harness.remoteLog()
      assert.equal(log.length, 3)
      assert.match(log[1]!, /#1/)
      assert.match(log[2]!, /#3/)
      assert.equal((state.report ?? { sharedWrite: 'none' }).sharedWrite, 'confirmed')
    } finally {
      harness.cleanup()
    }
  })

  it('parks a ticket-scoped ship failure and continues the queue with later tickets', async () => {
    // A and B add the same file with different content: after A ships, B's
    // replay onto the advanced target conflicts. C — a later, independent
    // ticket — still ships.
    const harness = await makeRunHarness({
      label: 'ship-conflict',
      members: [
        ticketA({ worker: { kind: 'file', name: 'shared.txt', content: 'from A\n' } }),
        ticketB({ worker: { kind: 'file', name: 'shared.txt', content: 'from B\n' } }),
        ticketD(),
      ],
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked')
      assert.equal(outcome.code, 'no-eligible-frontier')

      assert.equal(ticketStateOf(harness, 'I_A').phase, 'completed')
      const parkedB = ticketStateOf(harness, 'I_B')
      assert.equal(parkedB.phase, 'parked')
      assert.equal(parkedB.phase === 'parked' ? parkedB.outcome.code : '', 'integration-conflict')
      assert.equal(ticketStateOf(harness, 'I_D').phase, 'completed')

      const log = harness.remoteLog()
      assert.equal(log.length, 3) // init + A's integration + D's integration
      assert.match(log[1]!, /#1/)
      assert.match(log[2]!, /#4/)
    } finally {
      harness.cleanup()
    }
  })

  it('ships a zero-delta change without creating an empty commit', async () => {
    const harness = await makeRunHarness({
      label: 'zero-delta',
      members: [ticketA({ worker: { kind: 'zero-delta' } })],
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')
      assert.equal(outcome.value.label, 'passed')
      assert.equal(harness.remoteLog().length, 1) // only the initial commit
      assert.equal(ticketStateOf(harness, 'I_A').phase, 'completed')
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AC2: ship order within a persisted Wave queue is issue-number order and
// survives restart and later extensions.
// ---------------------------------------------------------------------------

describe('ship order — issue-number order, restart, and later extensions', () => {
  it('ships the persisted queue in issue-number order regardless of member order', async () => {
    // Members are declared number-first (B=#2 before A=#1): the frontier and
    // the persisted queue still order by issue number.
    const harness = await makeRunHarness({
      label: 'ship-order',
      members: [ticketB(), ticketA()],
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')

      const state = harness.runState()!
      assert.equal(state.wave, 1)

      const log = harness.remoteLog()
      assert.equal(log.length, 3)
      assert.match(log[1]!, /#1/)
      assert.match(log[2]!, /#2/)
    } finally {
      harness.cleanup()
    }
  })

  it('resumes the same run ID and queue after a recoverable interruption', async () => {
    const harness = await makeRunHarness({
      label: 'ship-restart',
      members: [ticketA(), ticketB()],
      changes: [
        {
          // After ticket #1's close, every later record-comment write fails
          // with an unknown result: a recoverable interruption after a
          // confirmed shared write (§13.2). The failure precedes the close,
          // so the issue stays OPEN without a record — resumable preflight.
          when: (observed) => observed.closeCalls >= 1,
          apply: (store) => {
            store.script.writeCommentFails = 'scripted unknown comment result'
          },
        },
      ],
    })
    try {
      const first = await harness.run()
      assert.ok(first.kind === 'error', `expected error, got ${first.kind}`)
      assert.equal(String(first.code), 'comment-write')
      assert.equal(first.sharedWrite, 'unknown')

      // The run is recoverable: state stays running, the queue is intact
      // with the cursor on ticket #2. Both pushes verified before the
      // interruption; only the record comment and close of #2 are missing.
      let state = harness.runState()!
      assert.equal(state.status, 'running')
      assert.equal(state.runId, 'run-1')
      const wave = state.activeWave
      assert.ok(wave !== undefined)
      assert.deepEqual(wave.shipQueueTicketIssueIds, ['I_A', 'I_B'])
      assert.equal(wave.nextShipIndex, 1)
      assert.equal(harness.remoteLog().length, 3)
      assert.equal(harness.store.observed.closeCalls, 1)
      assert.equal(ticketStateOf(harness, 'I_A').phase, 'completed')
      assert.equal(ticketStateOf(harness, 'I_B').phase, 'shipping')

      // The second invocation resumes the same run ID and finishes the queue.
      harness.store.script.writeCommentFails = undefined
      const second = await harness.run()
      assert.equal(second.kind, 'ok')

      state = harness.runState()!
      assert.equal(state.status, 'terminal')
      assert.equal(state.runId, 'run-1')
      assert.equal(ticketStateOf(harness, 'I_A').phase, 'completed')
      assert.equal(ticketStateOf(harness, 'I_B').phase, 'completed')

      // The resumed invocation closed #2 without any further push.
      const log = harness.remoteLog()
      assert.equal(log.length, 3)
      assert.match(log[1]!, /#1/)
      assert.match(log[2]!, /#2/)
      assert.equal(harness.store.observed.closeCalls, 2)
    } finally {
      harness.cleanup()
    }
  })

  it('never reorders a persisted queue when an extension is adopted mid-run', async () => {
    // The map gains ticket #9 at the wave-1 barrier — before anything ships —
    // yet #9 joins only the NEXT frontier: the wave-1 queue stays [I_A, I_B]
    // and #9 ships after both.
    const harness = await makeRunHarness({
      label: 'queue-extension',
      members: [ticketA(), ticketB()],
      changes: [
        {
          when: (observed) => observed.workReviewerLaunches >= 2,
          apply: (store) => store.addMember(ticket9()),
        },
      ],
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')

      const state = harness.runState()!
      assert.equal(state.acceptedMapRevisions.length, 2)
      assert.deepEqual(
        state.acceptedMapRevisions[1]?.extension?.addedTicketIssueIds,
        ['I_9'],
      )
      assert.equal(ticketStateOf(harness, 'I_9').phase, 'completed')

      const log = harness.remoteLog()
      assert.equal(log.length, 4)
      assert.match(log[1]!, /#1/)
      assert.match(log[2]!, /#2/)
      assert.match(log[3]!, /#9/)
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AC3: extension adoption at the barrier appends the revision lineage
// atomically with ticket claims and schedules added tickets in the next
// frontier.
// ---------------------------------------------------------------------------

describe('extension adoption at the barrier', () => {
  it('adopts atomically and works the added ticket in the next wave', async () => {
    const harness = await makeRunHarness({
      label: 'adopt',
      members: [ticketA(), ticketC({ blockers: ['I_A'] })],
      changes: [
        {
          // The barrier of wave 1: A and C both sealed.
          when: (observed) => observed.workReviewerLaunches >= 2,
          apply: (store) =>
            store.addMember(ticket9({ blockers: ['I_C'] })),
        },
      ],
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')

      const state = harness.runState()!
      // One atomic lineage entry, mirrored by the report.
      assert.equal(state.acceptedMapRevisions.length, 2)
      const extension = state.acceptedMapRevisions[1]!
      assert.equal(extension.extension?.fromRevision, state.acceptedMapRevisions[0]!.revision)
      assert.deepEqual(extension.extension?.addedTicketIssueIds, ['I_9'])
      assert.equal(state.report?.acceptedExtensions.length, 1)
      assert.deepEqual(state.report?.acceptedExtensions[0]?.addedTicketIssueIds, ['I_9'])
      assert.equal(state.report?.finalMapRevision, extension.revision)

      // The added ticket was claimed in the same document (its record
      // exists) and scheduled in a LATER wave: three waves total.
      assert.equal(ticketStateOf(harness, 'I_9').phase, 'completed')
      assert.equal(state.wave, 3)
      assert.deepEqual(harness.workedTickets(), ['I_A', 'I_C', 'I_9'])

      const log = harness.remoteLog()
      assert.equal(log.length, 4)
      assert.match(log[3]!, /#9/)
    } finally {
      harness.cleanup()
    }
  })

  it('treats an added ticket that fails per-member preflight as incompatible', async () => {
    const harness = await makeRunHarness({
      label: 'adopt-blocked',
      members: [ticketA()],
      changes: [
        {
          when: (observed) => observed.workReviewerLaunches >= 1,
          apply: (store) => {
            store.addMember(ticket9())
            store.issues.get(9)!.state = 'CLOSED' // no delivery record: blocked
          },
        },
      ],
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked')
      assert.equal(outcome.code, 'changed-input')

      // Adoption was prevented: no lineage entry, nothing shipped.
      const state = harness.runState()!
      assert.equal(state.acceptedMapRevisions.length, 1)
      assert.equal(harness.store.observed.pushes, 0)
      assert.equal(harness.remoteLog().length, 1)
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AC4: an incompatible change at the barrier ships nothing further and
// reports blocked(changed-input) with correct shared-write accounting.
// ---------------------------------------------------------------------------

describe('incompatible change at the barrier', () => {
  it('ships nothing when nothing had shipped yet (sharedWrite none)', async () => {
    const harness = await makeRunHarness({
      label: 'incompatible-none',
      members: [ticketA(), ticketB()],
      changes: [
        {
          when: (observed) => observed.workReviewerLaunches >= 2,
          apply: (store) => store.editMember('I_A', { title: 'Edited mid-run' }),
        },
      ],
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked')
      assert.equal(outcome.code, 'changed-input')
      assert.equal(outcome.sharedWrite, 'none')

      const state = harness.runState()!
      assert.equal(state.status, 'terminal')
      assert.equal(state.report?.label, 'blocked')
      assert.equal(state.report?.code, 'changed-input')
      assert.equal(state.report?.sharedWrite, 'none')

      // Nothing shipped and every unshipped result was invalidated.
      assert.equal(harness.store.observed.pushes, 0)
      assert.equal(harness.remoteLog().length, 1)
      for (const issueId of ['I_A', 'I_B']) {
        const record = ticketStateOf(harness, issueId)
        assert.equal(record.phase, 'parked')
        assert.equal(record.phase === 'parked' ? record.outcome.code : '', 'changed-input')
      }
      assert.deepEqual(
        state.parkedTickets.map((ref) => ref.issueId).sort(),
        ['I_A', 'I_B'],
      )
    } finally {
      harness.cleanup()
    }
  })

  it('accounts a confirmed shared write when an earlier wave already shipped', async () => {
    const harness = await makeRunHarness({
      label: 'incompatible-confirmed',
      members: [ticketA(), ticketC({ blockers: ['I_A'] })],
      changes: [
        {
          // Wave 2's barrier: A's and C's work reviewers both settled.
          when: (observed) => observed.workReviewerLaunches >= 2,
          apply: (store) => store.editMember('I_A', { body: 'Edited mid-run' }),
        },
      ],
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked')
      assert.equal(outcome.code, 'changed-input')
      assert.equal(outcome.sharedWrite, 'confirmed')

      const state = harness.runState()!
      assert.equal(state.report?.sharedWrite, 'confirmed')
      // A shipped in wave 1; C's wave-2 result was invalidated.
      assert.equal(ticketStateOf(harness, 'I_A').phase, 'completed')
      const parkedC = ticketStateOf(harness, 'I_C')
      assert.equal(parkedC.phase, 'parked')
      assert.equal(parkedC.phase === 'parked' ? parkedC.outcome.code : '', 'changed-input')
      // The remote carries exactly the initial commit plus A's integration.
      assert.equal(harness.remoteLog().length, 2)
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AC5: a map with no eligible frontier returns a blocked report listing
// parked and waiting tickets, never claiming completion.
// ---------------------------------------------------------------------------

describe('no eligible frontier', () => {
  it('reports the parked blocker and its waiting descendant without completing', async () => {
    const harness = await makeRunHarness({
      label: 'no-frontier',
      members: [
        ticketA({ worker: { kind: 'block' } }),
        ticketC({ blockers: ['I_A'] }),
        ticketD({ blockers: ['I_C'] }),
      ],
    })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked')
      assert.equal(outcome.code, 'no-eligible-frontier')

      const report = outcome.evidence[0] as {
        label: string
        completionSha?: string
        tickets: { ticket: { number: number }; state: string; code?: string }[]
      }
      assert.equal(report.label, 'blocked')
      assert.equal(report.completionSha, undefined)

      const byNumber = new Map(report.tickets.map((entry) => [entry.ticket.number, entry]))
      assert.equal(byNumber.size, 3)
      assert.equal(byNumber.get(1)?.state, 'parked')
      assert.equal(byNumber.get(1)?.code, 'worker-block')
      assert.equal(byNumber.get(3)?.state, 'waiting')
      assert.equal(byNumber.get(4)?.state, 'waiting')

      const state = harness.runState()!
      assert.equal(state.status, 'terminal')
      assert.equal(state.report?.completionSha, undefined)
    } finally {
      harness.cleanup()
    }
  })

  it('passes only when every member is a valid Completed Ticket', async () => {
    const harness = await makeRunHarness({ label: 'pass', members: [ticketA(), ticketB()] })
    try {
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')
      const report = outcome.value
      assert.equal(report.label, 'passed')
      assert.equal(report.code, undefined)
      assert.match(report.completionSha ?? '', /^sha1:[0-9a-f]{40}$/)
      assert.equal(report.sharedWrite, 'confirmed')
      assert.equal(report.tickets.length, 2)
      for (const entry of report.tickets) assert.equal(entry.state, 'completed')

      const state = harness.runState()!
      assert.equal(state.status, 'terminal')
      assert.equal(state.report?.completionSha, harness.remoteMainSha())
    } finally {
      harness.cleanup()
    }
  })

  it('warns when a fresh run finds every member already completed', async () => {
    const harness = await makeRunHarness({ label: 'precompleted', members: [ticketA()] })
    try {
      const first = await harness.run()
      assert.equal(first.kind, 'ok')

      const second = await harness.run()
      assert.equal(second.kind, 'ok')
      assert.equal(second.value.label, 'passed')
      assert.equal(second.value.runId, 'run-2') // a new run ID after terminal
      assert.deepEqual(harness.workedTickets().slice(1), []) // no new Work
      assert.ok(
        second.value.warnings.some((warning) => warning.includes('no shared write')),
      )
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AC6: a second run for the same map starts only after the previous run is
// terminal or aborted.
// ---------------------------------------------------------------------------

describe('one live coordinator per map', () => {
  it('refuses a second run while the map lock is held by a live coordinator', async () => {
    const harness = await makeRunHarness({ label: 'lock-held', members: [ticketA()] })
    try {
      // A live coordinator holds the map lock.
      const lock = await acquireMapLock(harness.repositoryHome, ENCODED_MAP)
      assert.equal(lock.kind, 'ok')

      const outcome = await harness.run()
      assert.equal(outcome.kind, 'blocked')
      assert.equal(outcome.code, 'lock-held')
      assert.equal(outcome.scope, 'operation')
      // No run state was created by the refused invocation.
      assert.equal(harness.runState(), undefined)

      await lock.value.release()
      const second = await harness.run()
      assert.equal(second.kind, 'ok')
    } finally {
      harness.cleanup()
    }
  })

  it('refuses to resume a running state under a different configRevision', async () => {
    const harness = await makeRunHarness({
      label: 'not-resumable',
      members: [ticketA(), ticketB()],
      changes: [
        {
          when: (observed) => observed.closeCalls >= 1,
          apply: (store) => {
            store.script.writeCommentFails = 'scripted unknown comment result'
          },
        },
      ],
    })
    try {
      const first = await harness.run()
      assert.equal(first.kind, 'error')
      assert.equal(harness.runState()!.status, 'running')

      // A hand-edited config.json changes the recomputed configRevision; the
      // running state must be refused, never mixed (§13.2).
      const configPath = join(harness.repositoryHome, 'config.json')
      const edited = JSON.parse(readFileSync(configPath, 'utf8'))
      edited.concurrency = 2
      writeFileSync(configPath, `${JSON.stringify(edited, null, 2)}\n`, 'utf8')

      harness.store.script.writeCommentFails = undefined
      const second = await harness.run()
      // Preflight itself reports the unresumable state (§2.3): a mismatched
      // executor must never mix evidence (§13.2).
      assert.equal(second.kind, 'blocked')
      const code = second.kind === 'blocked' ? second.code : ''
      assert.ok(
        code === 'state-not-resumable' || code === 'check-findings',
        `expected a resumability refusal, got ${code}`,
      )
      assert.ok(
        JSON.stringify(second.evidence).includes('state-not-resumable'),
        'the refusal carries the state-not-resumable finding',
      )
      assert.equal(harness.runState()!.status, 'running')
    } finally {
      harness.cleanup()
    }
  })

  it('starts a new run ID with an empty parked set after a terminal run', async () => {
    const harness = await makeRunHarness({
      label: 'new-run',
      members: [
        ticketA(),
        ticketB({ worker: { kind: 'block' } }),
        ticketC({ blockers: ['I_A'] }),
      ],
    })
    try {
      const first = await harness.run()
      assert.equal(first.kind, 'blocked')

      const firstState = harness.runState()!
      assert.equal(firstState.runId, 'run-1')
      assert.equal(firstState.parkedTickets.length, 1)

      // The operator resolves B's blocker; the next run works only B.
      harness.store.behaviors.I_B = { kind: 'commit' }
      const second = await harness.run()
      assert.equal(second.kind, 'ok')

      const secondState = harness.runState()!
      assert.equal(secondState.runId, 'run-2')
      assert.equal(secondState.status, 'terminal')
      // Only B was worked again: A and C's completions were retained from
      // their remote Delivery Records.
      assert.deepEqual(harness.workedTickets().slice(3), ['I_B'])
      assert.equal(ticketStateOf(harness, 'I_B').phase, 'completed')
    } finally {
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Resume reconciliation (§13.2): recorded process groups settle first.
// ---------------------------------------------------------------------------

describe('resume mid-wave', () => {
  it('resumes a working-phase wave from its persisted attempt and run ID', async () => {
    const harness = await makeRunHarness({ label: 'resume-work', members: [ticketA()] })
    try {
      // The state a crash between the attempt's reservation and its first
      // worker round leaves behind: the wave began, the attempt is recorded
      // at round 0 with its workspace created, nothing shipped.
      const snapshot = harness.snapshot()
      const ticket = snapshot.tickets[0]!
      const baseSha = `sha1:${gitText(harness.repo.root, ['rev-parse', 'HEAD'])}`
      const baseTreeOid = `sha1:${gitText(harness.repo.root, ['rev-parse', 'HEAD^{tree}'])}`
      const workAttemptId = 'wa-w1-t1'
      const crafted = harness.craftRunningState()
      const wave = {
        number: 1,
        mapRevision: snapshot.mapRevision,
        target: { branch: 'main', baseSha, baseTreeOid },
        frontierTicketIssueIds: [ticket.ref.issueId],
        shipQueueTicketIssueIds: [],
        nextShipIndex: 0,
      }
      const craftedState: RunState = {
        ...crafted,
        wave: 1,
        activeWave: wave,
        tickets: {
          [ticket.ref.issueId]: {
            phase: 'working',
            wave: 1,
            attempt: {
              workAttemptId,
              input: {
                ticket: ticket.ref,
                spec: {
                  mapTitle: snapshot.title,
                  mapBody: snapshot.body,
                  mapRevision: snapshot.mapRevision,
                  ticketTitle: ticket.title,
                  ticketBody: ticket.body,
                  ticketRevision: ticket.ticketRevision,
                },
                target: { branch: 'main', baseSha, baseTreeOid },
              },
              branch: `norn/run-crafted/1/${workAttemptId}`,
              workspace: {
                kind: 'ticket',
                repositoryId: REPOSITORY_ID,
                runId: 'run-crafted',
                path: join(
                  harness.repositoryHome,
                  'runs',
                  'run-crafted',
                  'workspaces',
                  '1',
                  workAttemptId,
                ),
                branch: `norn/run-crafted/1/${workAttemptId}`,
                workAttemptId,
              },
              round: 0,
              slot: 'awaiting-reservation',
              processGroupIds: [],
            },
          },
        },
      }
      const created = await createTicketWorkspaceFor(harness, baseSha, baseTreeOid)
      assert.equal(created.kind, 'ok')
      const saved = saveRunState(harness.repositoryHome, ENCODED_MAP, craftedState)
      assert.equal(saved.kind, 'ok')

      const outcome = await harness.run()
      assert.equal(outcome.kind, 'ok')
      // The same run ID resumed: Work continued from the persisted attempt.
      assert.equal(outcome.value.runId, 'run-crafted')
      assert.deepEqual(harness.workedTickets(), [ticket.ref.issueId])
      assert.equal(harness.remoteLog().length, 2)
      assert.match(harness.remoteLog()[1]!, /#1/)
    } finally {
      harness.cleanup()
    }
  })
})

describe('resume reconciliation', () => {
  it('settles every recorded live process group before planning', async () => {
    const harness = await makeRunHarness({ label: 'reconcile', members: [ticketA()] })
    try {
      // Craft a persisted running state whose accepted lineage is the real
      // map snapshot, carrying one not-yet-settled process group.
      const crafted = harness.craftRunningState([
        {
          id: 'pg-worker-r1',
          owner: 'worker',
          phase: 'work',
          workspace: {
            kind: 'ticket',
            repositoryId: REPOSITORY_ID,
            runId: 'run-crafted',
            path: join(harness.repositoryHome, 'runs', 'run-crafted', 'gone'),
            branch: 'norn/run-crafted/1/wa-w1-t1',
            workAttemptId: 'wa-w1-t1',
          },
          ticketIssueId: 'I_A',
          workAttemptId: 'wa-w1-t1',
          adapterHandle: 'fake-0',
          state: 'launch-intent',
        },
      ])
      const saved = saveRunState(harness.repositoryHome, ENCODED_MAP, crafted)
      assert.equal(saved.kind, 'ok')

      // Preflight still passes (two stable loads), then the map read fails:
      // reconciliation must have settled the recorded group first.
      harness.store.failReadsFrom = 3
      const outcome = await harness.run()
      assert.equal(outcome.kind, 'error')
      assert.equal(outcome.code, 'github-unavailable')

      const state = harness.runState()!
      assert.equal(state.activeProcesses[0]?.state, 'settled')
    } finally {
      harness.cleanup()
    }
  })
})
