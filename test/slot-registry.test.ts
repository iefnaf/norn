import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { encodeLocalProcessHandle } from '../src/agents/local-runner.ts'
import { spawnProcessGroup, waitForProcessGroupExit } from '../src/agents/process-group.ts'
import { canonicalJsonDigest } from '../src/core/digest.ts'
import { computeMapRevision, computeTicketRevision } from '../src/core/revision.ts'
import { isBlocked, isOk } from '../src/core/outcome.ts'
import { saveRunState } from '../src/runstate/run-state-store.ts'
import type { RunState } from '../src/runstate/types.ts'
import {
  readWorkSlotRegistry,
  releaseWorkSlot,
  reserveWorkSlot,
} from '../src/runstate/slot-registry.ts'

const HOST = 'github.com'
const REPOSITORY_ID = 'R_kgDOB123'
const MAP_ISSUE_ID = 'I_map'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'norn-slots-'))
}

function runStateWithLiveGroup(workAttemptId: string, pgid: number, adapterHandle: string): RunState {
  const ticketRevision = computeTicketRevision({
    githubHost: HOST,
    repositoryId: REPOSITORY_ID,
    ticketIssueId: 'I_A',
    title: 'Ticket',
    body: 'body',
  }).revision
  const map = computeMapRevision({
    githubHost: HOST,
    repositoryId: REPOSITORY_ID,
    mapIssueId: MAP_ISSUE_ID,
    title: 'Map',
    body: null,
    members: [{ ticketIssueId: 'I_A', ticketRevision }],
    dependencies: [],
  })
  const workspace = {
    kind: 'ticket' as const,
    repositoryId: REPOSITORY_ID,
    runId: 'run-1',
    path: '/norn/runs/run-1/workspaces/7/wa-1',
    branch: 'norn/run-1/7/wa-1',
    workAttemptId,
  }
  return {
    schema: 'norn-run-state:v1',
    runId: 'run-1',
    map: {
      role: 'map',
      githubHost: HOST,
      repositoryId: REPOSITORY_ID,
      issueId: MAP_ISSUE_ID,
      number: 6,
      url: 'https://github.com/iefnaf/norn/issues/6',
    },
    acceptedMapRevisions: [{ revision: map.revision, payload: map.payload }],
    configRevision: canonicalJsonDigest({ c: 1 }),
    nornVersion: '0.1.0',
    status: 'running',
    wave: 1,
    activeWave: {
      number: 1,
      mapRevision: map.revision,
      target: {
        branch: 'main',
        baseSha: 'sha1:' + '1'.repeat(40),
        baseTreeOid: 'sha1:' + '2'.repeat(40),
      },
      frontierTicketIssueIds: ['I_A'],
      shipQueueTicketIssueIds: [],
      nextShipIndex: 0,
    },
    parkedTickets: [],
    tickets: {
      I_A: {
        phase: 'working',
        wave: 1,
        attempt: {
          workAttemptId,
          input: {
            ticket: {
              role: 'ticket',
              githubHost: HOST,
              repositoryId: REPOSITORY_ID,
              issueId: 'I_A',
              number: 7,
              url: 'https://github.com/iefnaf/norn/issues/7',
            },
            spec: {
              mapTitle: 'Map',
              mapBody: '',
              mapRevision: map.revision,
              ticketTitle: 'Ticket',
              ticketBody: 'body',
              ticketRevision,
            },
            target: {
              branch: 'main',
              baseSha: 'sha1:' + '1'.repeat(40),
              baseTreeOid: 'sha1:' + '2'.repeat(40),
            },
          },
          branch: 'norn/run-1/7/wa-1',
          workspace,
          round: 1,
          slot: 'reserved',
          processGroupIds: ['pg-1'],
        },
      },
    },
    activeProcesses: [
      {
        id: 'pg-1',
        owner: 'worker',
        phase: 'work',
        workspace,
        ticketIssueId: 'I_A',
        workAttemptId,
        adapterHandle,
        state: 'running',
      },
    ],
  } as unknown as RunState
}

