/**
 * The deterministic fake agent (test fixture).
 *
 * A plain node script that plays an agent invocation's Pi process for the
 * settlement tests: it reads the same `NORN_AGENT_CONTEXT` environment the
 * completion extension reads, writes its completion sidecar through the same
 * `CompletionStore` atomic path, and then behaves according to
 * `NORN_FAKE_MODE` — exit cleanly, linger as a grandchild in the same process
 * group, hang until terminated, exit without completing, or write a malformed
 * sidecar. Launched through the same VisibleAgentRunner adapters and settled
 * by the same engine as a real Herdr launch.
 *
 * Modes:
 *   complete       write a valid sidecar, then exit 0 (default)
 *   complete-hang  write a valid sidecar, then sleep forever (never exit)
 *   linger         write a valid sidecar, spawn `sleep N` in the same process
 *                  group, exit the leader while the grandchild lives
 *   hang           sleep forever without writing anything
 *   exit           exit 0 without writing anything
 *   malformed      write a malformed sidecar directly, then exit 0
 *   conflict       write a valid sidecar, then attempt a conflicting second
 *                  write; exit 0 only when the store rejects it
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  type AgentCompletion,
  CompletionStore,
  agentRecordedAt,
  encodeSidecar,
  sidecarDocument,
  validateCompletionContext,
} from '../../src/agents/completion.ts'

const mode = process.env.NORN_FAKE_MODE ?? 'complete'
const delayMs = Number(process.env.NORN_FAKE_DELAY_MS ?? '0')

const DEFAULT_WORKER: AgentCompletion = {
  discriminant: 'candidate',
  claimedCommit: `sha1:${'a'.repeat(40)}`,
  claimedTreeOid: `sha1:${'b'.repeat(40)}`,
}

function defaultCompletion(context: { role: string }): AgentCompletion {
  return context.role === 'worker' ? DEFAULT_WORKER : { discriminant: 'pass' }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function readContext() {
  const raw = process.env.NORN_AGENT_CONTEXT
  if (raw === undefined) {
    console.error('fake agent: NORN_AGENT_CONTEXT is missing')
    process.exit(4)
  }
  const context = validateCompletionContext(JSON.parse(raw))
  if (context === undefined) {
    console.error('fake agent: NORN_AGENT_CONTEXT is invalid')
    process.exit(4)
  }
  return context
}

function requestedCompletion(context: { role: string }): AgentCompletion {
  const raw = process.env.NORN_FAKE_COMPLETION
  if (raw === undefined) return defaultCompletion(context)
  return JSON.parse(raw) as AgentCompletion
}

async function writeMalformedSidecar(
  path: string,
  kind: string,
  context: NonNullable<Awaited<ReturnType<typeof readContext>>>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  if (kind === 'garbage') {
    await writeFile(path, 'not json at all {{{', 'utf8')
    return
  }
  if (kind === 'bad-schema') {
    await writeFile(path, JSON.stringify({ schema: 'norn-agent-completion:v2' }), 'utf8')
    return
  }
  if (kind === 'bad-oid') {
    const doc = sidecarDocument(
      context,
      { discriminant: 'candidate', claimedCommit: 'deadbeef', claimedTreeOid: 'sha1:' + 'c'.repeat(40) },
      agentRecordedAt(),
    )
    await writeFile(path, encodeSidecar(doc), 'utf8')
    return
  }
  // wrong-binding: a structurally valid sidecar that echoes a foreign run
  const doc = sidecarDocument(context, requestedCompletion(context), agentRecordedAt())
  const mutated = JSON.parse(encodeSidecar(doc)) as Record<string, unknown>
  mutated.runId = 'norn-run-someone-else'
  await writeFile(path, JSON.stringify(mutated, null, 2), 'utf8')
}

async function main(): Promise<void> {
  const context = await readContext()
  const store = new CompletionStore(context.completionsDir)
  const sidecarPath = store.pathFor(context.invocationId)

  if (delayMs > 0) await sleep(delayMs)

  switch (mode) {
    case 'complete': {
      const result = await store.write(context, requestedCompletion(context), agentRecordedAt())
      if (result.status === 'conflict') process.exit(5)
      return
    }
    case 'complete-hang': {
      await store.write(context, requestedCompletion(context), agentRecordedAt())
      await sleep(600_000)
      return
    }
    case 'linger': {
      await store.write(context, requestedCompletion(context), agentRecordedAt())
      // A grandchild that inherits this process group and outlives the
      // leader: settlement must wait for the whole group, not the leader.
      const seconds = process.env.NORN_FAKE_LINGER_SECONDS ?? '5'
      spawn('sleep', [seconds], { stdio: 'ignore' })
      return
    }
    case 'hang': {
      await sleep(600_000)
      return
    }
    case 'exit': {
      return
    }
    case 'malformed': {
      await writeMalformedSidecar(sidecarPath, process.env.NORN_FAKE_SIDECAR_MODE ?? 'garbage', context)
      return
    }
    case 'conflict': {
      const first = await store.write(context, requestedCompletion(context), agentRecordedAt())
      if (first.status === 'conflict') process.exit(5)
      const second = await store.write(context, defaultCompletion(context), agentRecordedAt())
      process.exit(second.status === 'conflict' ? 0 : 3)
    }
    default: {
      console.error(`fake agent: unknown NORN_FAKE_MODE ${mode}`)
      process.exit(4)
    }
  }
}

main().catch((cause) => {
  console.error('fake agent failed:', cause)
  process.exit(6)
})
