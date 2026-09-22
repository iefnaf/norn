/**
 * The completion extension agents load (design.md §17, ticket #8).
 *
 * Covers: tool registration and the terminate hint, context loading from the
 * environment, exactly-one sidecar creation through the tool body, idempotent
 * identical resubmission, rejection of a conflicting second completion,
 * rejection of completions of the wrong role, the live Pi session binding
 * check, and the #33 settlement enforcement at the Pi settle boundary.
 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { CompletionStore } from '../src/agents/completion.ts'
import nornCompletionExtension, {
  NORN_AGENT_CONTEXT_ENV,
  NORN_COMPLETE_TOOL_NAME,
  NORN_REVIEWER_TOOL_ALLOWLIST,
  NORN_SETTLEMENT_NUDGE_LIMIT,
  completionExtensionPath,
  createNornCompletionSubmitter,
  loadAgentContextFromEnv,
  settlementNudgeEntry,
} from '../src/agents/completion-extension.ts'
import { buildContext, createRunArea, defaultWorkerCandidate } from './helpers/agent-fixtures.ts'

const WORKER_CANDIDATE = { ...defaultWorkerCandidate }

type RegisteredTool = {
  name: string
  execute: (
    toolCallId: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: {
      sessionManager: { getSessionId: () => string | undefined }
      shutdown: () => void
    },
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown; terminate?: boolean }>
}

type ActiveToolsContext = { shutdown: () => void }

type BoundaryDraft = { readonly type: string; readonly customType?: string }

type BeforeSettleEvent = {
  readonly entries: BoundaryDraft[]
  readonly continue: boolean
}

type BeforeSettleResult = { readonly entries?: BoundaryDraft[]; readonly continue?: boolean }

type SettleContext = { shutdown: () => void }

function fakePi() {
  const tools: RegisteredTool[] = []
  const activeToolSets: string[][] = []
  const beforeAgentStartHandlers: Array<(event: unknown, ctx: ActiveToolsContext) => void> = []
  const beforeSettleHandlers: Array<
    (event: BeforeSettleEvent, ctx: SettleContext) => BeforeSettleResult | undefined
  > = []
  const settledHandlers: Array<(event: unknown, ctx: SettleContext) => void> = []
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.push(tool)
    },
    on(
      event: string,
      handler:
        | ((event: unknown, ctx: ActiveToolsContext) => void)
        | ((event: BeforeSettleEvent, ctx: SettleContext) => BeforeSettleResult | undefined)
        | ((event: unknown, ctx: SettleContext) => void),
    ) {
      if (event === 'before_agent_start') {
        beforeAgentStartHandlers.push(handler as (event: unknown, ctx: ActiveToolsContext) => void)
      } else if (event === 'agent_before_settle') {
        beforeSettleHandlers.push(
          handler as (event: BeforeSettleEvent, ctx: SettleContext) => BeforeSettleResult | undefined,
        )
      } else if (event === 'agent_settled') {
        settledHandlers.push(handler as (event: unknown, ctx: SettleContext) => void)
      }
      return () => undefined
    },
    getActiveTools() {
      return NORN_REVIEWER_TOOL_ALLOWLIST.filter((name) =>
        tools.some((tool) => tool.name === name),
      )
    },
    setActiveTools(toolNames: string[]) {
      activeToolSets.push([...toolNames])
    },
  }
  return {
    pi: pi as unknown as ExtensionAPI,
    tools,
    activeToolSets,
    beforeAgentStartHandlers,
    beforeSettleHandlers,
    settledHandlers,
  }
}

/** A shutdown spy standing in for the extension context's exit hook. */
function recordedShutdown(): { shutdown: () => void; calls(): number } {
  let count = 0
  return {
    shutdown: () => {
      count += 1
    },
    calls: () => count,
  }
}

