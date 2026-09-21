/**
 * Completion sidecar document model and store (design.md §17, ticket #8).
 *
 * Covers: context validation and role/phase consistency, the run-owned
 * placement of the completions area outside the source workspace, typed
 * completion validation, canonical encoding, atomic exclusive sidecar
 * creation, idempotent identical rewrites, rejection of conflicting second
 * completions, and read-side classification (missing / unparseable /
 * invalid-shape / binding-mismatch / valid).
 */
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

import {
  AGENT_COMPLETION_SCHEMA,
  AGENT_RECORDED_AT_PATTERN,
  CompletionStore,
  type AgentCompletionContext,
  agentRecordedAt,
  encodeSidecar,
  sidecarDocument,
  validateCompletionContext,
  validateReviewerCompletion,
  validateSidecarAgainstContext,
  validateWorkerCompletion,
} from '../src/agents/completion.ts'
import { buildContext, createRunArea } from './helpers/agent-fixtures.ts'

const WORKER_CANDIDATE = {
  discriminant: 'candidate',
  claimedCommit: `sha1:${'c'.repeat(40)}`,
  claimedTreeOid: `sha1:${'d'.repeat(40)}`,
} as const

async function writeDoctoredSidecar(
  store: CompletionStore,
  context: AgentCompletionContext,
  mutate: (doc: Record<string, unknown>) => void,
): Promise<void> {
  const doc = JSON.parse(
    encodeSidecar(sidecarDocument(context, WORKER_CANDIDATE, agentRecordedAt(new Date(1700000000000)))),
  ) as Record<string, unknown>
  mutate(doc)
  await mkdir(dirname(store.pathFor(context.invocationId)), { recursive: true })
  await writeFile(store.pathFor(context.invocationId), JSON.stringify(doc), 'utf8')
}

describe('validateCompletionContext', () => {
  it('accepts a full Work worker context', async () => {
    const area = await createRunArea('ctx')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const validated = validateCompletionContext(JSON.parse(JSON.stringify(context)))
    assert.deepEqual(validated, context)
  })

  it('accepts work and ship reviewer contexts and a map-completion reviewer context', async () => {
    const area = await createRunArea('ctx')
    for (const phase of ['work', 'ship', 'map-completion'] as const) {
      const context = buildContext(area, { role: 'reviewer', phase })
      assert.ok(validateCompletionContext(JSON.parse(JSON.stringify(context))), phase)
    }
  })

  it('rejects a worker outside the Work phase', async () => {
    const area = await createRunArea('ctx')
    for (const phase of ['ship', 'map-completion'] as const) {
      const context = buildContext(area, { role: 'worker', phase })
      assert.equal(validateCompletionContext(context), undefined, phase)
    }
  })

  it('rejects a worker without the work attempt binding', async () => {
    const area = await createRunArea('ctx')
    const context = buildContext(area, { role: 'worker', phase: 'work' }) as Record<string, unknown>
    delete context.work
    assert.equal(validateCompletionContext(context), undefined)
  })

  it('lets a Work-phase reviewer carry the attempt binding but rejects it for later phases', async () => {
    const area = await createRunArea('ctx')
    const base = buildContext(area, { role: 'worker', phase: 'work' })

    const workReviewer = { ...base, role: 'reviewer' }
    assert.ok(validateCompletionContext(workReviewer))

    const shipReviewer = { ...base, role: 'reviewer', phase: 'ship' }
    assert.equal(validateCompletionContext(shipReviewer), undefined)
  })

  it('rejects Work or Ship phases without a ticket, and map completion with one', async () => {
    const area = await createRunArea('ctx')
    const noTicket = buildContext(area, { role: 'reviewer', phase: 'work' }) as Record<string, unknown>
    delete noTicket.ticket
    assert.equal(validateCompletionContext(noTicket), undefined)

    const withTicket = buildContext(area, { role: 'reviewer', phase: 'map-completion' }) as Record<
      string,
      unknown
    >
    withTicket.ticket = { githubHost: 'github.com', repositoryId: 'R_1', issueId: 'I_42', number: 42 }
    assert.equal(validateCompletionContext(withTicket), undefined)
  })

  it('rejects a completions area inside the source workspace', async () => {
    const area = await createRunArea('ctx')
    const inside = buildContext(area, {
      role: 'worker',
      phase: 'work',
      completionsDir: join(area.workspacePath, 'completions'),
    })
    assert.equal(validateCompletionContext(inside), undefined)
  })

  it('rejects non-absolute completions areas and unusable invocation IDs', async () => {
    const area = await createRunArea('ctx')
    const relative = buildContext(area, { role: 'worker', phase: 'work', completionsDir: 'runs/run-1/completions' })
    assert.equal(validateCompletionContext(relative), undefined)

    const badId = buildContext(area, { role: 'worker', phase: 'work', invocationId: '../escape' })
    assert.equal(validateCompletionContext(badId), undefined)
  })

  it('rejects wrong schema, roles, phases, and empty session IDs', async () => {
    const area = await createRunArea('ctx')
    const context = buildContext(area, { role: 'worker', phase: 'work' }) as Record<string, unknown>
    for (const [label, mutate] of [
      ['schema', (c: Record<string, unknown>) => (c.schema = 'norn-agent-completion:v2')],
      ['role', (c: Record<string, unknown>) => (c.role = 'bystander')],
      ['phase', (c: Record<string, unknown>) => (c.phase = 'deploy')],
      ['session', (c: Record<string, unknown>) => (c.piSessionId = '')],
      ['workspace kind', (c: Record<string, unknown>) => (c.workspace = { kind: 'staging', path: area.root })],
    ] as const) {
      const copy = JSON.parse(JSON.stringify(context)) as Record<string, unknown>
      mutate(copy)
      assert.equal(validateCompletionContext(copy), undefined, label)
    }
  })
})

