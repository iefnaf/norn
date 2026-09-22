/**
 * Cross-map concurrency validation (design.md §16, ticket #17).
 *
 * Two real coordinator instances — two map locks, two Run State documents,
 * one shared repository home, slot registry, control lock, and target — are
 * driven through the five seams (fake gateways and scripted agents, real git
 * plus a bare remote as the shared target) across:
 *
 * 1. **overlapping Work** — both runs work simultaneously against one shared
 *    `concurrency`; the registry is sampled at quiescent points while worker
 *    invocations are held in flight, so the total in-flight bound is proven,
 *    not sampled by luck;
 * 2. **one crashed coordinator** — a crafted post-crash state owns a genuinely
 *    live orphan process group and a charged slot with no map lock; the other
 *    run never exceeds capacity, the reservation is never reclaimed merely
 *    because the map lock vanished, and reclaim happens only after the crashed
 *    run's own resume reconciliation proves settlement;
 * 3. **the preflight claim race** — a second run whose preflight passed is
 *    blocked at creation when another run's claim lands in the window the
 *    repository control lock closes;
 * 4. **extension claim races** — two runs racing to adopt extensions adding
 *    the same Ticket resolve under the control lock: exactly one claims it;
 * 5. **interleaved Ship** — both runs ship concurrently onto one target: the
 *    pushes serialize on the target lock (never simultaneous), the later
 *    shipper re-gates on target advancement, and a conflicting replay parks
 *    rather than overwrites.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'

import { runGit } from '../src/adapters/git-repository.ts'
import { spawnProcessGroup, waitForProcessGroupExit } from '../src/agents/process-group.ts'
import { canonicalJsonDigest } from '../src/core/digest.ts'
import type { Sha256Digest } from '../src/core/digest.ts'
import { acquireControlLock, isMapLockHeld } from '../src/runstate/locks.ts'
import { saveRunState } from '../src/runstate/run-state-store.ts'
import { reconcileStaleWorkSlots, reserveWorkSlot } from '../src/runstate/slot-registry.ts'
import { createTicketWorkspace } from '../src/work/workspace.ts'
import {
  assertNever,
  craftClaimState,
  craftCrashedWorkState,
  makeCrossMapHarness,
  pollUntil,
} from './helpers/cross-map-fixtures.ts'
import type { CrossMapHarness, MemberSpec } from './helpers/cross-map-fixtures.ts'

// ---------------------------------------------------------------------------
// World vocabulary
// ---------------------------------------------------------------------------

const member = (issueId: string, number: number, overrides: Partial<MemberSpec> = {}): MemberSpec => ({
  issueId,
  number,
  ...overrides,
})

/** Read one line of git output from the shared repository. */
function gitTextOf(harness: CrossMapHarness, args: readonly string[]): string {
  return execFileSync('git', ['-C', harness.repo.root, ...args], { encoding: 'utf8' }).trim()
}

/** Read one line of git output from the shared bare remote (target truth). */
function remoteGitText(harness: CrossMapHarness, args: readonly string[]): string {
  return execFileSync('git', ['-C', harness.remote.path, ...args], { encoding: 'utf8' }).trim()
}

// ---------------------------------------------------------------------------
// 1. Overlapping Work: one shared repository-wide capacity (§16)
// ---------------------------------------------------------------------------