function withEnv(env: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('completion extension registration', () => {
  it('registers exactly one norn_complete tool that asks Pi to stop', async () => {
    const area = await createRunArea('ext')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const { pi, tools } = fakePi()

    withEnv({ [NORN_AGENT_CONTEXT_ENV]: JSON.stringify(context) }, () => {
      nornCompletionExtension(pi)
    })

    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, NORN_COMPLETE_TOOL_NAME)

    const { shutdown, calls } = recordedShutdown()
    const result = await tools[0].execute('t1', WORKER_CANDIDATE, undefined, undefined, {
      sessionManager: { getSessionId: () => context.piSessionId },
      shutdown,
    })
    assert.equal(result.terminate, true)
    assert.match(result.content[0].text, /Norn completion written/)
    // A successful completion must shut the Pi process down: the §17
    // settlement protocol waits for the complete process group to exit.
    assert.equal(calls(), 1)
  })

  it('registers the reviewer capability set itself and re-applies it every turn', async () => {
    const area = await createRunArea('reviewer-tools')
    const context = buildContext(area, { role: 'reviewer', phase: 'work' })
    const { pi, tools, activeToolSets, beforeAgentStartHandlers } = fakePi()

    withEnv({ [NORN_AGENT_CONTEXT_ENV]: JSON.stringify(context) }, () => {
      nornCompletionExtension(pi)
    })

    // The reviewer's read-only tools come from the extension, not from Pi's
    // `--tools` allowlist, which resolves while extensions load.
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'find',
      'grep',
      'ls',
      'norn_complete',
      'read',
    ])
    assert.equal(beforeAgentStartHandlers.length, 1)
    assert.deepEqual(activeToolSets, [])

    const shutdowns: number[] = []
    beforeAgentStartHandlers[0]({}, { shutdown: () => shutdowns.push(1) })
    assert.deepEqual(activeToolSets, [[...NORN_REVIEWER_TOOL_ALLOWLIST]])
    assert.deepEqual(shutdowns, [])
  })

  it('exits rather than idling when a reviewer cannot reach norn_complete', async () => {
    const area = await createRunArea('reviewer-no-tools')
    const context = buildContext(area, { role: 'reviewer', phase: 'work' })
    const { pi, activeToolSets, beforeAgentStartHandlers } = fakePi()
    // Simulate a startup that lost the completion tool: registering it fails.
    const brokenPi = {
      registerTool(tool: RegisteredTool) {
        if (tool.name === NORN_COMPLETE_TOOL_NAME) return
        ;(pi as unknown as { registerTool: (t: RegisteredTool) => void }).registerTool(tool)
      },
      on: (pi as unknown as { on: unknown }).on,
      getActiveTools: (pi as unknown as { getActiveTools: unknown }).getActiveTools,
      setActiveTools: (pi as unknown as { setActiveTools: unknown }).setActiveTools,
    } as unknown as ExtensionAPI

    withEnv({ [NORN_AGENT_CONTEXT_ENV]: JSON.stringify(context) }, () => {
      nornCompletionExtension(brokenPi)
    })

    const shutdowns: number[] = []
    const diagnostics: string[] = []
    const originalError = console.error
    console.error = (message: string) => diagnostics.push(message)
    try {
      beforeAgentStartHandlers[0]({}, { shutdown: () => shutdowns.push(1) })
    } finally {
      console.error = originalError
    }
    assert.deepEqual(activeToolSets, [[...NORN_REVIEWER_TOOL_ALLOWLIST]])
    assert.deepEqual(shutdowns, [1])
    assert.match(diagnostics[0] ?? '', /Norn completion is unavailable/)
  })

  it('leaves a worker without reviewer-only read-only tool registrations', async () => {
    const area = await createRunArea('worker-tools')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const { pi, tools, beforeAgentStartHandlers } = fakePi()

    withEnv({ [NORN_AGENT_CONTEXT_ENV]: JSON.stringify(context) }, () => {
      nornCompletionExtension(pi)
    })

    assert.deepEqual(tools.map((tool) => tool.name), [NORN_COMPLETE_TOOL_NAME])
    assert.equal(beforeAgentStartHandlers.length, 0)
  })

  it('answers with an error when the launch context is missing', async () => {
    const { pi, tools } = fakePi()
    withEnv({ [NORN_AGENT_CONTEXT_ENV]: undefined }, () => {
      nornCompletionExtension(pi)
    })

    const { shutdown } = recordedShutdown()
    const result = await tools[0].execute('t1', WORKER_CANDIDATE, undefined, undefined, {
      sessionManager: { getSessionId: () => undefined },
      shutdown,
    })
    assert.match(result.content[0].text, /missing or invalid/)
  })

  it('exposes its own file path for pi --extension launch plans', () => {
    assert.ok(completionExtensionPath().endsWith('completion-extension.ts'))
  })
})