describe('typed completions', () => {
  it('accepts worker candidate and block shapes and rejects everything else', () => {
    assert.deepEqual(validateWorkerCompletion(WORKER_CANDIDATE), WORKER_CANDIDATE)
    const block = { discriminant: 'block', code: 'cannot-satisfy-spec', reason: 'no path' }
    assert.deepEqual(validateWorkerCompletion(block), block)

    assert.equal(validateWorkerCompletion({ ...WORKER_CANDIDATE, claimedCommit: 'deadbeef' }), undefined)
    assert.equal(
      validateWorkerCompletion({ discriminant: 'block', code: 'made-up', reason: 'x' }),
      undefined,
    )
    assert.equal(validateWorkerCompletion({ discriminant: 'pass' }), undefined)
    assert.equal(validateWorkerCompletion('candidate'), undefined)
  })

  it('accepts reviewer verdict shapes and rejects everything else', () => {
    assert.deepEqual(validateReviewerCompletion({ discriminant: 'pass' }), { discriminant: 'pass' })
    const iterate = { discriminant: 'iterate', feedback: 'tighten tests' }
    assert.deepEqual(validateReviewerCompletion(iterate), iterate)
    const block = { discriminant: 'block', code: 'spec-defect', reason: 'ambiguous spec' }
    assert.deepEqual(validateReviewerCompletion(block), block)

    assert.equal(validateReviewerCompletion({ discriminant: 'candidate' }), undefined)
    assert.equal(validateReviewerCompletion({ discriminant: 'iterate' }), undefined)
    assert.equal(
      validateReviewerCompletion({ discriminant: 'block', code: 'cannot-satisfy-spec', reason: 'x' }),
      undefined,
    )
  })

  it('records timestamps in the sealed RFC 3339 format', () => {
    const stamped = agentRecordedAt(new Date(Date.UTC(2026, 8, 21, 10, 22, 29, 6)))
    assert.equal(stamped, '2026-09-21T10:22:29.006Z')
    assert.match(agentRecordedAt(), AGENT_RECORDED_AT_PATTERN)
  })
})

describe('CompletionStore.write', () => {
  it('creates exactly one canonical sidecar atomically, with no temp leftovers', async () => {
    const area = await createRunArea('write')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const store = new CompletionStore(area.completionsDir)

    const result = await store.write(context, WORKER_CANDIDATE, '2026-09-21T10:22:29.006Z')

    assert.equal(result.status, 'written')
    assert.deepEqual(await readdir(area.completionsDir), ['ag-invocation-1.json'])
    const bytes = await readFile(store.pathFor(context.invocationId), 'utf8')
    const parsed = JSON.parse(bytes)
    assert.equal(parsed.schema, AGENT_COMPLETION_SCHEMA)
    assert.deepEqual(parsed.completion, WORKER_CANDIDATE)
    // RFC 8785: object keys sorted, no whitespace.
    assert.ok(bytes.startsWith('{"completion":'), bytes.slice(0, 40))
  })

  it('accepts a byte-identical rewrite as idempotent', async () => {
    const area = await createRunArea('write')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const store = new CompletionStore(area.completionsDir)

    await store.write(context, WORKER_CANDIDATE, '2026-09-21T10:22:29.006Z')
    const second = await store.write(context, WORKER_CANDIDATE, '2026-09-21T10:22:29.006Z')
    const third = await store.write(context, WORKER_CANDIDATE, '2026-09-21T10:22:29.006Z')

    assert.equal(second.status, 'identical')
    assert.equal(third.status, 'identical')
    assert.deepEqual(await readdir(area.completionsDir), ['ag-invocation-1.json'])
  })

  it('rejects a conflicting second completion and preserves the original bytes', async () => {
    const area = await createRunArea('write')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const store = new CompletionStore(area.completionsDir)

    await store.write(context, WORKER_CANDIDATE, '2026-09-21T10:22:29.006Z')
    const original = await readFile(store.pathFor(context.invocationId), 'utf8')

    const conflicting = await store.write(
      context,
      { discriminant: 'block', code: 'workspace-unusable', reason: 'changed my mind' },
      '2026-09-21T10:22:30.000Z',
    )

    assert.equal(conflicting.status, 'conflict')
    assert.equal(await readFile(store.pathFor(context.invocationId), 'utf8'), original)
  })

  it('writes each invocation under its own id in the shared completions area', async () => {
    const area = await createRunArea('write')
    const store = new CompletionStore(area.completionsDir)
    const first = buildContext(area, { role: 'worker', phase: 'work', invocationId: 'ag-a' })
    const second = buildContext(area, { role: 'worker', phase: 'work', invocationId: 'ag-b' })

    await store.write(first, WORKER_CANDIDATE, '2026-09-21T10:22:29.006Z')
    await store.write(
      second,
      { discriminant: 'block', code: 'requires-operator-decision', reason: 'needs input' },
      '2026-09-21T10:22:29.007Z',
    )

    assert.deepEqual((await readdir(area.completionsDir)).sort(), ['ag-a.json', 'ag-b.json'])
  })
})

