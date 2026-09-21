/**
 * Test fixture: a coordinator child that writes a Run State document twice
 * through the real atomic store, so a parent can SIGKILL it mid-write and
 * verify the target document is never torn.
 *
 * The first state is small; the second embeds a multi-megabyte filler in a
 * report warning so the temporary-file write and fsync occupy a wide window
 * before the atomic rename.
 */
import { randomUUID } from 'node:crypto'

import { computeMapRevision, computeTicketRevision } from '../../src/core/revision.ts'
import { saveRunState } from '../../src/runstate/run-state-store.ts'
import type { RunState } from '../../src/runstate/types.ts'

function baseState(filler: string): RunState {
  const host = 'github.com'
  const repositoryId = 'R_kgDOB123'
  const runId = 'run-crash-test'

  const ticketA = computeTicketRevision({
    githubHost: host,
    repositoryId,
    ticketIssueId: 'I_A',
    title: 'First ticket',
    body: 'Body A',
  })
  const ticketB = computeTicketRevision({
    githubHost: host,
    repositoryId,
    ticketIssueId: 'I_B',
    title: 'Second ticket',
    body: null,
  })
  const map = computeMapRevision({
    githubHost: host,
    repositoryId,
    mapIssueId: 'I_map',
    title: 'Crash test map',
    body: null,
    members: [
      { ticketIssueId: 'I_A', ticketRevision: ticketA.revision },
      { ticketIssueId: 'I_B', ticketRevision: ticketB.revision },
    ],
    dependencies: [{ blockerIssueId: 'I_A', blockedIssueId: 'I_B' }],
  })

  return {
    schema: 'norn-run-state:v1',
    runId,
    map: {
      role: 'map',
      githubHost: host,
      repositoryId,
      issueId: 'I_map',
      number: 6,
      url: 'https://github.com/iefnaf/norn/issues/6',
    },
    acceptedMapRevisions: [{ revision: map.revision, payload: map.payload }],
    configRevision: ticketA.revision,
    nornVersion: '0.1.0',
    status: filler === '' ? 'running' : 'terminal',
    wave: 1,
    activeWave: {
      number: 1,
      mapRevision: map.revision,
      target: {
        branch: 'main',
        baseSha: 'sha1:' + 'a'.repeat(40),
        baseTreeOid: 'sha1:' + 'b'.repeat(40),
      },
      frontierTicketIssueIds: ['I_A', 'I_B'],
      shipQueueTicketIssueIds: [],
      nextShipIndex: 0,
    },
    parkedTickets: [],
    tickets: {
      I_A: { phase: 'waiting' },
      I_B: { phase: 'waiting' },
    },
    activeProcesses: [],
    report:
      filler === ''
        ? undefined
        : {
            label: 'blocked',
            code: 'crash-window-filler',
            runId,
            initialMapRevision: map.revision,
            finalMapRevision: map.revision,
            acceptedExtensions: [],
            tickets: [
              {
                ticket: {
                  role: 'ticket',
                  githubHost: host,
                  repositoryId,
                  issueId: 'I_A',
                  number: 7,
                  url: 'https://github.com/iefnaf/norn/issues/7',
                },
                state: 'waiting',
              },
            ],
            sharedWrite: 'none',
            warnings: [filler],
          },
  }
}

async function main(): Promise<void> {
  const home = process.argv[2]
  const mapId = process.argv[3]
  if (home === undefined || mapId === undefined) {
    process.stderr.write('usage: run-state-writer-child.ts <repositoryHome> <encodedIssueId>\n')
    process.exit(2)
  }

  const first = saveRunState(home, mapId, baseState(''))
  if (first.kind !== 'ok') {
    process.stderr.write(`v1 save failed: ${first.reason}\n`)
    process.exit(3)
  }
  process.stdout.write('v1-written\n')

  // A multi-megabyte document makes the temp-file write + fsync a wide,
  // reliably hittable window before the rename.
  const second = saveRunState(home, mapId, baseState(`filler-${randomUUID()}-` + 'x'.repeat(6_000_000)))
  if (second.kind !== 'ok') {
    process.stderr.write(`v2 save failed: ${second.reason}\n`)
    process.exit(4)
  }
  process.stdout.write('v2-written\n')
}

main().catch((cause) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`)
  process.exit(5)
})