describe('settlement enforcement at the Pi settle boundary', () => {
  const settleEvent = (entries: BoundaryDraft[] = []): BeforeSettleEvent => ({
    entries,
    continue: false,
  })

  it('appends exactly one corrective continuation when the agent settles without completing', async () => {
    const area = await createRunArea('settle-nudge')
    const context = buildContext(area, { role: 'reviewer', phase: 'work' })
    const { pi, beforeSettleHandlers } = fakePi()

    withEnv({ [NORN_AGENT_CONTEXT_ENV]: JSON.stringify(context) }, () => {
      nornCompletionExtension(pi)
    })

    assert.equal(beforeSettleHandlers.length, 1)
    // Another extension already proposed an entry: the nudge appends after it
    // instead of replacing the boundary proposal.
    const foreign = { type: 'custom', customType: 'someone-else' }
    const result = beforeSettleHandlers[0](settleEvent([foreign]), { shutdown: () => undefined })

    assert.deepEqual(result, {
      entries: [foreign, settlementNudgeEntry(1, NORN_SETTLEMENT_NUDGE_LIMIT)],
      continue: true,
    })
    const nudge = result?.entries?.[1]
    assert.equal(nudge?.type, 'custom_message')
    assert.equal(nudge?.customType, 'norn-settlement-enforcement')
    assert.match(JSON.stringify(nudge), /norn_complete/)
  })

  it('stops nudging after the bounded attempts and lets the agent settle', async () => {
    const area = await createRunArea('settle-bounded')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const { pi, beforeSettleHandlers } = fakePi()

    withEnv({ [NORN_AGENT_CONTEXT_ENV]: JSON.stringify(context) }, () => {
      nornCompletionExtension(pi)
    })

    const results: Array<BeforeSettleResult | undefined> = []
    for (let i = 0; i <= NORN_SETTLEMENT_NUDGE_LIMIT; i += 1) {
      results.push(beforeSettleHandlers[0](settleEvent(), { shutdown: () => undefined }))
    }

    // Exactly the bounded number of nudges, each requesting one continuation
    // with a single corrective entry — then nothing, so the agent settles.
    for (const result of results.slice(0, NORN_SETTLEMENT_NUDGE_LIMIT)) {
      assert.deepEqual(result?.entries?.map((entry) => entry.customType), [
        'norn-settlement-enforcement',
      ])
      assert.equal(result?.continue, true)
    }
    assert.deepEqual(results.at(-1), undefined)
  })

  it('adds no nudge and no shutdown once norn_complete has completed the invocation', async () => {
    const area = await createRunArea('settle-completed')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const { pi, tools, beforeSettleHandlers, settledHandlers } = fakePi()

    withEnv({ [NORN_AGENT_CONTEXT_ENV]: JSON.stringify(context) }, () => {
      nornCompletionExtension(pi)
    })

    // A successful norn_complete: the sidecar is written and the process is
    // asked to shut down exactly once — by the tool itself.
    const { shutdown, calls } = recordedShutdown()
    const result = await tools[0].execute('t1', WORKER_CANDIDATE, undefined, undefined, {
      sessionManager: { getSessionId: () => context.piSessionId },
      shutdown,
    })
    assert.match(result.content[0].text, /Norn completion written/)

    assert.equal(beforeSettleHandlers[0](settleEvent(), { shutdown }), undefined)
    settledHandlers[0]({}, { shutdown })
    assert.equal(calls(), 1)
  })

  it('changes nothing without a bound Norn invocation context', () => {
    const { pi, beforeSettleHandlers, settledHandlers } = fakePi()

    withEnv({ [NORN_AGENT_CONTEXT_ENV]: undefined }, () => {
      nornCompletionExtension(pi)
    })

    assert.equal(beforeSettleHandlers[0](settleEvent(), { shutdown: () => undefined }), undefined)
    const { shutdown, calls } = recordedShutdown()
    settledHandlers[0]({}, { shutdown })
    assert.equal(calls(), 0)
  })

  it('shuts the process down when the agent settles without ever completing', async () => {
    const area = await createRunArea('settle-exit')
    const context = buildContext(area, { role: 'reviewer', phase: 'work' })
    const { pi, beforeSettleHandlers, settledHandlers } = fakePi()

    withEnv({ [NORN_AGENT_CONTEXT_ENV]: JSON.stringify(context) }, () => {
      nornCompletionExtension(pi)
    })

    // The nudges were exhausted (or ignored) and the agent still settled
    // without the typed handoff: exit instead of idling at the prompt.
    const { shutdown, calls } = recordedShutdown()
    for (let i = 0; i <= NORN_SETTLEMENT_NUDGE_LIMIT; i += 1) {
      beforeSettleHandlers[0](settleEvent(), { shutdown })
    }
    settledHandlers[0]({}, { shutdown })
    assert.equal(calls(), 1)
  })
})