describe('sidecar validation against the launch context', () => {
  it('accepts a sidecar that echoes every binding', async () => {
    const area = await createRunArea('bind')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const store = new CompletionStore(area.completionsDir)
    await store.write(context, WORKER_CANDIDATE, '2026-09-21T10:22:29.006Z')

    const read = await store.read(context.invocationId, context)

    assert.equal(read.status, 'valid')
    assert.ok('sidecar' in read)
    assert.equal(read.sidecar.invocationId, context.invocationId)
    assert.equal(read.sidecar.runId, context.runId)
    assert.equal(read.sidecar.role, 'worker')
    assert.equal(read.sidecar.phase, 'work')
    assert.deepEqual(read.sidecar.ticket, context.ticket)
    assert.deepEqual(read.sidecar.work, context.work)
    assert.deepEqual(read.sidecar.workspace, context.workspace)
    assert.equal(read.sidecar.piSessionId, context.piSessionId)
    assert.deepEqual(read.sidecar.completion, WORKER_CANDIDATE)
  })

  it('reports a missing sidecar as missing', async () => {
    const area = await createRunArea('bind')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const read = await new CompletionStore(area.completionsDir).read(context.invocationId, context)
    assert.equal(read.status, 'missing')
  })

  it('classifies unparseable and structurally invalid sidecars', async () => {
    const area = await createRunArea('bind')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const store = new CompletionStore(area.completionsDir)
    await mkdir(area.completionsDir, { recursive: true })

    await writeFile(store.pathFor(context.invocationId), 'not json {{{', 'utf8')
    assert.deepEqual(await store.read(context.invocationId, context), {
      status: 'invalid',
      problem: 'unparseable',
    })

    await writeFile(
      store.pathFor(context.invocationId),
      JSON.stringify({ schema: AGENT_COMPLETION_SCHEMA }),
      'utf8',
    )
    assert.deepEqual(await store.read(context.invocationId, context), {
      status: 'invalid',
      problem: 'invalid-shape',
    })

    await writeDoctoredSidecar(store, context, (doc) => {
      ;(doc.completion as Record<string, unknown>).claimedCommit = 'deadbeef'
    })
    assert.deepEqual(await store.read(context.invocationId, context), {
      status: 'invalid',
      problem: 'invalid-shape',
    })

    await writeDoctoredSidecar(store, context, (doc) => {
      doc.recordedAt = '2026-09-21 10:22:29'
    })
    assert.deepEqual(await store.read(context.invocationId, context), {
      status: 'invalid',
      problem: 'invalid-shape',
    })
  })

  for (const [label, doctor] of [
    ['run ID', (doc: Record<string, unknown>) => (doc.runId = 'run-other')],
    ['role', (doc: Record<string, unknown>) => (doc.role = 'reviewer')],
    ['phase', (doc: Record<string, unknown>) => (doc.phase = 'ship')],
    ['map binding', (doc: Record<string, unknown>) => (doc.map = { githubHost: 'evil.example' })],
    ['ticket binding', (doc: Record<string, unknown>) => (doc.ticket = undefined)],
    ['work attempt', (doc: Record<string, unknown>) => ((doc.work as Record<string, unknown>).round = 7)],
    ['work input', (doc: Record<string, unknown>) =>
      ((doc.work as Record<string, unknown>).input as Record<string, unknown>).mapRevision = 'sha256:zz'],
    ['workspace', (doc: Record<string, unknown>) => (doc.workspace = { kind: 'ticket', path: '/elsewhere' })],
    ['Pi session', (doc: Record<string, unknown>) => (doc.piSessionId = 'pi-session-other')],
  ] as const) {
    it(`detects a mismatched ${label} binding`, async () => {
      const area = await createRunArea('bind')
      const context = buildContext(area, { role: 'worker', phase: 'work' })
      const store = new CompletionStore(area.completionsDir)
      await writeDoctoredSidecar(store, context, doctor)

      assert.deepEqual(await store.read(context.invocationId, context), {
        status: 'invalid',
        problem: 'binding-mismatch',
      })
    })
  }

  it('rejects a completion of the wrong role even with perfect bindings', async () => {
    const area = await createRunArea('bind')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const { completionsDir: _drop, ...bindings } = context
    const verdict = validateSidecarAgainstContext(
      { ...bindings, completion: { discriminant: 'pass' }, recordedAt: '2026-09-21T10:22:29.006Z' },
      context,
    )
    assert.deepEqual(verdict, { problem: 'invalid-shape' })
  })
})