describe('Work-slot registry: the persisted handshake', () => {
  it('creates the registry under repository home with the authoritative capacity', async () => {
    const home = tempHome()
    try {
      const outcome = await reserveWorkSlot(home, { runId: 'run-1', encodedMapIssueId: MAP_ISSUE_ID, workAttemptId: 'wa-1' }, 2)
      assert.ok(isOk(outcome))
      if (outcome.kind === 'ok') assert.equal(outcome.value.reserved, true)
      const registry = await readWorkSlotRegistry(home)
      assert.ok(isOk(registry))
      if (registry.kind === 'ok' && registry.value !== undefined) {
        assert.equal(registry.value.capacity, 2)
        assert.deepEqual(registry.value.reserved, [
          { runId: 'run-1', encodedMapIssueId: MAP_ISSUE_ID, workAttemptId: 'wa-1' },
        ])
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('charges the repository-wide capacity shared across maps, then reports full', async () => {
    const home = tempHome()
    try {
      for (let index = 0; index < 2; index++) {
        const outcome = await reserveWorkSlot(
          home,
          { runId: `run-${index + 1}`, encodedMapIssueId: `I_map${index + 1}`, workAttemptId: `wa-${index + 1}` },
          2,
        )
        assert.ok(isOk(outcome))
        if (outcome.kind === 'ok') assert.equal(outcome.value.reserved, true)
      }
      const full = await reserveWorkSlot(
        home,
        { runId: 'run-3', encodedMapIssueId: 'I_map3', workAttemptId: 'wa-3' },
        2,
      )
      assert.ok(isOk(full))
      if (full.kind === 'ok') assert.equal(full.value.reserved, false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('is idempotent for the same work attempt: recovery may reacquire its own slot', async () => {
    const home = tempHome()
    try {
      const reservation = { runId: 'run-1', encodedMapIssueId: MAP_ISSUE_ID, workAttemptId: 'wa-1' }
      const first = await reserveWorkSlot(home, reservation, 1)
      assert.ok(isOk(first))
      const again = await reserveWorkSlot(home, reservation, 1)
      assert.ok(isOk(again))
      if (again.kind === 'ok') assert.equal(again.value.reserved, true)
      const other = await reserveWorkSlot(home, { ...reservation, workAttemptId: 'wa-2' }, 1)
      assert.ok(isOk(other))
      if (other.kind === 'ok') assert.equal(other.value.reserved, false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects a capacity that disagrees with the one authoritative value', async () => {
    const home = tempHome()
    try {
      const first = await reserveWorkSlot(home, { runId: 'r', encodedMapIssueId: 'I_map', workAttemptId: 'wa-1' }, 4)
      assert.ok(isOk(first))
      const mismatched = await reserveWorkSlot(home, { runId: 'r', encodedMapIssueId: 'I_map', workAttemptId: 'wa-2' }, 3)
      assert.ok(mismatched.kind === 'error')
      if (mismatched.kind === 'error') {
        assert.equal(mismatched.code, 'slot-registry')
        assert.match(mismatched.reason, /capacity/)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects a corrupted registry document as an error', async () => {
    const home = tempHome()
    try {
      mkdirSync(join(home, 'locks'), { recursive: true })
      writeFileSync(join(home, 'locks', 'work-slots.json'), '{ torn', 'utf8')
      const outcome = await reserveWorkSlot(home, { runId: 'r', encodedMapIssueId: 'I_map', workAttemptId: 'wa-1' }, 2)
      assert.ok(outcome.kind === 'error')
      if (outcome.kind === 'error') {
        assert.equal(outcome.code, 'slot-registry')
        assert.match(outcome.reason, /not valid JSON/)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('Work-slot release: settlement proof from persisted truth', () => {
  it('releases a reservation that no run state records: launch intent precedes every child', async () => {
    const home = tempHome()
    try {
      const reservation = { runId: 'run-gone', encodedMapIssueId: 'I_gone', workAttemptId: 'wa-gone' }
      const reserved = await reserveWorkSlot(home, reservation, 2)
      assert.ok(isOk(reserved))
      const released = await releaseWorkSlot(home, 'wa-gone')
      assert.ok(isOk(released))
      const registry = await readWorkSlotRegistry(home)
      assert.ok(isOk(registry))
      if (registry.kind === 'ok' && registry.value !== undefined) {
        assert.deepEqual(registry.value.reserved, [])
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('is idempotent when the reservation is already gone', async () => {
    const home = tempHome()
    try {
      const released = await releaseWorkSlot(home, 'wa-never')
      assert.ok(isOk(released))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('refuses to release while a recorded process group is still live, then releases once settled', { timeout: 30_000 }, async () => {
    const home = tempHome()
    let child: Awaited<ReturnType<typeof spawnProcessGroup>> | undefined
    try {
      child = await spawnProcessGroup(['sleep', '30'])
      const pgid = child.pid as number
      const handle = encodeLocalProcessHandle(pgid)
      const state = runStateWithLiveGroup('wa-1', pgid, handle)
      const saved = saveRunState(home, MAP_ISSUE_ID, state)
      assert.ok(saved.kind === 'ok', saved.kind === 'error' ? saved.reason : '')

      const reservation = { runId: 'run-1', encodedMapIssueId: MAP_ISSUE_ID, workAttemptId: 'wa-1' }
      const reserved = await reserveWorkSlot(home, reservation, 1)
      assert.ok(isOk(reserved))

      const refused = await releaseWorkSlot(home, 'wa-1')
      assert.ok(isBlocked(refused), 'a live recorded process group must keep the slot charged')
      if (refused.kind === 'blocked') {
        assert.equal(refused.code, 'process-groups-live')
        assert.match(refused.reason, /pg-1/)
      }
      const registry = await readWorkSlotRegistry(home)
      assert.ok(isOk(registry))
      if (registry.kind === 'ok' && registry.value !== undefined) {
        assert.equal(registry.value.reserved.length, 1)
      }

      // The recorded group exits; the reservation is now releasable.
      child.kill('SIGKILL')
      child = undefined
      const exited = await waitForProcessGroupExit(pgid, { timeoutMs: 10_000 })
      assert.ok(exited)
      const released = await releaseWorkSlot(home, 'wa-1')
      assert.ok(isOk(released), released.kind === 'error' || released.kind === 'blocked' ? released.reason : '')
      const emptied = await readWorkSlotRegistry(home)
      assert.ok(isOk(emptied))
      if (emptied.kind === 'ok' && emptied.value !== undefined) {
        assert.deepEqual(emptied.value.reserved, [])
      }
    } finally {
      if (child !== undefined) child.kill('SIGKILL')
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('treats an unprovable adapter handle as live, so the slot stays charged', async () => {
    const home = tempHome()
    try {
      const state = runStateWithLiveGroup('wa-1', 0, JSON.stringify({ adapter: 'herdr', paneId: '%1' }))
      const saved = saveRunState(home, MAP_ISSUE_ID, state)
      assert.ok(saved.kind === 'ok', saved.kind === 'error' ? saved.reason : '')
      const reservation = { runId: 'run-1', encodedMapIssueId: MAP_ISSUE_ID, workAttemptId: 'wa-1' }
      await reserveWorkSlot(home, reservation, 1)

      const refused = await releaseWorkSlot(home, 'wa-1')
      assert.ok(isBlocked(refused))
      if (refused.kind === 'blocked') assert.equal(refused.code, 'process-groups-live')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('refuses to release when the recorded run state cannot be proven', async () => {
    const home = tempHome()
    try {
      const state = runStateWithLiveGroup('wa-1', 123, encodeLocalProcessHandle(123))
      const saved = saveRunState(home, MAP_ISSUE_ID, state)
      assert.ok(saved.kind === 'ok')
      const reservation = { runId: 'run-1', encodedMapIssueId: MAP_ISSUE_ID, workAttemptId: 'wa-1' }
      await reserveWorkSlot(home, reservation, 1)

      // Corrupt the recorded state: settlement can no longer be established.
      writeFileSync(
        join(home, 'maps', MAP_ISSUE_ID, 'run-state.json'),
        '{ not json',
        'utf8',
      )
      const refused = await releaseWorkSlot(home, 'wa-1')
      assert.ok(refused.kind === 'error')
      if (refused.kind === 'error') {
        assert.equal(refused.code, 'slot-registry')
        assert.match(refused.reason, /settlement/)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
