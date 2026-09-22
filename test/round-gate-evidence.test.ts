/**
 * Round-gate evidence integrity (design.md §10.3, ticket #9): the independent
 * seal check, evidence freshness across rounds, the read-only reviewer
 * planning policy, and the production Run-State attempt store with the
 * production Work-slot seam — end to end, over a real repository and a real
 * `run-state.json` document that must survive its own integrity validator.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { canonicalJsonDigest } from '../src/core/digest.ts'
import { computeMapRevision, computeTicketRevision } from '../src/core/revision.ts'
import type { RunState, ShippableChange, TestEvidence } from '../src/runstate/types.ts'
import { loadRunState, saveRunState } from '../src/runstate/run-state-store.ts'
import { readWorkSlotRegistry } from '../src/runstate/slot-registry.ts'
import {
  REVIEWER_READ_ONLY_TOOLS,
  isReadOnlyAgentArgv,
  modelProvider,
  piReadOnlyReviewerLaunch,
  piWorkerLaunch,
  runStateWorkAttemptStore,
  runWorkAttempt,
  verifySealedChange,
  workAttemptReservation,
  workSlotSeam,
  completionsDirFor,
} from '../src/work/round-gate.ts'
import type { ReviewerLaunchInput, SealCheckFacts } from '../src/work/round-gate.ts'

import {
  commitInWorkspace,
  committingWorker,
  makeHarness,
  passDigest,
  readWorkspaceOids,
} from './helpers/round-gate-fixtures.ts'
import type { Harness, ReviewerScript, WorkerScript } from './helpers/round-gate-fixtures.ts'

/** A reviewer that iterates on its first call and passes afterwards. */
function iterateThenPass(): ReviewerScript {
  return ({ call }) =>
    call === 0
      ? { discriminant: 'iterate', feedback: 'tighten the failure path' }
      : { discriminant: 'pass' }
}

/** The independently established seal facts of a finished harness. */
function sealFacts(harness: Harness, change: ShippableChange): SealCheckFacts {
  const oids = readWorkspaceOids(harness.workspacePath)
  assert.equal(oids.commit, change.candidateCommit, 'the workspace still holds the candidate')
  return {
    input: harness.input,
    workspace: workspaceRefOf(harness),
    head: oids.commit,
    treeOid: oids.treeOid,
    configuredTests: harness.params.tests,
    reviewer: {
      provider: 'provider-b',
      model: 'provider-b/model-y',
      family: 'provider-b',
      thinking: 'high',
    },
  }
}

