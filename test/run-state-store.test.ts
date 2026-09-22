import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { computeMapRevision, computeTicketRevision } from '../src/core/revision.ts'
import type { MapRevisionPayload } from '../src/core/revision.ts'
import { canonicalJsonDigest } from '../src/core/digest.ts'
import { isOk } from '../src/core/outcome.ts'
import { encodeLocalProcessHandle } from '../src/agents/local-runner.ts'
import type { DeliveryRecordV1, RunState } from '../src/runstate/types.ts'
import {
  checkRunStateIntegrity,
  loadRunState,
  runStateToJson,
  saveRunState,
} from '../src/runstate/run-state-store.ts'

const HOST = 'github.com'
const REPOSITORY_ID = 'R_kgDOB123'


function ticketRef(issueId: string, number: number) {
  return {
    role: 'ticket' as const,
    githubHost: HOST,
    repositoryId: REPOSITORY_ID,
    issueId,
    number,
    url: `https://github.com/iefnaf/norn/issues/${number}`,
  }
}

function ticketRevision(issueId: string): string {
  return computeTicketRevision({
    githubHost: HOST,
    repositoryId: REPOSITORY_ID,
    ticketIssueId: issueId,
    title: `Ticket ${issueId}`,
    body: `Body of ${issueId}`,
  }).revision
}

function initialPayload(): MapRevisionPayload {
  return computeMapRevision({
    githubHost: HOST,
    repositoryId: REPOSITORY_ID,
    mapIssueId: 'I_map',
    title: 'The map',
    body: 'Map body',
    members: [
      { ticketIssueId: 'I_A', ticketRevision: ticketRevision('I_A') },
      { ticketIssueId: 'I_B', ticketRevision: ticketRevision('I_B') },
    ],
    dependencies: [{ blockerIssueId: 'I_A', blockedIssueId: 'I_B' }],
  }).payload
}

function extendedPayload(base: MapRevisionPayload): MapRevisionPayload {
  return {
    ...base,
    members: [...base.members, { ticketIssueId: 'I_C', ticketRevision: ticketRevision('I_C') }],
  }
}

const WORKSPACE = {
  kind: 'ticket' as const,
  repositoryId: REPOSITORY_ID,
  runId: 'run-1',
  path: '/norn/runs/run-1/workspaces/7/wa-1',
  branch: 'norn/run-1/7/wa-1',
  workAttemptId: 'wa-1',
}

function workAttempt() {
  const inputTicketIssueId = 'I_A'
  return {
    workAttemptId: 'wa-1',
    input: {
      ticket: ticketRef(inputTicketIssueId, 7),
      spec: {
        mapTitle: 'The map',
        mapBody: 'Map body',
        mapRevision: canonicalJsonDigest(initialPayload() as never),
        ticketTitle: `Ticket ${inputTicketIssueId}`,
        ticketBody: `Body of ${inputTicketIssueId}`,
        ticketRevision: ticketRevision(inputTicketIssueId),
      },
      target: {
        branch: 'main',
        baseSha: 'sha1:' + '1'.repeat(40),
        baseTreeOid: 'sha1:' + '2'.repeat(40),
      },
    },
    branch: 'norn/run-1/7/wa-1',
    workspace: WORKSPACE,
    round: 0,
    slot: 'awaiting-reservation' as const,
    processGroupIds: [] as string[],
  }
}

function testEvidence(baseSha: string, treeOid: string) {
  return [
    {
      phase: 'work' as const,
      testIndex: 0,
      argv: ['npm', 'test'],
      timeoutMs: 120_000,
      baseSha,
      treeOid,
      exitCode: 0 as const,
      outputDigest: canonicalJsonDigest({ output: 'ok' }),
    },
  ]
}

