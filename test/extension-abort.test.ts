/**
 * `/norn abort` extension wiring and rendering (ticket #16): the extension
 * stays a thin operator adapter — it builds the runner's adapters, asks for
 * the exact run ID through the typed dialog, hands everything to the abort
 * protocol, and renders the typed outcome. The abort itself runs over the
 * same deterministic five-seam harness as the protocol tests; the dialog
 * tests drive `dialogAbortInteraction` with a scripted UI.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'

import { executeAbortCommand } from '../src/extension/abort-command.ts'
import type { AbortCommandAdapters } from '../src/extension/abort-command.ts'
import { dialogAbortInteraction } from '../src/extension/interaction.ts'
import { renderAbortOutcome } from '../src/extension/render.ts'
import type { AbortOutcome } from '../src/run/abort.ts'
import type { DialogUi } from '../src/extension/interaction.ts'
import {
  ENCODED_MAP,
  MAP_URL,
  makeRunHarness,
} from './helpers/run-fixtures.ts'
import type { RunHarness } from './helpers/run-fixtures.ts'
import { saveRunState } from '../src/runstate/run-state-store.ts'
import type { ProcessGroupCheckpoint, RunState } from '../src/runstate/types.ts'

/** A scripted dialog UI recording every notify and answering inputs in order. */
function dialogUi(answers: readonly string[]): DialogUi & {
  readonly notified: { message: string; level: string }[]
  readonly inputs: { title: string; placeholder: string | undefined }[]
} {
  const notified: { message: string; level: string }[] = []
  const inputs: { title: string; placeholder: string | undefined }[] = []
  let next = 0
  return {
    notified,
    inputs,
    select: async () => undefined,
    confirm: async () => false,
    input: async (title: string, placeholder?: string) => {
      inputs.push({ title, placeholder })
      const answer = answers[next]
      next += 1
      return answer
    },
    notify(message: string, level?: string) {
      notified.push({ message, level: level ?? 'info' })
    },
  }
}

/** Build the production-shaped abort adapters over one harness world. */
function abortAdapters(harness: RunHarness): AbortCommandAdapters {
  const base = harness.deps()
  return {
    nornHome: harness.nornHome,
    git: base.git,
    gateway: base.gateway,
    loader: base.loader,
    store: base.store,
    evidence: base.evidence,
    gitFacts: base.gitFacts,
    runner: base.runner,
  }
}

/** Persist one running state with a live recorded process group. */
function craftRunning(harness: RunHarness): void {
  const snapshot = harness.snapshot()
  const baseSha = `sha1:${execFileSync('git', ['-C', harness.repo.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}`
  const baseTreeOid = `sha1:${execFileSync('git', ['-C', harness.repo.root, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()}`
  const ticket = snapshot.tickets[0]!
  const group: ProcessGroupCheckpoint = {
    id: 'pg-1',
    owner: 'worker',
    phase: 'work',
    workspace: {
      kind: 'ticket',
      repositoryId: snapshot.ref.repositoryId,
      runId: 'run-crafted',
      path: `${harness.repositoryHome}/runs/run-crafted/workspaces/1/wa-w1-t1`,
      branch: 'norn/run-crafted/1/wa-w1-t1',
      workAttemptId: 'wa-w1-t1',
    },
    ticketIssueId: ticket.ref.issueId,
    workAttemptId: 'wa-w1-t1',
    adapterHandle: 'fake-0',
    state: 'settled',
  }
  const state: RunState = {
    ...harness.craftRunningState([group]),
    wave: 1,
  }
  const saved = saveRunState(harness.repositoryHome, ENCODED_MAP, state)
  assert.equal(saved.kind, 'ok')
}