describe('the independent seal check', () => {
  it('proves a gate-sealed change against independent reads', async () => {
    const harness = makeHarness({ label: 'seal-check', worker: committingWorker(), reviewer: () => ({ discriminant: 'pass' }) })
    try {
      const outcome = await harness.run()
      assert.ok(outcome.kind === 'ok')
      assert.deepEqual(verifySealedChange(outcome.value, sealFacts(harness, outcome.value)), [])
    } finally {
      harness.cleanup()
    }
  })

  it('catches every evidence-binding violation', async () => {
    const harness = makeHarness({
      label: 'seal-tamper',
      worker: committingWorker(),
      reviewer: () => ({ discriminant: 'pass' }),
      tests: [
        { argv: ['npm', 'test'], timeoutMs: 60_000 },
        { argv: ['npm', 'run', 'lint'], timeoutMs: 30_000 },
      ],
    })
    try {
      const outcome = await harness.run()
      assert.ok(outcome.kind === 'ok')
      const sealed = outcome.value
      assert.equal(sealed.tests.length, 2)
      const facts = sealFacts(harness, sealed)

      const tamperedTree: ShippableChange = {
        ...sealed,
        tests: sealed.tests.map((entry, index) =>
          index === 1 ? { ...entry, treeOid: 'sha1:' + '9'.repeat(40) } : entry,
        ),
      }
      assert.match(verifySealedChange(tamperedTree, facts).join('; '), /complete sealed candidate tree/)

      const tamperedArgv: ShippableChange = {
        ...sealed,
        tests: sealed.tests.map((entry, index) =>
          index === 0 ? { ...entry, argv: ['npm', 'test', '--changed'] } : entry,
        ),
      }
      assert.match(verifySealedChange(tamperedArgv, facts).join('; '), /argv must equal the configured test/)

      const missingTest: ShippableChange = { ...sealed, tests: sealed.tests.slice(0, 1) }
      assert.match(verifySealedChange(missingTest, facts).join('; '), /exactly one entry per configured test/)

      const tamperedDigest: ShippableChange = {
        ...sealed,
        review: { ...sealed.review, testEvidenceDigest: 'sha256:' + '0'.repeat(64) },
      }
      assert.match(verifySealedChange(tamperedDigest, facts).join('; '), /digest of the ordered sealed test evidence/)

      const tamperedReviewRevision: ShippableChange = {
        ...sealed,
        review: { ...sealed.review, ticketRevision: 'sha256:' + '3'.repeat(64) },
      }
      assert.match(
        verifySealedChange(tamperedReviewRevision, facts).join('; '),
        /review must bind the sealed ticket revision/,
      )

      const tamperedCommit: ShippableChange = {
        ...sealed,
        candidateCommit: 'sha1:' + '7'.repeat(40),
      }
      assert.match(verifySealedChange(tamperedCommit, facts).join('; '), /independently read HEAD/)

      const tamperedIdentity: ShippableChange = {
        ...sealed,
        review: { ...sealed.review, model: 'provider-c/model-z' },
      }
      assert.match(verifySealedChange(tamperedIdentity, facts).join('; '), /configured reviewer identity/)

      const tamperedWorkspace: ShippableChange = {
        ...sealed,
        workspace: { ...sealed.workspace, path: '/somewhere/else' },
      }
      assert.match(verifySealedChange(tamperedWorkspace, facts).join('; '), /attempt-owned workspace/)

      const tamperedMapRevision: ShippableChange = {
        ...sealed,
        mapRevision: 'sha256:' + '4'.repeat(64),
      }
      assert.match(verifySealedChange(tamperedMapRevision, facts).join('; '), /map revision must equal the Work input/)
    } finally {
      harness.cleanup()
    }
  })
})

describe('evidence freshness across rounds', () => {
  it('seals only the final round\'s test and review evidence', async () => {
    const harness = makeHarness({ label: 'freshness', worker: committingWorker(), reviewer: iterateThenPass() })
    try {
      const outcome = await harness.run()
      assert.ok(outcome.kind === 'ok')
      const sealed = outcome.value
      assert.equal(harness.workerInputs.length, 2)

      // Round 1's tests captured pass-0; round 2's captured pass-1. Only the
      // later outputs survive into the sealed evidence.
      assert.equal(sealed.tests.length, 1)
      assert.equal(sealed.tests[0]!.outputDigest, passDigest(1))
      assert.notEqual(sealed.tests[0]!.outputDigest, passDigest(0))

      // Each reviewer judged exactly its own round's tree and evidence.
      const roundOneTree = harness.reviewerInputs[0]!.candidate.treeOid
      const roundTwoTree = harness.reviewerInputs[1]!.candidate.treeOid
      assert.notEqual(roundOneTree, roundTwoTree)
      assert.equal(harness.reviewerInputs[0]!.tests[0]!.treeOid, roundOneTree)
      assert.equal(harness.reviewerInputs[1]!.tests[0]!.treeOid, roundTwoTree)
      assert.equal(harness.reviewerInputs[1]!.tests.length, 1)

      // The sealed review binds the final tree and exactly the sealed list.
      assert.equal(sealed.candidateTreeOid, roundTwoTree)
      assert.equal(sealed.review.treeOid, roundTwoTree)
      assert.equal(sealed.review.testEvidenceDigest, digestOf(sealed.tests))
      assert.notEqual(sealed.review.testEvidenceDigest, digestOf(harness.reviewerInputs[0]!.tests))

      // And the seal check still proves it.
      assert.deepEqual(verifySealedChange(sealed, sealFacts(harness, sealed)), [])
    } finally {
      harness.cleanup()
    }
  })

  it('binds every reviewer input to the base and the round candidate', async () => {
    const harness = makeHarness({ label: 'reviewer-input', worker: committingWorker(), reviewer: () => ({ discriminant: 'pass' }) })
    try {
      const outcome = await harness.run()
      assert.ok(outcome.kind === 'ok')
      const input = harness.reviewerInputs[0]!
      assert.equal(input.spec.mapRevision, harness.input.spec.mapRevision)
      assert.equal(input.spec.ticketRevision, harness.input.spec.ticketRevision)
      assert.equal(input.target.baseSha, harness.input.target.baseSha)
      assert.equal(input.candidate.commit, outcome.value.candidateCommit)
      assert.equal(input.testOutput[0]!.testIndex, 0)
      assert.equal(input.testOutput[0]!.outputDigest, passDigest(0))
      assert.match(input.diff, /work-1\.txt/)
    } finally {
      harness.cleanup()
    }
  })
})