function reviewEvidence(mapRevision: string, baseSha: string, treeOid: string) {
  return {
    phase: 'work' as const,
    provider: 'provider-b',
    model: 'provider-b/model-y',
    family: 'provider-b',
    thinking: 'high',
    verdict: 'pass' as const,
    mapRevision,
    ticketRevision: ticketRevision('I_A'),
    baseSha,
    treeOid,
    testEvidenceDigest: canonicalJsonDigest(testEvidence(baseSha, treeOid) as never),
  }
}

function shippableChange(mapRevision: string) {
  const baseSha = 'sha1:' + '1'.repeat(40)
  const candidateTreeOid = 'sha1:' + '3'.repeat(40)
  return {
    ticket: ticketRef('I_A', 7),
    mapRevision,
    ticketRevision: ticketRevision('I_A'),
    baseSha,
    candidateCommit: 'sha1:' + '4'.repeat(40),
    candidateTreeOid,
    workspace: WORKSPACE,
    tests: testEvidence(baseSha, candidateTreeOid),
    review: reviewEvidence(mapRevision, baseSha, candidateTreeOid),
  }
}

function deliveryRecord(change: ReturnType<typeof shippableChange>, integratedSha: string) {
  const record = {
    schema: 'norn-delivery:v1',
    deliveryId: '',
    run: { id: 'run-1', configRevision: canonicalJsonDigest({ config: 1 }), nornVersion: '0.1.0' },
    gate: {
      worker: { provider: 'provider-a', model: 'provider-a/model-x', family: 'provider-a', thinking: 'medium' },
      reviewer: { provider: 'provider-b', model: 'provider-b/model-y', family: 'provider-b', thinking: 'high' },
      tests: [{ argv: ['npm', 'test'], timeoutMs: 120_000 }],
    },
    map: { issueId: 'I_map', revision: change.mapRevision },
    ticket: { issueId: 'I_A', revision: change.ticketRevision },
    target: {
      repositoryId: REPOSITORY_ID,
      branch: 'main',
      baseSha: change.baseSha,
      integratedSha,
      treeOid: change.candidateTreeOid,
    },
    review: change.review,
    tests: change.tests,
    actorId: 'I_actor',
    recordedAt: '2025-01-02T03:04:05.006Z',
  }
  const { deliveryId: _omitted, ...sealed } = record
  record.deliveryId = canonicalJsonDigest(sealed as never)
  return record
}

function baseRunState() {
  const payload = initialPayload()
  const revision = canonicalJsonDigest(payload as never)
  return {
    schema: 'norn-run-state:v1',
    runId: 'run-1',
    map: {
      role: 'map',
      githubHost: HOST,
      repositoryId: REPOSITORY_ID,
      issueId: 'I_map',
      number: 6,
      url: 'https://github.com/iefnaf/norn/issues/6',
    },
    acceptedMapRevisions: [{ revision, payload }],
    configRevision: canonicalJsonDigest({ config: 1 }),
    nornVersion: '0.1.0',
    status: 'running',
    wave: 1,
    activeWave: {
      number: 1,
      mapRevision: revision,
      target: { branch: 'main', baseSha: 'sha1:' + '1'.repeat(40), baseTreeOid: 'sha1:' + '2'.repeat(40) },
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
  }
}

/** Deep-clone the fixture and apply overrides; every test builds from this. */
/**
 * A mutable, loosely-typed draft of the persisted document. Fixture edits
 * intentionally bypass the persisted type's readonly discriminants; the
 * integrity validator under test is what accepts or rejects the result.
 */
type DraftState = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

function stateWith(mutate: (state: DraftState) => void): RunState {
  const state = structuredClone(baseRunState()) as DraftState
  mutate(state)
  return state as unknown as RunState
}

function expectIntegrityViolation(state: RunState, pattern: RegExp): void {
  const outcome = checkRunStateIntegrity(state)
  assert.ok(outcome.kind === 'error', `expected a state-integrity error, got ${outcome.kind}`)
  if (outcome.kind === 'error') {
    assert.equal(outcome.code, 'state-integrity')
    assert.match(outcome.reason, pattern)
  }
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'norn-run-state-'))
}