describe('overlapping Work shares one repository-wide capacity', () => {
  it('holds both runs within one concurrency, deferring the third attempt until a slot frees', { timeout: 120_000 }, async () => {
    const harness = await makeCrossMapHarness({
      label: 'overlap-work',
      concurrency: 2,
      maps: [
        { issueId: 'I_mapA', number: 6, runId: 'run-a1', members: [member('I_a1', 1), member('I_a2', 2)] },
        { issueId: 'I_mapB', number: 9, runId: 'run-b1', members: [member('I_b1', 3)] },
      ],
    })
    try {
      const worldA = harness.world('I_mapA')
      const worldB = harness.world('I_mapB')

      const holdA1 = harness.runner.holdWorker('I_a1')
      const holdA2 = harness.runner.holdWorker('I_a2')
      const holdB1 = harness.runner.holdWorker('I_b1')

      const runA = harness.run(worldA)
      await holdA1.launched
      await holdA2.launched

      // Both of run A's attempts are in flight: the registry is quiescent
      // with exactly the shared capacity charged, all by one run.
      await pollUntil('run A holds both slots', () => harness.slotReservations().length === 2, 10_000)
      assert.deepEqual(
        harness.slotReservations().map((entry) => entry.workAttemptId).sort(),
        ['wa-w1-t1', 'wa-w1-t2'],
      )

      // Run B starts now: its single attempt must defer — it can neither
      // exceed the shared capacity nor launch its worker.
      const runB = harness.run(worldB)
      await assertNever(
        'run B launched its worker while both slots were charged',
        () => harness.runner.workerLaunchesOf('I_b1').length > 0,
        300,
      )
      assert.equal(harness.slotReservations().length, 2)
      const waitingB = harness.runStateOf(worldB)?.tickets.I_b1
      assert.ok(waitingB?.phase === 'working', 'the deferred attempt is recorded as working')
      assert.equal(waitingB.phase === 'working' ? waitingB.attempt.slot : '', 'awaiting-reservation')

      // Releasing one held worker lets its attempt settle and release its
      // slot; run B's deferred attempt acquires it and launches.
      holdA1.release()
      await pollUntil('run B acquired the freed slot', () => holdB1Launched(harness), 30_000)
      assert.equal(harness.slotReservations().length, 2) // still within capacity

      holdA2.release()
      holdB1.release()
      const [outcomeA, outcomeB] = await Promise.all([runA, runB])

      assert.equal(outcomeA.kind, 'ok')
      assert.equal(outcomeA.value.label, 'passed')
      assert.equal(outcomeB.kind, 'ok')
      assert.equal(outcomeB.value.label, 'passed')

      // Every reservation was released; the pushes serialized; both runs'
      // tickets completed on disjoint member sets.
      assert.deepEqual(harness.slotReservations(), [])
      assert.equal(harness.pushStats().maxInFlight, 1, 'pushes must never overlap')
      assert.equal(harness.pushStats().count, 3)
      assert.equal(harness.remoteLog().length, 4)
      for (const entry of outcomeA.value.tickets) assert.equal(entry.state, 'completed')
      for (const entry of outcomeB.value.tickets) assert.equal(entry.state, 'completed')
      assert.equal(worldA.observed.pushes, 2)
      assert.equal(worldB.observed.pushes, 1)
    } finally {
      await harness.settleAll()
      harness.cleanup()
    }
  })
})

function holdB1Launched(harness: CrossMapHarness): boolean {
  return harness.runner.workerLaunchesOf('I_b1').length > 0
}

// ---------------------------------------------------------------------------
// 2. One crashed coordinator (§16): charged slots survive, reclaim needs proof
// ---------------------------------------------------------------------------