describe('the read-only reviewer launch policy', () => {
  const reviewerInput: ReviewerLaunchInput = {
    spec: {
      mapTitle: 'm',
      mapBody: 'b',
      mapRevision: 'sha256:' + '1'.repeat(64),
      ticketTitle: 't',
      ticketBody: 'tb',
      ticketRevision: 'sha256:' + '2'.repeat(64),
    },
    target: { branch: 'main', baseSha: 'sha1:' + '1'.repeat(40), baseTreeOid: 'sha1:' + '2'.repeat(40) },
    candidate: {
      commit: 'sha1:' + '3'.repeat(40),
      treeOid: 'sha1:' + '4'.repeat(40),
      zeroDelta: false,
    },
    diff: '',
    tests: [],
    testOutput: [],
  }

  it('plans a reviewer with the strict read-only capability set', () => {
    const plan = piReadOnlyReviewerLaunch(reviewerInput, {
      model: 'provider-b/model-y',
      thinking: 'high',
      extensionPath: '/norn/extension.ts',
      piSessionId: 'pi-1',
    })
    // `--no-builtin-tools` removes every write-capable built-in at the CLI
    // and cannot be resolved away by startup ordering; the completion
    // extension then registers exactly the read-only allowlist.
    assert.equal(plan.argv.includes('--no-builtin-tools'), true)
    assert.equal(plan.argv.includes('--tools'), false)
    assert.deepEqual(REVIEWER_READ_ONLY_TOOLS, ['read', 'grep', 'find', 'ls', 'norn_complete'])
    assert.equal(isReadOnlyAgentArgv(plan.argv), true)
    for (const tool of ['bash', 'powershell', 'edit', 'write']) {
      assert.equal(plan.argv.some((part) => part.includes(tool)), false, `no ${tool} anywhere`)
    }
  })

  it('tells the reviewer when it is judging a zero-delta assertion', () => {
    const zero: ReviewerLaunchInput = { ...reviewerInput, candidate: { ...reviewerInput.candidate, zeroDelta: true } }
    const plan = piReadOnlyReviewerLaunch(zero, {
      model: 'provider-b/model-y',
      thinking: 'high',
      extensionPath: '/norn/extension.ts',
      piSessionId: 'pi-1',
    })
    const prompt = plan.argv.at(-1)!
    assert.match(prompt, /zero-delta/)
  })

  it('rejects argv without a read-only allowlist', () => {
    assert.equal(isReadOnlyAgentArgv(['pi', '--tools', 'bash,edit,write,norn_complete']), false)
    assert.equal(isReadOnlyAgentArgv(['pi', '--model', 'm']), false)
    assert.equal(isReadOnlyAgentArgv(['pi', '--tools', 'read,grep,find,ls']), false)
    assert.equal(isReadOnlyAgentArgv(['pi', '--tools', '']), false)
  })

  it('renders the worker round briefing into the launch prompt', () => {
    const feedback = [
      { kind: 'review' as const, round: 1, feedback: 'tighten' },
    ]
    const withinRun = piWorkerLaunch(
      { round: 2, previousCandidateCommit: 'sha1:' + 'a'.repeat(40), feedback },
      { model: 'provider-a/model-x', thinking: 'medium', extensionPath: '/norn/extension.ts', piSessionId: 'pi-2' },
    )
    const withinRunPrompt = withinRun.argv.at(-1)!.toString()
    assert.match(withinRunPrompt, /norn-worker-brief:v1/)
    assert.match(withinRunPrompt, /tighten/)
    assert.doesNotMatch(withinRunPrompt, /carried from a previous run/)

    const carried = piWorkerLaunch(
      {
        round: 1,
        previousCandidateCommit: null,
        feedback: [
          ...feedback,
          { kind: 'terminal', outcome: 'blocked', code: 'work-rounds-exhausted', reason: 'three cold rounds' },
        ],
      },
      { model: 'provider-a/model-x', thinking: 'medium', extensionPath: '/norn/extension.ts', piSessionId: 'pi-3' },
    )
    const carriedPrompt = carried.argv.at(-1)!.toString()
    assert.match(carriedPrompt, /carried from a previous run's parked attempt/)
    assert.match(carriedPrompt, /work-rounds-exhausted/)
    assert.match(carriedPrompt, /three cold rounds/)
  })
})

describe('the production Run-State attempt store and slot seam', () => {
  function productionRunState(): RunState {
    const mapRevision = computeMapRevision({
      githubHost: 'github.com',
      repositoryId: 'R_1',
      mapIssueId: 'I_map',
      title: 'The map',
      body: 'Shared intent.',
      members: [{ ticketIssueId: 'I_7', ticketRevision: ticketRevisionOf('I_7') }],
      dependencies: [],
    })
    return {
      schema: 'norn-run-state:v1',
      runId: 'run-9',
      map: {
        role: 'map',
        githubHost: 'github.com',
        repositoryId: 'R_1',
        issueId: 'I_map',
        number: 6,
        url: 'https://github.com/iefnaf/norn/issues/6',
      },
      acceptedMapRevisions: [{ revision: mapRevision.revision, payload: mapRevision.payload }],
      configRevision: canonicalJsonDigest({ config: 1 }),
      nornVersion: '0.1.0',
      status: 'running',
      wave: 1,
      parkedTickets: [],
      tickets: {},
      activeProcesses: [],
    }
  }

  function ticketRevisionOf(issueId: string): string {
    return computeTicketRevision({
      githubHost: 'github.com',
      repositoryId: 'R_1',
      ticketIssueId: issueId,
      title: 'Ticket 7',
      body: 'Do the thing.',
    }).revision
  }

  /** Bind a harness input to the real revisions of the fixture map. */
  function boundInput(harness: Harness) {
    const input = harness.input
    return {
      ...input,
      spec: {
        ...input.spec,
        mapRevision: productionRunState().acceptedMapRevisions[0]!.revision,
        ticketRevision: ticketRevisionOf(input.ticket.issueId),
      },
    }
  }

  it('persists round, launch intent, and the sealed change into run-state.json', async () => {
    const observed: string[] = []
    let launchHome = ''
    const worker: WorkerScript = (launch, tools) => {
      // The persisted document must already carry this round and the launch
      // intent before the process existed (read through the real loader).
      const state = loadRunState(launchHome, 'I_map')
      assert.ok(state.kind === 'ok' && state.value !== undefined)
      const ticket = state.value.tickets['I_7']
      assert.ok(ticket?.phase === 'working')
      assert.equal(ticket.attempt.round, launch.round, 'the round was persisted before launch')
      const intent = ticket.attempt.processGroupIds.map((id) =>
        state.value!.activeProcesses.find((group) => group.id === id),
      )
      assert.ok(intent.every((group) => group !== undefined))
      assert.ok(intent.some((group) => group?.state === 'launch-intent'))
      observed.push(`round-${launch.round}-intent-persisted`)
      return committingWorker()(launch, tools)
    }

    const harness = makeHarness({ label: 'production-store', worker, reviewer: () => ({ discriminant: 'pass' }) })
    launchHome = harness.repositoryHome
    try {
      const state = productionRunState()
      const saved = saveRunState(harness.repositoryHome, 'I_map', state)
      assert.ok(saved.kind === 'ok', saved.kind === 'error' ? saved.reason : '')

      const deps = {
        ...harness.deps,
        store: runStateWorkAttemptStore({
          repositoryHome: harness.repositoryHome,
          encodedMapIssueId: 'I_map',
          ticketIssueId: 'I_7',
          wave: 1,
        }),
        slots: workSlotSeam({
          repositoryHome: harness.repositoryHome,
          reservation: workAttemptReservation({
            runId: 'run-9',
            mapIssueId: 'I_map',
            workAttemptId: 'wa-1',
          }),
          capacity: 1,
        }),
      }
      const outcome = await runWorkAttempt(deps, { ...harness.params, input: boundInput(harness) })
      assert.ok(outcome.kind === 'ok', JSON.stringify(outcome))
      assert.deepEqual(observed, ['round-1-intent-persisted'])

      const reloaded = loadRunState(harness.repositoryHome, 'I_map')
      assert.ok(reloaded.kind === 'ok' && reloaded.value !== undefined)
      const ticket = reloaded.value.tickets['I_7']
      assert.ok(ticket?.phase === 'shippable')
      assert.deepEqual(ticket.change, outcome.value)
      assert.equal(reloaded.value.activeProcesses.length, 0, 'settled process groups are dropped')
      assert.deepEqual(reloaded.value.parkedTickets, [])

      // The production slot seam released the reservation.
      const registry = readWorkSlotRegistry(harness.repositoryHome)
      assert.ok(registry.kind === 'ok')
      assert.deepEqual(registry.value?.reserved ?? [], [])
    } finally {
      harness.cleanup()
    }
  })

  it('parks a blocked ticket in run-state.json with its workspace retained', async () => {
    const harness = makeHarness({
      label: 'production-park',
      worker: () => ({ discriminant: 'block', code: 'requires-operator-decision', reason: 'ambiguous spec' }),
    })
    try {
      const state = productionRunState()
      assert.ok(saveRunState(harness.repositoryHome, 'I_map', state).kind === 'ok')
      const deps = {
        ...harness.deps,
        store: runStateWorkAttemptStore({
          repositoryHome: harness.repositoryHome,
          encodedMapIssueId: 'I_map',
          ticketIssueId: 'I_7',
          wave: 1,
        }),
      }
      const outcome = await runWorkAttempt(deps, { ...harness.params, input: boundInput(harness) })
      assert.ok(outcome.kind === 'blocked')
      assert.equal(outcome.code, 'worker-block')

      const reloaded = loadRunState(harness.repositoryHome, 'I_map')
      assert.ok(reloaded.kind === 'ok' && reloaded.value !== undefined)
      const ticket = reloaded.value.tickets['I_7']
      assert.ok(ticket?.phase === 'parked')
      assert.equal(ticket.outcome.code, 'worker-block')
      assert.equal(ticket.workspace?.path, harness.workspacePath)
      // The parked Ticket carries its accumulated feedback plus the terminal
      // entry, so a later run can carry the rework context (§10.2).
      assert.deepEqual(ticket.feedback, [
        {
          kind: 'terminal',
          outcome: 'blocked',
          code: 'worker-block',
          reason: 'the worker blocked: requires-operator-decision',
        },
      ])
      assert.deepEqual(
        reloaded.value.parkedTickets.map((ref) => ref.issueId),
        ['I_7'],
      )
    } finally {
      harness.cleanup()
    }
  })
})

describe('small production helpers', () => {
  it('derives provider, reservation identity, and the completions area', () => {
    assert.equal(modelProvider('provider-b/model-y'), 'provider-b')
    assert.equal(modelProvider('bare-model'), 'bare-model')
    assert.deepEqual(workAttemptReservation({ runId: 'run-9', mapIssueId: 'I_map', workAttemptId: 'wa-1' }), {
      runId: 'run-9',
      encodedMapIssueId: 'I_map',
      workAttemptId: 'wa-1',
    })
    assert.equal(
      completionsDirFor('/norn/home', 'run-9'),
      '/norn/home/runs/run-9/completions',
    )
  })
})

/** The digest of an ordered runstate-shaped test evidence list (§10.3). */
function digestOf(tests: readonly TestEvidence[]): string {
  return canonicalJsonDigest(tests as never)
}

/** The attempt-owned workspace reference of a harness. */
function workspaceRefOf(harness: Harness) {
  return {
    kind: 'ticket' as const,
    repositoryId: 'R_1',
    runId: 'run-9',
    path: harness.workspacePath,
    branch: 'norn/run-9/7/wa-1',
    workAttemptId: 'wa-1',
  }
}