describe('run state persistence: atomic save and load', () => {
  it('round-trips a valid document through save and load', () => {
    const home = tempHome()
    try {
      const state = stateWith(() => {})
      const saved = saveRunState(home, 'I_map', state)
      assert.ok(saved.kind === 'ok', saved.kind === 'error' ? saved.reason : '')
      const loaded = loadRunState(home, 'I_map')
      assert.ok(loaded.kind === 'ok')
      if (loaded.kind === 'ok') {
        assert.deepEqual(loaded.value, JSON.parse(runStateToJson(state)))
      }
      // Atomic writes leave exactly the document, no temporary files.
      assert.deepEqual(readdirSync(join(home, 'maps', 'I_map')), ['run-state.json'])
      assert.equal(readFileSync(join(home, 'maps', 'I_map', 'run-state.json'), 'utf8'), runStateToJson(state))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('reports an absent document as ok(undefined)', () => {
    const home = tempHome()
    try {
      const loaded = loadRunState(home, 'I_map')
      assert.ok(loaded.kind === 'ok')
      if (loaded.kind === 'ok') assert.equal(loaded.value, undefined)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('refuses to save a document that fails integrity checks', () => {
    const home = tempHome()
    try {
      const state = stateWith((draft) => {
        draft.wave = 5
      })
      const saved = saveRunState(home, 'I_map', state)
      assert.ok(saved.kind === 'error')
      if (saved.kind === 'error') assert.equal(saved.code, 'state-integrity')
      assert.equal(existsSync(join(home, 'maps', 'I_map', 'run-state.json')), false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('a leftover temporary file from a killed writer is ignored by loads', () => {
    const home = tempHome()
    try {
      saveRunState(home, 'I_map', stateWith(() => {}))
      writeFileSync(join(home, 'maps', 'I_map', 'run-state.json.tmp-leftover'), '{"schema":', 'utf8')
      const loaded = loadRunState(home, 'I_map')
      assert.ok(loaded.kind === 'ok')
      if (loaded.kind === 'ok' && loaded.value !== undefined) {
        assert.equal(loaded.value.runId, 'run-1')
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('run state integrity: torn and corrupted documents are errors', () => {
  it('rejects a torn (partially written) document', () => {
    const home = tempHome()
    try {
      const mapDir = join(home, 'maps', 'I_map')
      mkdirSync(mapDir, { recursive: true })
      writeFileSync(join(mapDir, 'run-state.json'), runStateToJson(stateWith(() => {})).slice(0, 400), 'utf8')
      const loaded = loadRunState(home, 'I_map')
      assert.ok(loaded.kind === 'error')
      if (loaded.kind === 'error') {
        assert.equal(loaded.code, 'state-integrity')
        assert.match(loaded.reason, /not valid JSON/)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects a wrong schema and non-object documents', () => {
    expectIntegrityViolation(stateWith((s) => { (s as { schema: string }).schema = 'other:v1' }), /schema/)
    expectIntegrityViolation(stateWith((s) => { delete (s as Record<string, unknown>).schema }), /missing required field "schema"/)
    expectIntegrityViolation({} as never as RunState, /missing required field "runId"/)
    expectIntegrityViolation(null as never as RunState, /JSON object/)
  })

  it('rejects unknown ticket phases and unknown fields', () => {
    expectIntegrityViolation(
      stateWith((s) => { s.tickets.I_A = { phase: 'exploding' } as never }),
      /known ticket phase/,
    )
    expectIntegrityViolation(
      stateWith((s) => { ;(s as unknown as Record<string, unknown>).surprise = true }),
      /unknown field "surprise"/,
    )
  })

  it('wave must agree with activeWave.number', () => {
    expectIntegrityViolation(stateWith((s) => { s.wave = 2 }), /wave \(2\) must equal activeWave\.number/)
  })

  it('parkedTickets must exactly match tickets with phase parked', () => {
    expectIntegrityViolation(
      stateWith((s) => {
        s.tickets.I_A = { phase: 'parked', wave: 1, outcome: { kind: 'blocked', code: 'x', reason: 'r', evidence: [] } }
      }),
      /parkedTickets must exactly match/,
    )
    expectIntegrityViolation(
      stateWith((s) => {
        s.tickets.I_A = { phase: 'parked', wave: 1, outcome: { kind: 'blocked', code: 'x', reason: 'r', evidence: [] } }
        s.parkedTickets = [ticketRef('I_A', 7), ticketRef('I_B', 8)] // B is not parked
      }),
      /parkedTickets must exactly match/,
    )
  })

  it('a parked ticket with a matching reference passes the parked-set check', () => {
    const outcome = checkRunStateIntegrity(
      stateWith((s) => {
        s.tickets.I_A = { phase: 'parked', wave: 1, outcome: { kind: 'blocked', code: 'cannot-satisfy-spec', reason: 'r', evidence: [] } }
        s.parkedTickets = [ticketRef('I_A', 7)]
      }),
    )
    assert.ok(outcome.kind === 'ok', outcome.kind === 'error' ? outcome.reason : '')
  })
})

describe('run state integrity: revision lineage re-hash and transitions', () => {
  it('accepts a valid compatible extension lineage', () => {
    const outcome = checkRunStateIntegrity(
      stateWith((s) => {
        const first = s.acceptedMapRevisions[0]!
        const extended = extendedPayload(first.payload as never)
        const revision = canonicalJsonDigest(extended as never)
        s.acceptedMapRevisions = [
          ...s.acceptedMapRevisions,
          { revision, payload: extended as never, extension: { fromRevision: first.revision, addedTicketIssueIds: ['I_C'] } },
        ]
        s.tickets.I_C = { phase: 'waiting' }
      }),
    )
    assert.ok(outcome.kind === 'ok', outcome.kind === 'error' ? outcome.reason : '')
  })

  it('rejects a payload that does not re-hash to its revision', () => {
    expectIntegrityViolation(
      stateWith((s) => {
        ;(s.acceptedMapRevisions[0]!.payload as { title: string }).title = 'tampered'
      }),
      /does not re-hash/,
    )
  })

  it('rejects an extension recorded on the preflight snapshot', () => {
    expectIntegrityViolation(
      stateWith((s) => {
        const entry = s.acceptedMapRevisions[0]!
        entry.extension = { fromRevision: entry.revision, addedTicketIssueIds: [] }
      }),
      /preflight snapshot and carries no extension/,
    )
  })

  it('rejects a transition whose fromRevision does not link', () => {
    expectIntegrityViolation(
      stateWith((s) => {
        const first = s.acceptedMapRevisions[0]!
        const extended = extendedPayload(first.payload as never)
        s.acceptedMapRevisions = [
          ...s.acceptedMapRevisions,
          {
            revision: canonicalJsonDigest(extended as never),
            payload: extended as never,
            extension: { fromRevision: canonicalJsonDigest({ other: 1 }), addedTicketIssueIds: ['I_C'] },
          },
        ]
        s.tickets.I_C = { phase: 'waiting' }
      }),
      /fromRevision must equal the previous revision/,
    )
  })

  it('rejects a removed accepted member', () => {
    expectIntegrityViolation(
      stateWith((s) => {
        const first = s.acceptedMapRevisions[0]!
        const shrunk = { ...(first.payload as never as MapRevisionPayload) }
        shrunk.members = shrunk.members.slice(0, 1)
        shrunk.dependencies = [] // dropping the member drops its edges too
        s.acceptedMapRevisions = [
          ...s.acceptedMapRevisions,
          {
            revision: canonicalJsonDigest(shrunk as never),
            payload: shrunk as never,
            extension: { fromRevision: first.revision, addedTicketIssueIds: [] },
          },
        ]
      }),
      /accepted member "I_B" was removed/,
    )
  })

  it('rejects a changed member revision and a changed blocker set', () => {
    expectIntegrityViolation(
      stateWith((s) => {
        const first = s.acceptedMapRevisions[0]!
        const payload = first.payload as never as MapRevisionPayload
        const edited = {
          ...payload,
          members: payload.members.map((member) =>
            member.ticketIssueId === 'I_B' ? { ...member, ticketRevision: ticketRevision('I_X') } : member,
          ),
        }
        s.acceptedMapRevisions = [
          ...s.acceptedMapRevisions,
          {
            revision: canonicalJsonDigest(edited as never),
            payload: edited as never,
            extension: { fromRevision: first.revision, addedTicketIssueIds: [] },
          },
        ]
      }),
      /accepted member "I_B" changed its revision/,
    )
    expectIntegrityViolation(
      stateWith((s) => {
        const first = s.acceptedMapRevisions[0]!
        const payload = first.payload as never as MapRevisionPayload
        const edited = {
          ...payload,
          members: [...payload.members, { ticketIssueId: 'I_C', ticketRevision: ticketRevision('I_C') }],
          dependencies: [...payload.dependencies, { blockerIssueId: 'I_C', blockedIssueId: 'I_B' }],
        }
        s.acceptedMapRevisions = [
          ...s.acceptedMapRevisions,
          {
            revision: canonicalJsonDigest(edited as never),
            payload: edited as never,
            extension: { fromRevision: first.revision, addedTicketIssueIds: ['I_C'] },
          },
        ]
        s.tickets.I_C = { phase: 'waiting' }
      }),
      /changed its complete blocker set/,
    )
  })

  it('rejects an unsorted or wrong recorded added-ticket delta', () => {
    const withExtension = (added: string[]) =>
      stateWith((s) => {
        const first = s.acceptedMapRevisions[0]!
        const payload = first.payload as never as MapRevisionPayload
        const extended: MapRevisionPayload = {
          ...payload,
          members: [
            ...payload.members,
            { ticketIssueId: 'I_C', ticketRevision: ticketRevision('I_C') },
            { ticketIssueId: 'I_D', ticketRevision: ticketRevision('I_D') },
          ],
        }
        s.acceptedMapRevisions = [
          ...s.acceptedMapRevisions,
          {
            revision: canonicalJsonDigest(extended as never),
            payload: extended as never,
            extension: { fromRevision: first.revision, addedTicketIssueIds: added },
          },
        ]
        s.tickets.I_C = { phase: 'waiting' }
        s.tickets.I_D = { phase: 'waiting' }
      })
    expectIntegrityViolation(withExtension(['I_D', 'I_C']), /added ticket IDs must be sorted/)
    expectIntegrityViolation(withExtension(['I_C']), /does not match the payloads/)
  })

  it('rejects a payload for a different map', () => {
    expectIntegrityViolation(
      stateWith((s) => {
        const payload = { ...s.acceptedMapRevisions[0]!.payload, mapIssueId: 'I_other' }
        s.acceptedMapRevisions = [{ revision: canonicalJsonDigest(payload as never), payload }]
      }),
      /must describe this map/,
    )
  })
})

describe('run state integrity: wave, checkpoint, and report agreements', () => {
  it('rejects an activeWave referencing unknown tickets or a foreign revision', () => {
    expectIntegrityViolation(
      stateWith((s) => { s.activeWave!.frontierTicketIssueIds = ['I_ghost'] }),
      /frontier references unknown ticket/,
    )
    expectIntegrityViolation(
      stateWith((s) => { s.activeWave!.mapRevision = canonicalJsonDigest({ nope: 1 }) }),
      /not in the accepted revision lineage/,
    )
  })

  it('rejects a working attempt referencing an unrecorded process group', () => {
    expectIntegrityViolation(
      stateWith((s) => {
        s.tickets.I_A = { phase: 'working', wave: 1, attempt: { ...workAttempt(), processGroupIds: ['pg-ghost'] } }
      }),
      /unrecorded process group "pg-ghost"/,
    )
  })

  it('accepts a working attempt whose process groups are recorded', () => {
    const outcome = checkRunStateIntegrity(
      stateWith((s) => {
        const attempt = { ...workAttempt(), processGroupIds: ['pg-1'], slot: 'reserved' as const }
        s.tickets.I_A = { phase: 'working', wave: 1, attempt }
        s.activeProcesses = [
          {
            id: 'pg-1',
            owner: 'worker',
            phase: 'work',
            workspace: WORKSPACE,
            ticketIssueId: 'I_A',
            workAttemptId: 'wa-1',
            adapterHandle: encodeLocalProcessHandle(4242),
            state: 'launch-intent',
          },
        ]
      }),
    )
    assert.ok(outcome.kind === 'ok', outcome.kind === 'error' ? outcome.reason : '')
  })

  function makeCheckpoint(change: ReturnType<typeof shippableChange>): Record<string, any> {
    return {
      stage: 'prepared' as 'prepared' | 'push-verified' | 'delivery-recorded' | 'ticket-closed',
      pushAttempts: 1,
      zeroDelta: false,
      baseSha: change.baseSha,
      integratedSha: change.candidateCommit,
      treeOid: change.candidateTreeOid,
      tests: change.tests,
      review: change.review,
      delivery: deliveryRecord(change, change.candidateCommit),
    }
  }

  function shippingState(mutate: (checkpoint: ReturnType<typeof makeCheckpoint>) => void): RunState {
    return stateWith((s) => {
      const mapRevision = s.acceptedMapRevisions[0]!.revision
      const change = shippableChange(mapRevision)
      const checkpoint = makeCheckpoint(change)
      mutate(checkpoint)
      s.tickets.I_A = { phase: 'shipping', wave: 1, change, checkpoint }
      s.activeWave!.shipQueueTicketIssueIds = ['I_A']
    })
  }

  it('rejects a shipping checkpoint whose zeroDelta disagrees with the persisted SHAs', () => {
    expectIntegrityViolation(
      shippingState((checkpoint) => {
        checkpoint.zeroDelta = true // disagrees: baseSha !== integratedSha
      }),
      /zeroDelta must agree with baseSha and integratedSha/,
    )
  })

  it('accepts a coherent shipping checkpoint', () => {
    const outcome = checkRunStateIntegrity(shippingState(() => {}))
    assert.ok(outcome.kind === 'ok', outcome.kind === 'error' ? outcome.reason : '')
  })

  it('rejects a tampered sealed delivery record', () => {
    expectIntegrityViolation(
      shippingState((checkpoint) => {
        checkpoint.delivery.actorId = 'I_tamperer'
      }),
      /deliveryId does not recompute/,
    )
  })

  it('rejects a report present in a non-terminal run and a terminal run without a report', () => {
    expectIntegrityViolation(
      stateWith((s) => {
        s.report = {
          label: 'blocked', code: 'changed-input', runId: 'run-1',
          initialMapRevision: s.acceptedMapRevisions[0]!.revision,
          finalMapRevision: s.acceptedMapRevisions[0]!.revision,
          acceptedExtensions: [], tickets: [], sharedWrite: 'none', warnings: [],
        }
      }),
      /only in a terminal run/,
    )
    expectIntegrityViolation(stateWith((s) => { s.status = 'terminal' }), /terminal run carries its report/)
  })

  function withReport(overrides: Record<string, unknown>): RunState {
    return stateWith((s) => {
      s.status = 'terminal'
      s.report = {
        label: 'passed',
        runId: 'run-1',
        initialMapRevision: s.acceptedMapRevisions[0]!.revision,
        finalMapRevision: s.acceptedMapRevisions[0]!.revision,
        acceptedExtensions: [],
        tickets: [],
        sharedWrite: 'confirmed',
        completionSha: 'sha1:' + '9'.repeat(40),
        warnings: [],
        ...overrides,
      } as never
    })
  }

  it('enforces the RunReport invariants of §13.1', () => {
    expectIntegrityViolation(withReport({ completionSha: undefined }), /passed report requires completionSha/)
    expectIntegrityViolation(withReport({ code: 'nope' }), /passed report carries no code/)
    expectIntegrityViolation(withReport({ sharedWrite: 'none' }), /passed report has sharedWrite "confirmed"/)
    expectIntegrityViolation(withReport({ label: 'blocked' }), /blocked report requires a code/)
    expectIntegrityViolation(withReport({ label: 'error', code: 'x' }), /terminal error report has sharedWrite "none"/)
    expectIntegrityViolation(withReport({ runId: 'run-other' }), /report\.runId must equal the run ID/)
    expectIntegrityViolation(
      withReport({ initialMapRevision: canonicalJsonDigest({ no: 1 }) }),
      /initialMapRevision must equal the preflight revision/,
    )
  })

  it('requires a blocked report to list every parked ticket', () => {
    expectIntegrityViolation(
      stateWith((s) => {
        s.status = 'terminal'
        s.tickets.I_A = { phase: 'parked', wave: 1, outcome: { kind: 'blocked', code: 'c', reason: 'r', evidence: [] } }
        s.parkedTickets = [ticketRef('I_A', 7)]
        s.report = {
          label: 'blocked', code: 'changed-input', runId: 'run-1',
          initialMapRevision: s.acceptedMapRevisions[0]!.revision,
          finalMapRevision: s.acceptedMapRevisions[0]!.revision,
          acceptedExtensions: [], tickets: [], sharedWrite: 'none', warnings: [],
        }
      }),
      /report must list parked ticket "I_A"/,
    )
  })

  it('rejects a map completion workspace that does not carry the attempt ID', () => {
    expectIntegrityViolation(
      stateWith((s) => {
        const mapRevision = s.acceptedMapRevisions[0]!.revision
        const completionSha = 'sha1:' + '5'.repeat(40)
        const treeOid = 'sha1:' + '6'.repeat(40)
        s.mapCompletion = {
          stage: 'gated',
          completionAttemptId: 'mc-1',
          timelineAnchor: {
            kind: 'prefix',
            timelineLength: 0,
            prefixDigest: canonicalJsonDigest([]),
          },
          workspace: {
            kind: 'map-completion',
            repositoryId: REPOSITORY_ID,
            runId: 'run-1',
            path: '/norn/runs/run-1/workspaces/map/mc-other',
            completionAttemptId: 'mc-other',
          },
          mapRevision,
          completionSha,
          treeOid,
          gate: {
            worker: { provider: 'provider-a', model: 'provider-a/model-x', family: 'provider-a', thinking: 'medium' },
            reviewer: { provider: 'provider-b', model: 'provider-b/model-y', family: 'provider-b', thinking: 'high' },
            tests: [{ argv: ['npm', 'test'], timeoutMs: 120_000 }],
          },
          tests: [
            {
              phase: 'map-completion',
              testIndex: 0,
              argv: ['npm', 'test'],
              timeoutMs: 120_000,
              baseSha: completionSha,
              treeOid,
              exitCode: 0,
              outputDigest: canonicalJsonDigest({ out: 'ok' }),
            },
          ],
          review: {
            phase: 'map-completion',
            provider: 'provider-b',
            model: 'provider-b/model-y',
            family: 'provider-b',
            thinking: 'high',
            verdict: 'pass',
            mapRevision,
            completionSha,
            treeOid,
            testEvidenceDigest: canonicalJsonDigest([{ a: 1 }] as never),
          },
        }
      }),
      /workspace must carry the completion attempt ID/,
    )
  })
})

describe('run state integrity: the in-run conflict rework ledger', () => {
  const conflict = {
    code: 'integration-conflict',
    reason: 'the candidate for ticket #2 conflicts when replayed onto the advanced target',
    evidence: [{ conflictedPaths: ['shared.txt'], baseSha: 'sha1:' + '3'.repeat(40) }],
  }

  it('accepts a rework entry for a known ticket', () => {
    const outcome = checkRunStateIntegrity(
      stateWith((s) => {
        s.tickets.I_A = { phase: 'waiting', wave: 1 }
        s.reworks = { I_A: { cycles: 1, conflict } }
      }),
    )
    assert.ok(outcome.kind === 'ok', outcome.kind === 'error' ? outcome.reason : '')
  })

  it('rejects a ledger entry for an unknown ticket', () => {
    expectIntegrityViolation(
      stateWith((s) => { s.reworks = { I_ghost: { cycles: 1, conflict } } }),
      /reworks references unknown ticket "I_ghost"/,
    )
  })

  it('rejects a cycle count below one and malformed conflicts', () => {
    expectIntegrityViolation(
      stateWith((s) => { s.reworks = { I_A: { cycles: 0, conflict } } }),
      /reworks\[I_A\]\.cycles must be an integer >= 1/,
    )
    expectIntegrityViolation(
      stateWith((s) => { s.reworks = { I_A: { cycles: 1, conflict: { ...conflict, code: '' } } } }),
      /reworks\[I_A\]\.conflict\.code must be a non-empty string/,
    )
    expectIntegrityViolation(
      stateWith((s) => {
        s.reworks = { I_A: { cycles: 1, conflict: { ...conflict, evidence: [{ bad: undefined }] } } }
      }),
      /reworks\[I_A\]\.conflict\.evidence must be serializable machine data/,
    )
  })

  it('rejects unknown ledger fields', () => {
    expectIntegrityViolation(
      stateWith((s) => { s.reworks = { I_A: { cycles: 1, conflict, extra: true } } }),
      /reworks\[I_A\] has unknown field "extra"/,
    )
  })
})

describe('crash safety: killing a writer never leaves a torn document', () => {
  it('a SIGKILLed writer leaves the previous or complete new document', { timeout: 180_000 }, async () => {
    const home = tempHome()
    const childPath = new URL('./fixtures/run-state-writer-child.ts', import.meta.url).pathname
    let sawPrevious = false
    try {
      for (let iteration = 0; iteration < 12; iteration++) {
        const child = spawn(process.execPath, [childPath, home, 'I_map'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const exited = new Promise<void>((resolvePromise) => {
          child.once('exit', () => resolvePromise())
          if (child.exitCode !== null || child.signalCode !== null) resolvePromise()
        })
        let output = ''
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          output += chunk
        })
        let stderr = ''
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk
        })
        await new Promise<void>((resolvePromise) => {
          const poll = setInterval(() => {
            if (output.includes('v1-written')) {
              clearInterval(poll)
              resolvePromise()
            }
          }, 5)
          exited.then(() => {
            clearInterval(poll)
            resolvePromise()
          })
        })
        // Kill at a random point inside the second (multi-megabyte) write
        // window: during the temporary-file write, the fsync, or the rename.
        await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.floor(Math.random() * 60)))
        child.kill('SIGKILL')
        await exited
        assert.equal(stderr, '')

        const loaded = loadRunState(home, 'I_map')
        assert.ok(loaded.kind === 'ok', `iteration ${iteration}: ${loaded.kind === 'error' ? loaded.reason : ''}`)
        if (loaded.kind === 'ok' && loaded.value !== undefined) {
          // Never torn: the document is either the running v1 shape or the
          // terminal v2 shape with the filler report — never a mix.
          assert.equal(loaded.value.runId, 'run-crash-test')
          if (loaded.value.report === undefined) {
            assert.equal(loaded.value.status, 'running')
            sawPrevious = true
          } else {
            assert.equal(loaded.value.status, 'terminal')
            assert.equal(loaded.value.report.label, 'blocked')
          }
        }
      }
      assert.ok(sawPrevious, 'at least one kill landed before the rename replaced the document')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