describe('loadAgentContextFromEnv', () => {
  it('loads and validates the context, rejecting absent or invalid values', async () => {
    const area = await createRunArea('ext')
    const context = buildContext(area, { role: 'worker', phase: 'work' })

    assert.equal(loadAgentContextFromEnv({}), undefined)
    assert.equal(loadAgentContextFromEnv({ [NORN_AGENT_CONTEXT_ENV]: '' }), undefined)
    assert.equal(loadAgentContextFromEnv({ [NORN_AGENT_CONTEXT_ENV]: 'not json' }), undefined)
    assert.equal(
      loadAgentContextFromEnv({ [NORN_AGENT_CONTEXT_ENV]: JSON.stringify({ schema: 'other' }) }),
      undefined,
    )
    assert.deepEqual(
      loadAgentContextFromEnv({ [NORN_AGENT_CONTEXT_ENV]: JSON.stringify(context) }),
      context,
    )
  })
})

describe('the norn_complete submitter', () => {
  it('creates exactly one valid sidecar', async () => {
    const area = await createRunArea('ext')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const store = new CompletionStore(area.completionsDir)
    const submit = createNornCompletionSubmitter(context, store)

    const result = await submit(WORKER_CANDIDATE, context.piSessionId)

    assert.deepEqual(result, { ok: true, status: 'written', invocationId: context.invocationId })
    assert.deepEqual(await readdir(area.completionsDir), ['ag-invocation-1.json'])
    const read = await store.read(context.invocationId, context)
    assert.equal(read.status, 'valid')
  })

  it('accepts an identical resubmission without changing the sidecar', async () => {
    const area = await createRunArea('ext')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const store = new CompletionStore(area.completionsDir)
    const submit = createNornCompletionSubmitter(context, store)

    await submit(WORKER_CANDIDATE, context.piSessionId)
    const original = await readFile(store.pathFor(context.invocationId), 'utf8')
    const second = await submit(WORKER_CANDIDATE, context.piSessionId)

    assert.equal(second.ok, true)
    assert.equal(second.ok && second.status, 'identical')
    assert.equal(await readFile(store.pathFor(context.invocationId), 'utf8'), original)
  })

  it('rejects a conflicting second completion and keeps the original bytes', async () => {
    const area = await createRunArea('ext')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const store = new CompletionStore(area.completionsDir)
    const submit = createNornCompletionSubmitter(context, store)

    await submit(WORKER_CANDIDATE, context.piSessionId)
    const original = await readFile(store.pathFor(context.invocationId), 'utf8')

    const conflicting = await submit(
      { discriminant: 'block', code: 'cannot-satisfy-spec', reason: 'later thought' },
      context.piSessionId,
    )

    assert.equal(conflicting.ok, false)
    assert.ok(!conflicting.ok && conflicting.problem.includes('conflicting'))
    assert.equal(await readFile(store.pathFor(context.invocationId), 'utf8'), original)
  })

  it('rejects a typed completion belonging to the other role', async () => {
    const area = await createRunArea('ext')
    const worker = buildContext(area, { role: 'worker', phase: 'work' })
    const reviewer = buildContext(area, { role: 'reviewer', phase: 'work' })
    const store = new CompletionStore(area.completionsDir)

    const fromWorker = await createNornCompletionSubmitter(worker, store)(
      { discriminant: 'pass' },
      worker.piSessionId,
    )
    const fromReviewer = await createNornCompletionSubmitter(reviewer, store)(
      WORKER_CANDIDATE,
      reviewer.piSessionId,
    )

    assert.equal(fromWorker.ok, false)
    assert.equal(fromReviewer.ok, false)
    assert.deepEqual(await readdir(area.completionsDir), [])
  })

  it('rejects malformed completions with closed-code discipline', async () => {
    const area = await createRunArea('ext')
    const context = buildContext(area, { role: 'reviewer', phase: 'ship' })
    const store = new CompletionStore(area.completionsDir)
    const submit = createNornCompletionSubmitter(context, store)

    for (const bad of [
      'pass',
      {},
      { discriminant: 'nope' },
      { discriminant: 'block', code: 'made-up', reason: 'x' },
      { discriminant: 'block', code: 'spec-defect' },
      { discriminant: 'iterate' },
    ]) {
      assert.equal((await submit(bad, context.piSessionId)).ok, false, JSON.stringify(bad))
    }
    assert.deepEqual(await readdir(area.completionsDir), [])
  })

  it('binds to the launch Pi session: a foreign live session cannot complete', async () => {
    const area = await createRunArea('ext')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const store = new CompletionStore(area.completionsDir)
    const submit = createNornCompletionSubmitter(context, store)

    const foreign = await submit(WORKER_CANDIDATE, 'pi-session-someone-else')
    assert.equal(foreign.ok, false)
    assert.ok(!foreign.ok && foreign.problem.includes('session'))

    // Without a live session id (headless test context) the context binds.
    const bound = await submit(WORKER_CANDIDATE, undefined)
    assert.equal(bound.ok, true)
  })
})
