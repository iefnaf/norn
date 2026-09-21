/**
 * The completion extension agents load (design.md §17, ticket #8).
 *
 * Covers: tool registration and the terminate hint, context loading from the
 * environment, exactly-one sidecar creation through the tool body, idempotent
 * identical resubmission, rejection of a conflicting second completion,
 * rejection of completions of the wrong role, and the live Pi session
 * binding check.
 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { CompletionStore } from '../src/agents/completion.ts'
import nornCompletionExtension, {
  NORN_AGENT_CONTEXT_ENV,
  NORN_COMPLETE_TOOL_NAME,
  completionExtensionPath,
  createNornCompletionSubmitter,
  loadAgentContextFromEnv,
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
    ctx: { sessionManager: { getSessionId: () => string | undefined } },
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown; terminate?: boolean }>
}

function fakePi() {
  const tools: RegisteredTool[] = []
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.push(tool)
    },
  }
  return { pi: pi as unknown as ExtensionAPI, tools }
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

    const result = await tools[0].execute('t1', WORKER_CANDIDATE, undefined, undefined, {
      sessionManager: { getSessionId: () => context.piSessionId },
    })
    assert.equal(result.terminate, true)
    assert.match(result.content[0].text, /Norn completion written/)
  })

  it('answers with an error when the launch context is missing', async () => {
    const { pi, tools } = fakePi()
    withEnv({ [NORN_AGENT_CONTEXT_ENV]: undefined }, () => {
      nornCompletionExtension(pi)
    })

    const result = await tools[0].execute('t1', WORKER_CANDIDATE, undefined, undefined, {
      sessionManager: { getSessionId: () => undefined },
    })
    assert.match(result.content[0].text, /missing or invalid/)
  })

  it('exposes its own file path for pi --extension launch plans', () => {
    assert.ok(completionExtensionPath().endsWith('completion-extension.ts'))
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