describe('executeAbortCommand — the typed dialog over the abort protocol', () => {
  it('renders the persisted-facts summary, then a mismatched typed run ID aborts nothing', async () => {
    const harness = await makeRunHarness({ label: 'ext-abort-mismatch', members: [{ issueId: 'I_A', number: 1 }] })
    try {
      craftRunning(harness)
      const ui = dialogUi(['run-not-this'])
      await executeAbortCommand(
        { cwd: harness.repo.root, ui },
        MAP_URL,
        abortAdapters(harness),
      )

      // The dialog notified the persisted facts first, then asked for the
      // exact run ID with the run ID as the placeholder.
      assert.equal(ui.inputs.length, 1)
      assert.match(ui.inputs[0]!.title, /run-crafted/)
      assert.equal(ui.inputs[0]!.placeholder, 'run-crafted')
      assert.match(ui.notified[0]!.message, /State: running/)
      assert.match(ui.notified[0]!.message, /never removes remote/)

      // One rendered outcome follows the summary: the mismatch, as a warning.
      const outcomes = ui.notified.filter((entry) => entry.message.startsWith('Norn abort blocked'))
      assert.equal(outcomes.length, 1)
      assert.equal(outcomes[0]!.level, 'warning')
      assert.match(outcomes[0]!.message, /Norn abort blocked \(run-id-mismatch\)/)
      assert.equal(harness.runState()!.status, 'running')
    } finally {
      harness.cleanup()
    }
  })

  it('runs the full protocol after a correct confirmation and renders the aborted decision', async () => {
    const harness = await makeRunHarness({ label: 'ext-abort-confirmed', members: [{ issueId: 'I_A', number: 1 }] })
    try {
      craftRunning(harness)
      const ui = dialogUi(['run-crafted'])
      await executeAbortCommand(
        { cwd: harness.repo.root, ui },
        MAP_URL,
        abortAdapters(harness),
      )

      // The last notification is the rendered outcome (the dialog summary
      // was notified first, before the input).
      const rendered = ui.notified.at(-1)!
      assert.ok(rendered.message.includes('is recorded aborted'), 'the aborted decision was rendered')
      assert.equal(rendered.level, 'info')
      assert.match(rendered.message, /run-crafted is recorded aborted/)
      assert.match(rendered.message, /Settled process groups: 0/)
      assert.match(rendered.message, /never reuses this run's unshipped Work/)
      assert.equal(harness.runState()!.status, 'aborted')
    } finally {
      harness.cleanup()
    }
  })

  it('treats a cancelled or empty typed answer as an unconfirmed abort', async () => {
    const harness = await makeRunHarness({ label: 'ext-abort-cancel', members: [{ issueId: 'I_A', number: 1 }] })
    try {
      craftRunning(harness)
      const ui = dialogUi([''])
      await executeAbortCommand(
        { cwd: harness.repo.root, ui },
        MAP_URL,
        abortAdapters(harness),
      )
      const outcomes = ui.notified.filter((entry) => entry.message.startsWith('Norn abort blocked'))
      assert.equal(outcomes.length, 1)
      assert.match(outcomes[0]!.message, /Norn abort blocked \(unconfirmed-run-id\)/)
      assert.equal(harness.runState()!.status, 'running')
    } finally {
      harness.cleanup()
    }
  })
})

describe('dialogAbortInteraction', () => {
  it('returns the typed answer unchanged; the runner decides what matches', async () => {
    const ui = dialogUi(['  run-x  '])
    const interaction = dialogAbortInteraction(ui)
    const answer = await interaction.confirmRunId({
      runId: 'run-1',
      status: 'running',
      mapUrl: MAP_URL,
      wave: 2,
      parkedTickets: [4],
      pendingSharedWrite: true,
    })
    assert.equal(answer, '  run-x  ')
    assert.match(ui.notified[0]!.message, /run-1/)
    assert.match(ui.notified[0]!.message, /Parked tickets: 4/)
    assert.match(ui.notified[0]!.message, /already proves at least one/)
  })
})

describe('renderAbortOutcome', () => {
  it('renders the aborted decision with its confirmed writes', () => {
    const outcome: AbortOutcome = {
      kind: 'ok',
      value: {
        kind: 'aborted',
        runId: 'run-1',
        sharedWrite: 'confirmed',
        settledProcessGroupIds: ['pg-1'],
        releasedSlots: ['wa-1'],
        confirmedWrites: [
          {
            kind: 'integration',
            ticketIssueId: 'I_A',
            stage: 'push-verified',
            integratedSha: 'sha1:' + '1'.repeat(40),
            provenBy: 'persisted-checkpoint',
          },
        ],
        warnings: [],
      },
    }
    const rendered = renderAbortOutcome(outcome)
    assert.match(rendered, /recorded aborted/)
    assert.match(rendered, /Settled process groups: 1 · released Work slots: 1/)
    assert.match(rendered, /sharedWrite: confirmed/)
    assert.match(rendered, /integration: ticket I_A · push-verified/)
  })

  it('renders an ambiguous failure as recoverable and refusing a new run', () => {
    const outcome: AbortOutcome = {
      kind: 'error',
      scope: 'operation',
      code: 'push-unknown',
      reason: 'the remote target stayed unclassifiable',
      sharedWrite: 'unknown',
      evidence: [],
    }
    const rendered = renderAbortOutcome(outcome)
    assert.match(rendered, /Norn abort error \(push-unknown\)/)
    assert.match(rendered, /remains "running" and recoverable/)
    assert.match(rendered, /a new run cannot start from ambiguous state/)
  })

  it('renders the passed precedence and plain blocks', () => {
    const passed: AbortOutcome = {
      kind: 'ok',
      value: {
        kind: 'passed',
        runId: 'run-1',
        report: {
          label: 'passed',
          runId: 'run-1',
          initialMapRevision: 'sha256:' + '1'.repeat(64),
          finalMapRevision: 'sha256:' + '1'.repeat(64),
          acceptedExtensions: [],
          tickets: [],
          sharedWrite: 'confirmed',
          warnings: [],
          completionSha: 'sha1:' + '2'.repeat(40),
        },
      },
    }
    assert.match(renderAbortOutcome(passed), /finalized map completion wins/)

    const blocked: AbortOutcome = {
      kind: 'blocked',
      scope: 'operation',
      code: 'no-run',
      reason: 'nothing to abort',
      sharedWrite: 'none',
      evidence: [],
    }
    assert.match(renderAbortOutcome(blocked), /Norn abort blocked \(no-run\)/)
  })
})
