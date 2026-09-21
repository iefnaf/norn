/**
 * Shared fixtures for the agent runner tests: a run-owned area laid out like
 * repository home (completions outside the source workspace), launch-context
 * builders for each role and phase, and fake-agent argv/env construction.
 */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  AgentCompletionContext,
  AgentPhase,
  AgentRole,
} from '../../src/agents/completion.ts'
export const fakeAgentPath = fileURLToPath(new URL('../fixtures/fake-agent.ts', import.meta.url))

export type RunArea = {
  readonly root: string
  readonly completionsDir: string
  readonly workspacePath: string
}

/** A run-owned area under a temp repository home, mirroring design.md §2.2. */
export async function createRunArea(label: string): Promise<RunArea> {
  const root = await mkdtemp(join(tmpdir(), `norn-agents-${label}-`))
  const runDir = join(root, 'norn-home', 'repositories', 'gh-example', 'R_1', 'runs', 'run-1')
  const completionsDir = join(runDir, 'completions')
  const workspacePath = join(runDir, 'workspaces', '42', 'att-1')
  await mkdir(completionsDir, { recursive: true })
  await mkdir(workspacePath, { recursive: true })
  return { root, completionsDir, workspacePath }
}

const MAP = { githubHost: 'github.com', repositoryId: 'R_1', issueId: 'I_map' } as const
const TICKET = { ...MAP, issueId: 'I_42', number: 42 } as const

const WORK_INPUT = {
  mapTitle: 'Example feature map',
  mapBody: 'Shared intent for the map.',
  mapRevision: `sha256:${'1'.repeat(64)}`,
  ticketTitle: 'Ticket 42',
  ticketBody: 'Do the thing.',
  ticketRevision: `sha256:${'2'.repeat(64)}`,
  target: {
    branch: 'main',
    baseSha: `sha1:${'3'.repeat(40)}`,
    baseTreeOid: `sha1:${'4'.repeat(40)}`,
  },
} as const

export function buildContext(
  area: RunArea,
  init: {
    readonly role: AgentRole
    readonly phase: AgentPhase
    readonly invocationId?: string
    readonly completionsDir?: string
    readonly workspacePath?: string
    readonly piSessionId?: string
  },
): AgentCompletionContext {
  const context: Record<string, unknown> = {
    schema: 'norn-agent-completion:v1',
    invocationId: init.invocationId ?? 'ag-invocation-1',
    runId: 'run-1',
    role: init.role,
    phase: init.phase,
    map: MAP,
    workspace: { kind: 'ticket', path: init.workspacePath ?? area.workspacePath },
    piSessionId: init.piSessionId ?? 'pi-session-1',
    completionsDir: init.completionsDir ?? area.completionsDir,
  }
  if (init.phase !== 'map-completion') {
    context.ticket = TICKET
  }
  if (init.role === 'worker') {
    context.work = { workAttemptId: 'att-1', round: 1, input: WORK_INPUT }
  }
  return context as AgentCompletionContext
}

/** The argv/env for one fake agent invocation through a runner adapter. */
export function fakeAgentLaunch(
  mode: string,
  options: { readonly completion?: unknown; readonly delayMs?: number; readonly extraEnv?: Record<string, string> } = {},
): { readonly argv: string[]; readonly env: Record<string, string> } {
  const env: Record<string, string> = {
    NORN_FAKE_MODE: mode,
    ...(options.delayMs === undefined ? {} : { NORN_FAKE_DELAY_MS: String(options.delayMs) }),
    ...(options.completion === undefined
      ? {}
      : { NORN_FAKE_COMPLETION: JSON.stringify(options.completion) }),
    ...(options.extraEnv ?? {}),
  }
  return { argv: [process.execPath, fakeAgentPath], env }
}

/** The fake worker's default candidate handoff (mirrors the fixture). */
export const defaultWorkerCandidate = {
  discriminant: 'candidate',
  claimedCommit: `sha1:${'a'.repeat(40)}`,
  claimedTreeOid: `sha1:${'b'.repeat(40)}`,
} as const
