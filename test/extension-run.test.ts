/**
 * `/norn run` extension wiring and routing (ticket #13): the extension stays
 * a thin operator adapter — it hands the map URL and the built-in adapters
 * to the coordinator and renders the typed outcome. The full lifecycle runs
 * over the same deterministic five-seam harness as the lifecycle tests; the
 * routing tests drive the registered extension command directly.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import nornExtension from '../src/extension/index.ts'
import { executeRunCommand } from '../src/extension/run-command.ts'
import { productionLaunchPlans } from '../src/extension/run-command.ts'
import { renderRunOutcome } from '../src/extension/render.ts'
import type { RunMapOutcome } from '../src/run/lifecycle.ts'
import { makeRunHarness } from './helpers/run-fixtures.ts'
import type { DialogUi } from '../src/extension/interaction.ts'

type RegisteredCommand = {
  name: string
  def: {
    description?: string
    handler: (args: string, ctx: unknown) => Promise<void>
  }
}

function fakePi() {
  const commands: RegisteredCommand[] = []
  return {
    commands,
    registerCommand(name: string, def: RegisteredCommand['def']) {
      commands.push({ name, def })
    },
  }
}

function fakeCtx(hasUI: boolean) {
  const notifications: { message: string; level: string }[] = []
  return {
    notifications,
    ctx: {
      hasUI,
      cwd: '/nowhere',
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level })
        },
      },
      modelRegistry: {},
    },
  }
}

function registeredNorn() {
  const pi = fakePi()
  nornExtension(pi as never)
  return pi
}

/** A notify-only dialog UI recording every rendered message. */
const ui = (): Pick<DialogUi, 'notify'> & { messages: { message: string; level: string }[] } => {
  const messages: { message: string; level: string }[] = []
  return {
    messages,
    notify(message: string, level?: string) {
      messages.push({ message, level: level ?? 'info' })
    },
  }
}

describe('executeRunCommand — rendering the typed outcome', () => {
  it('renders the passed RunReport for the operator', async () => {
    const harness = await makeRunHarness({
      label: 'ext-pass',
      members: [{ issueId: 'I_A', number: 1 }],
    })
    try {
      const dialog = ui()
      await executeRunCommand(
        { cwd: harness.repo.root, ui: dialog, modelRegistry: {} as never },
        'https://github.com/acme/widget/issues/6',
        harness.deps(),
      )
      assert.equal(dialog.messages.length, 1)
      assert.equal(dialog.messages[0]!.level, 'info')
      const message = dialog.messages[0]!.message
      assert.match(message, /Norn run passed/)
      assert.match(message, /run run-1/)
      assert.match(message, /#1 \[completed\]/)
      assert.match(message, /sharedWrite: confirmed/)
    } finally {
      harness.cleanup()
    }
  })

  it('renders a blocked report as a warning listing parked and waiting tickets', async () => {
    const harness = await makeRunHarness({
      label: 'ext-blocked',
      members: [
        { issueId: 'I_A', number: 1, worker: { kind: 'block' } },
        { issueId: 'I_C', number: 3, blockers: ['I_A'] },
      ],
    })
    try {
      const dialog = ui()
      await executeRunCommand(
        { cwd: harness.repo.root, ui: dialog, modelRegistry: {} as never },
        'https://github.com/acme/widget/issues/6',
        harness.deps(),
      )
      assert.equal(dialog.messages.length, 1)
      assert.equal(dialog.messages[0]!.level, 'warning')
      const message = dialog.messages[0]!.message
      assert.match(message, /Norn run blocked \(no-eligible-frontier\)/)
      assert.match(message, /#1 \[parked \(worker-block\)\]/)
      assert.match(message, /#3 \[waiting\]/)
    } finally {
      harness.cleanup()
    }
  })
})

describe('renderRunOutcome', () => {
  it('reports a recoverable shared-write error as running and resumable', () => {
    const outcome: RunMapOutcome = {
      kind: 'error',
      scope: 'run',
      code: 'comment-write',
      reason: 'the comment write returned an unknown result',
      sharedWrite: 'unknown',
      evidence: [],
    }
    const rendered = renderRunOutcome(outcome)
    assert.match(rendered, /Norn run error \(comment-write\)/)
    assert.match(rendered, /remains "running" and resumable/)
  })
})

describe('/norn run routing in the registered extension', () => {
  it('warns when the map URL is missing or contains whitespace', async () => {
    const pi = registeredNorn()
    const missing = fakeCtx(true)
    await pi.commands[0]!.def.handler('run', missing.ctx)
    assert.equal(missing.notifications.length, 1)
    assert.match(missing.notifications[0]!.message, /\/norn run takes exactly one full GitHub issue URL/)

    const spaced = fakeCtx(true)
    await pi.commands[0]!.def.handler('run   https://github.com/acme/widget/issues/6 extra', spaced.ctx)
    assert.equal(spaced.notifications.length, 1)
    assert.match(spaced.notifications[0]!.message, /takes exactly one full GitHub issue URL/)
  })

  it('still reports unimplemented subcommands as pending', async () => {
    const pi = registeredNorn()
    const pending = fakeCtx(true)
    await pi.commands[0]!.def.handler('abort https://github.com/acme/widget/issues/6', pending.ctx)
    assert.equal(pending.notifications.length, 1)
    assert.match(pending.notifications[0]!.message, /not implemented yet/)
  })
})

describe('productionLaunchPlans', () => {
  it('builds read-only reviewer plans and lockstep ship invocation IDs', () => {
    const plans = productionLaunchPlans()
    const workerPlan = plans.planWorkerFor('wa-w1-t1', {
      model: 'provider-a/model-x',
      thinking: 'medium',
      timeoutMs: 1_000,
    })({ round: 1, previousCandidateCommit: null, feedback: [] })
    assert.match(workerPlan.argv.join(' '), /pi --model provider-a\/model-x/)
    assert.match(workerPlan.argv.join(' '), /--session-id wa-w1-t1-worker-r1-pi/)

    const reviewerInput: Parameters<ReturnType<typeof plans.planWorkReviewerFor>>[0] = {
      spec: {
        mapTitle: 'M',
        mapBody: '',
        mapRevision: 'sha256:' + '0'.repeat(64),
        ticketTitle: 'T',
        ticketBody: '',
        ticketRevision: 'sha256:' + '1'.repeat(64),
      },
      target: {
        branch: 'main',
        baseSha: 'sha1:' + '2'.repeat(40),
        baseTreeOid: 'sha1:' + '3'.repeat(40),
      },
      candidate: {
        commit: 'sha1:' + '4'.repeat(40),
        treeOid: 'sha1:' + '5'.repeat(40),
        zeroDelta: false,
      },
      diff: '',
      tests: [],
      testOutput: [],
    }
    const reviewerPlan = plans.planWorkReviewerFor('wa-w1-t1', {
      model: 'provider-b/model-y',
      thinking: 'high',
      timeoutMs: 1_000,
      family: 'provider-b',
    })(reviewerInput)
    const joined = reviewerPlan.argv.join(' ')
    assert.match(joined, /--tools read,grep,find,ls,norn_complete/)
    assert.doesNotMatch(joined, /bash/)
    assert.match(joined, /--session-id wa-w1-t1-reviewer-r1-pi/)

    const shipPlan = plans.planShipReviewer({
      model: 'provider-b/model-y',
      thinking: 'high',
      timeoutMs: 1_000,
      family: 'provider-b',
    })(reviewerInput)
    assert.match(shipPlan.argv.join(' '), /--session-id ship-rev-1-pi/)
    assert.equal(plans.newShipInvocationId(), 'ship-rev-1')
  })
})