describe('a crashed coordinator keeps its slot charged until settlement is proven', () => {
  it('bounds the other run, never reclaims from a vanished map lock, and reclaims after resume', { timeout: 180_000 }, async () => {
    const harness = await makeCrossMapHarness({
      label: 'crashed-coordinator',
      concurrency: 2,
      maps: [
        { issueId: 'I_mapA', number: 6, runId: 'run-crashed', members: [member('I_a1', 1)] },
        { issueId: 'I_mapB', number: 9, runId: 'run-b1', members: [member('I_b1', 2), member('I_b2', 3)] },
      ],
    })
    let orphan: Awaited<ReturnType<typeof spawnProcessGroup>> | undefined
    try {
      const worldA = harness.world('I_mapA')
      const worldB = harness.world('I_mapB')

      // --- the crashed coordinator: live orphan, charged slot, no map lock --

      orphan = await spawnProcessGroup(['sleep', '120'])
      const pgid = orphan.pid as number
      const adapterHandle = JSON.stringify({ adapter: 'local-process', pgid })
      const baseSha = `sha1:${gitTextOf(harness, ['rev-parse', 'HEAD'])}`
      const baseTreeOid = `sha1:${gitTextOf(harness, ['rev-parse', 'HEAD^{tree}'])}`
      const workAttemptId = 'wa-w1-t1'
      const crafted = craftCrashedWorkState(harness, worldA, {
        workAttemptId,
        runId: 'run-crashed',
        adapterHandle,
        baseSha,
        baseTreeOid,
        round: 1,
      })
      assert.equal(saveRunState(harness.repositoryHome, worldA.encoded, crafted.state).kind, 'ok')
      const created = await createTicketWorkspace(
        { git: runGit },
        {
          repositoryRoot: harness.repo.root,
          repositoryHome: harness.repositoryHome,
          repositoryId: 'R_kgDOMAP',
          runId: 'run-crashed',
          ticketNumber: 1,
          workAttemptId,
          base: { sha: baseSha, treeOid: baseTreeOid },
        },
      )
      assert.equal(created.kind, 'ok')
      const reserved = await reserveWorkSlot(
        harness.repositoryHome,
        { runId: 'run-crashed', encodedMapIssueId: worldA.encoded, workAttemptId },
        2,
      )
      assert.equal(reserved.kind, 'ok')

      // The map lock vanished with the crash; the reservation did not.
      assert.equal(await isMapLockHeld(harness.repositoryHome, worldA.encoded), false)
      let stale = await reconcileStaleWorkSlots(harness.repositoryHome)
      assert.equal(stale.kind, 'ok')
      if (stale.kind === 'ok') {
        assert.deepEqual(stale.value.released, [])
        assert.deepEqual(
          stale.value.retained.map((entry) => [entry.reservation.workAttemptId, entry.reason]),
          [[workAttemptId, 'attempt-live']],
        )
      }

      // --- the other run works within the remaining capacity ---------------

      const holdB1 = harness.runner.holdWorker('I_b1')
      const runB = harness.run(worldB)
      await holdB1.launched
      await pollUntil(
        'run B charged the remaining slot',
        () => harness.slotReservations().some((entry) => entry.workAttemptId === 'wa-w1-t2'),
        10_000,
      )
      assert.equal(harness.slotReservations().length, 2, 'capacity is fully charged')
      await assertNever(
        'run B launched its second worker while the crashed run held a slot',
        () => harness.runner.workerLaunchesOf('I_b2').length > 0,
        300,
      )

      // --- the orphan dies: settlement becomes provable, but the attempt is
      // still live — the reservation stays charged (map lock still absent).

      orphan.kill('SIGKILL')
      orphan = undefined
      assert.ok(await waitForProcessGroupExit(pgid, { timeoutMs: 10_000 }))
      stale = await reconcileStaleWorkSlots(harness.repositoryHome)
      assert.equal(stale.kind, 'ok')
      if (stale.kind === 'ok') {
        assert.deepEqual(stale.value.released, [], 'a live attempt is never reclaimed from outside')
        const crashed = stale.value.retained.find(
          (entry) => entry.reservation.workAttemptId === workAttemptId,
        )
        assert.ok(crashed !== undefined, 'the crashed run keeps its slot charged')
        assert.equal(crashed.reason, 'attempt-live')
      }
      assert.equal(await isMapLockHeld(harness.repositoryHome, worldA.encoded), false)

      // --- the crashed run resumes: reconciliation proves settlement, the
      // attempt finishes, and only then does the slot free for run B.

      const runAResume = harness.run(worldA)
      await pollUntil(
        'the crashed run released its slot after settlement',
        () => !harness.slotReservations().some((entry) => entry.workAttemptId === workAttemptId),
        60_000,
      )
      await pollUntil(
        'run B acquired the reclaimed slot',
        () => harness.runner.workerLaunchesOf('I_b2').length > 0,
        30_000,
      )

      holdB1.release()
      const [outcomeA, outcomeB] = await Promise.all([runAResume, runB])
      assert.equal(outcomeA.kind, 'ok')
      assert.equal(outcomeA.value.runId, 'run-crashed', 'resume keeps the run ID')
      assert.equal(outcomeA.value.label, 'passed')
      assert.equal(outcomeB.kind, 'ok')
      assert.equal(outcomeB.value.label, 'passed')

      assert.deepEqual(harness.slotReservations(), [])
      assert.equal(harness.pushStats().maxInFlight, 1)
      assert.equal(harness.pushStats().count, 3)
      assert.equal(harness.remoteLog().length, 4)
    } finally {
      if (orphan !== undefined) orphan.kill('SIGKILL')
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. The preflight claim race: creation under the control lock (§16)
// ---------------------------------------------------------------------------

describe('preflight member claims are atomic under the control lock', () => {
  it('blocks a second run whose preflight passed when an overlapping claim lands in the window', { timeout: 60_000 }, async () => {
    const harness = await makeCrossMapHarness({
      label: 'claim-race-overlap',
      concurrency: 2,
      maps: [
        { issueId: 'I_mapA', number: 6, runId: 'run-a1', members: [member('I_T', 1)] },
        { issueId: 'I_mapB', number: 9, runId: 'run-b1', members: [member('I_T', 1)] },
      ],
    })
    try {
      const worldA = harness.world('I_mapA')
      const worldB = harness.world('I_mapB')

      // The window: run B's preflight and map-lock acquisition happen while
      // the control lock is held, so its creation claim waits — and another
      // coordinator's claim for the same Ticket lands first.
      const control = await acquireControlLock(harness.repositoryHome)
      assert.equal(control.kind, 'ok')
      const runB = harness.run(worldB)
      await pollUntil(
        'run B passed preflight and took its map lock',
        () => isMapLockHeld(harness.repositoryHome, worldB.encoded),
        20_000,
      )

      const claim = craftClaimState(harness, worldA, 'run-a1')
      assert.equal(saveRunState(harness.repositoryHome, worldA.encoded, claim).kind, 'ok')

      await control!.value.release()
      const outcome = await runB

      assert.equal(outcome.kind, 'blocked')
      assert.equal(outcome.code, 'check-findings')
      assert.match(JSON.stringify(outcome.evidence), /ticket-claimed-by-active-run/)
      assert.equal(harness.runStateOf(worldB), undefined, 'the blocked run claimed nothing')
    } finally {
      await harness.settleAll()
      harness.cleanup()
    }
  })

  it('blocks a second run on a configRevision that disagrees, whenever the claim lands', { timeout: 60_000 }, async () => {
    const harness = await makeCrossMapHarness({
      label: 'claim-race-config',
      concurrency: 2,
      maps: [
        { issueId: 'I_mapA', number: 6, runId: 'run-a1', members: [member('I_a1', 1)] },
        { issueId: 'I_mapB', number: 9, runId: 'run-b1', members: [member('I_b1', 2)] },
      ],
    })
    try {
      const worldA = harness.world('I_mapA')
      const worldB = harness.world('I_mapB')

      const control = await acquireControlLock(harness.repositoryHome)
      assert.equal(control.kind, 'ok')
      const runB = harness.run(worldB)
      await pollUntil(
        'run B passed preflight and took its map lock',
        () => isMapLockHeld(harness.repositoryHome, worldB.encoded),
        20_000,
      )

      const claim = craftClaimState(harness, worldA, 'run-a1', canonicalJsonDigest({ other: 'config' }) as Sha256Digest)
      assert.equal(saveRunState(harness.repositoryHome, worldA.encoded, claim).kind, 'ok')

      await control!.value.release()
      const outcome = await runB

      assert.equal(outcome.kind, 'blocked')
      assert.match(JSON.stringify(outcome.evidence), /incompatible-active-run/)
      assert.equal(harness.runStateOf(worldB), undefined)
    } finally {
      await harness.settleAll()
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Extension claim races resolve under the control lock (§7.4, §16)
// ---------------------------------------------------------------------------

describe('extension claim races resolve under the control lock', () => {
  it('lets exactly one of two racing runs claim the same added Ticket', { timeout: 120_000 }, async () => {
    const harness = await makeCrossMapHarness({
      label: 'extension-race',
      concurrency: 4,
      maps: [
        { issueId: 'I_mapA', number: 6, runId: 'run-a1', members: [member('I_a1', 1)] },
        { issueId: 'I_mapB', number: 9, runId: 'run-b1', members: [member('I_b1', 2)] },
      ],
    })
    try {
      const worldA = harness.world('I_mapA')
      const worldB = harness.world('I_mapB')
      const contested = member('I_T', 3)

      // Both maps grow the same added Ticket at their wave-1 barriers.
      worldA.changes.push({
        when: () => worldA.observed.workReviewerLaunches >= 1,
        apply: () => harness.addMember(worldA, contested),
      })
      worldB.changes.push({
        when: () => worldB.observed.workReviewerLaunches >= 1,
        apply: () => harness.addMember(worldB, contested),
      })

      const holdA1 = harness.runner.holdWorker('I_a1')
      const holdB1 = harness.runner.holdWorker('I_b1')
      const runA = harness.run(worldA)
      const runB = harness.run(worldB)
      await holdA1.launched
      await holdB1.launched

      // Both attempts seal first (their slots release), then each run reads
      // the extension at its barrier. Freeze the adoption boundary: the
      // control lock is held once both attempts have settled, so whichever
      // coordinator reaches the lock second must resolve against the first's
      // claim — under the lock — regardless of scheduling.
      holdA1.release()
      holdB1.release()
      await pollUntil(
        'both wave-1 attempts settled and released their slots',
        () =>
          !harness
            .slotReservations()
            .some((entry) => entry.workAttemptId === 'wa-w1-t1' || entry.workAttemptId === 'wa-w1-t2'),
        30_000,
      )
      const control = await acquireControlLock(harness.repositoryHome)
      assert.equal(control.kind, 'ok', control.kind === 'error' ? control.reason : 'control lock held')
      await pollUntil(
        'both barriers served the extension',
        () =>
          worldA.observed.membersSeen.has('I_T') && worldB.observed.membersSeen.has('I_T'),
        30_000,
      )
      await control!.value.release()

      const [outcomeA, outcomeB] = await Promise.all([runA, runB])
      const outcomes = [
        { world: worldA, outcome: outcomeA },
        { world: worldB, outcome: outcomeB },
      ]
      const winners = outcomes.filter((entry) => entry.outcome.kind === 'ok')
      const losers = outcomes.filter((entry) => entry.outcome.kind !== 'ok')
      assert.equal(winners.length, 1, `exactly one run claims the Ticket: ${outcomes.map((entry) => entry.outcome.kind).join(', ')}`)
      assert.equal(losers.length, 1)

      // The winner adopted the extension, worked, and completed the Ticket.
      const winner = winners[0]!
      const winnerState = harness.runStateOf(winner.world)!
      assert.equal(winnerState.acceptedMapRevisions.length, 2)
      assert.deepEqual(winnerState.acceptedMapRevisions[1]?.extension?.addedTicketIssueIds, ['I_T'])
      assert.equal(winner.outcome.kind === 'ok' ? winner.outcome.value.label : '', 'passed')
      assert.equal(
        winnerState.tickets.I_T?.phase,
        'completed',
        'the winning run completed the contested Ticket',
      )

      // The loser was blocked before claiming or shipping anything of it.
      const loser = losers[0]!
      const loserOutcome = loser.outcome
      assert.equal(loserOutcome.kind, 'blocked')
      assert.equal(loserOutcome.code, 'changed-input')
      const loserState = harness.runStateOf(loser.world)!
      assert.equal(loserState.acceptedMapRevisions.length, 1)
      assert.equal(loserState.tickets.I_T, undefined, 'the losing run never claimed the Ticket')
      assert.equal(loserState.status, 'terminal')

      // Exactly one run ever claimed the Ticket, and pushes stayed serial.
      const claimants = [worldA, worldB].filter((world) => {
        const state = harness.runStateOf(world)
        return state?.acceptedMapRevisions.some((entry) =>
          entry.payload.members.some((candidate) => candidate.ticketIssueId === 'I_T'),
        )
      })
      assert.equal(claimants.length, 1)
      assert.equal(harness.pushStats().maxInFlight, 1)
      assert.equal(harness.pushStats().count, 2)
      assert.equal(harness.remoteLog().length, 3)
    } finally {
      await harness.settleAll()
      harness.cleanup()
    }
  })

  it('prevents adoption of a Ticket another run already owns, without a race', { timeout: 120_000 }, async () => {
    const harness = await makeCrossMapHarness({
      label: 'extension-owned',
      concurrency: 4,
      maps: [
        { issueId: 'I_mapA', number: 6, runId: 'run-a1', members: [member('I_a1', 1)] },
        {
          issueId: 'I_mapB',
          number: 9,
          runId: 'run-b1',
          members: [member('I_b1', 2), member('I_T', 3, { blockers: ['I_b1'] })],
        },
      ],
    })
    try {
      const worldA = harness.world('I_mapA')
      const worldB = harness.world('I_mapB')

      // Run B claims I_T at creation; run A's map grows it mid-flight.
      worldA.changes.push({
        when: () => worldA.observed.workReviewerLaunches >= 1,
        apply: () => harness.addMember(worldA, member('I_T', 3)),
      })

      const holdA1 = harness.runner.holdWorker('I_a1')
      const runA = harness.run(worldA)
      await holdA1.launched

      // Let run B run to completion first — its claim of I_T is durable —
      // then release run A into its barrier adoption.
      const outcomeB = await harness.run(worldB)
      assert.equal(outcomeB.kind, 'ok')

      holdA1.release()
      const outcomeA = await runA
      assert.equal(outcomeA.kind, 'blocked')
      assert.equal(outcomeA.code, 'changed-input')

      const stateA = harness.runStateOf(worldA)!
      assert.equal(stateA.acceptedMapRevisions.length, 1, 'the extension was not adopted')
      assert.equal(stateA.tickets.I_T, undefined)
      assert.equal(stateA.status, 'terminal')
      assert.equal(worldA.observed.pushes, 0)
    } finally {
      await harness.settleAll()
      harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. Interleaved Ship: serial pushes, fresh gates, conflict blocks (§11, §16)
// ---------------------------------------------------------------------------

describe('interleaved Ships serialize on the target lock', () => {
  it('never pushes simultaneously; the later run re-gates on target advancement', { timeout: 120_000 }, async () => {
    const harness = await makeCrossMapHarness({
      label: 'ship-interleave',
      concurrency: 4,
      maps: [
        {
          issueId: 'I_mapA',
          number: 6,
          runId: 'run-a1',
          members: [member('I_a1', 1, { file: 'feature-a.txt' })],
        },
        {
          issueId: 'I_mapB',
          number: 9,
          runId: 'run-b1',
          members: [member('I_b1', 2, { file: 'feature-b.txt' })],
        },
      ],
    })
    try {
      const worldA = harness.world('I_mapA')
      const worldB = harness.world('I_mapB')

      const holdA1 = harness.runner.holdWorker('I_a1')
      const holdB1 = harness.runner.holdWorker('I_b1')
      const runA = harness.run(worldA)
      const runB = harness.run(worldB)
      await holdA1.launched
      await holdB1.launched
      holdA1.release()
      holdB1.release()

      const [outcomeA, outcomeB] = await Promise.all([runA, runB])
      assert.equal(outcomeA.kind, 'ok')
      assert.equal(outcomeB.kind, 'ok')

      // Mutual exclusion: pushes never overlapped, whichever run shipped first.
      assert.equal(harness.pushStats().maxInFlight, 1, 'pushes must never overlap')
      assert.equal(harness.pushStats().count, 2)
      assert.equal(harness.remoteLog().length, 3)

      // The later shipper found an advanced target and re-gated: exactly one
      // fresh ship review across both runs (the first shipper reuses its
      // Work evidence against the unchanged target; §11.2).
      const shipReviews = worldA.observed.shipReviewerLaunches + worldB.observed.shipReviewerLaunches
      assert.equal(shipReviews, 1, 'the later shipper alone receives a fresh review')

      // The target stayed linear: the second integration's parent is the
      // first, and both runs' tickets completed.
      const second = remoteGitText(harness, ['rev-parse', 'main'])
      const first = remoteGitText(harness, ['rev-parse', 'main~1'])
      assert.notEqual(second, first)
      assert.equal(
        remoteGitText(harness, ['rev-list', '--count', `${first}..${second}`]),
        '1',
      )
    } finally {
      await harness.settleAll()
      harness.cleanup()
    }
  })

  it('reworks the losing conflict in-run instead of overwriting the first shipment', { timeout: 120_000 }, async () => {
    const harness = await makeCrossMapHarness({
      label: 'ship-conflict',
      concurrency: 4,
      maps: [
        {
          issueId: 'I_mapA',
          number: 6,
          runId: 'run-a1',
          members: [member('I_a1', 1, { file: 'shared.txt' })],
        },
        {
          issueId: 'I_mapB',
          number: 9,
          runId: 'run-b1',
          members: [member('I_b1', 2, { file: 'shared.txt' })],
        },
      ],
    })
    try {
      const worldA = harness.world('I_mapA')
      const worldB = harness.world('I_mapB')

      const holdA1 = harness.runner.holdWorker('I_a1')
      const holdB1 = harness.runner.holdWorker('I_b1')
      const runA = harness.run(worldA)
      const runB = harness.run(worldB)
      await holdA1.launched
      await holdB1.launched
      holdA1.release()
      holdB1.release()

      const [outcomeA, outcomeB] = await Promise.all([runA, runB])
      assert.equal(outcomeA.kind, 'ok')
      assert.equal(outcomeB.kind, 'ok')

      // Mutual exclusion: pushes never overlapped, whichever run shipped first.
      assert.equal(harness.pushStats().maxInFlight, 1, 'pushes must never overlap')
      assert.equal(harness.pushStats().count, 2)
      assert.equal(worldA.observed.pushes + worldB.observed.pushes, 2)

      // The run that lost the replay reworked its Ticket in a second Wave and
      // shipped on top of the winner: init plus two integrations in linear
      // history, never an overwrite.
      assert.equal(harness.remoteLog().length, 3)
      const second = remoteGitText(harness, ['rev-parse', 'main'])
      const first = remoteGitText(harness, ['rev-parse', 'main~1'])
      assert.notEqual(second, first)
      assert.equal(
        remoteGitText(harness, ['rev-list', '--count', `${first}..${second}`]),
        '1',
      )

      // Exactly one run consumed an in-run rework, and its Ticket completed.
      const reworked = [worldA, worldB].filter(
        (world) =>
          (harness.runStateOf(world)?.reworks?.[world.members[0]!.issueId]?.cycles ?? 0) === 1,
      )
      assert.equal(reworked.length, 1)
      const loserState = harness.runStateOf(reworked[0]!)!
      assert.equal(loserState.tickets[reworked[0]!.members[0]!.issueId]?.phase, 'completed')
      assert.equal(
        loserState.reworks![reworked[0]!.members[0]!.issueId]!.conflict.code,
        'integration-conflict',
      )
    } finally {
      await harness.settleAll()
      harness.cleanup()
    }
  })
})
