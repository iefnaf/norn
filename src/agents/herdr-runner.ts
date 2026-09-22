/**
 * Production adapter for the Visible Agent Runner seam: visible Herdr panes
 * (design.md §2.1, §6, §17).
 *
 * Worker and Reviewer Pi processes are launched with `herdr agent start`, so
 * the operator can inspect and steer them. The pane — and with it the agent's
 * complete process group — is owned by Herdr on Norn's behalf: termination is
 * `herdr pane close`, and the group counts as exited once Herdr no longer
 * reports the pane's process. Each agent loads the Norn completion extension
 * (see `completion-extension.ts`) so it can create its sidecar.
 *
 * Every Herdr CLI call is built by a pure `plan*` function, which is what
 * tests assert; the adapter itself only executes the plans.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { canonicalJson } from '../core/canonical-json.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'

import { NORN_AGENT_CONTEXT_ENV } from './completion-extension.ts'
import type { AgentLaunchRequest, AttachedAgentProcess, VisibleAgentRunner } from './runner.ts'

export const HERDR_ADAPTER = 'herdr' as const

/** A single planned Herdr CLI invocation, fully determined before execution. */
export type HerdrPlan = {
  readonly file: 'herdr'
  readonly args: readonly string[]
}

export type HerdrEnvEntry = { readonly key: string; readonly value: string }

/** Visible pane name for an agent invocation; also its agent label in Herdr. */
export function herdrAgentName(invocationId: string): string {
  return `norn-${invocationId}`
}

export function planHerdrAgentStart(
  invocationId: string,
  options: {
    readonly cwd: string
    readonly env: readonly HerdrEnvEntry[]
    readonly argv: readonly string[]
  },
): HerdrPlan {
  const args = ['agent', 'start', herdrAgentName(invocationId), '--cwd', options.cwd]
  for (const entry of options.env) {
    args.push('--env', `${entry.key}=${entry.value}`)
  }
  args.push('--no-focus', '--', ...options.argv)
  return { file: 'herdr', args }
}

export function planHerdrAgentGet(paneId: string): HerdrPlan {
  return { file: 'herdr', args: ['agent', 'get', paneId] }
}

export function planHerdrPaneClose(paneId: string): HerdrPlan {
  return { file: 'herdr', args: ['pane', 'close', paneId] }
}

export function encodeHerdrHandle(paneId: string, agentName: string): string {
  return JSON.stringify({ adapter: HERDR_ADAPTER, paneId, agentName })
}

export function decodeHerdrHandle(
  adapterHandle: string,
): { readonly paneId: string; readonly agentName: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(adapterHandle)
  } catch {
    throw new Error(`malformed herdr adapter handle: ${adapterHandle}`)
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { adapter?: unknown }).adapter !== HERDR_ADAPTER ||
    typeof (parsed as { paneId?: unknown }).paneId !== 'string' ||
    typeof (parsed as { agentName?: unknown }).agentName !== 'string'
  ) {
    throw new Error(`malformed herdr adapter handle: ${adapterHandle}`)
  }
  const handle = parsed as { paneId: string; agentName: string }
  return { paneId: handle.paneId, agentName: handle.agentName }
}

export type AgentRoleLaunch = {
  readonly model: string
  readonly thinking: string
}

/**
 * The Pi invocation for one agent process (design.md §8, §17): the exact
 * configured model and thinking level, the completion extension that owns
 * sidecar creation, and the exact project session ID that binds the sidecar
 * to this Pi session. Read-only capability policy for reviewers — such as
 * `--no-builtin-tools` — is applied by the Work layer, not by this builder.
 */
export function planAgentPiArgv(
  role: AgentRoleLaunch,
  options: { readonly extensionPath: string; readonly piSessionId: string },
): readonly string[] {
  return [
    'pi',
    '--model',
    role.model,
    '--thinking',
    role.thinking,
    '--extension',
    options.extensionPath,
    '--session-id',
    options.piSessionId,
  ]
}

/** The single environment entry every agent invocation receives. */
export function nornAgentContextEnv(context: CanonicalJsonValue): HerdrEnvEntry {
  return { key: NORN_AGENT_CONTEXT_ENV, value: canonicalJson(context) }
}

type HerdrExec = (plan: HerdrPlan) => Promise<string>

async function execHerdr(plan: HerdrPlan): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(plan.file, [...plan.args], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return stdout
  } catch (cause) {
    // Herdr reports protocol results — such as `agent_not_found` — as JSON
    // with a non-zero exit status; that payload is a valid answer, so it
    // flows through and only a payload-free failure rejects.
    for (const stream of ['stdout', 'stderr'] as const) {
      const output = (cause as { stdout?: string; stderr?: string })[stream]
      if (typeof output === 'string' && output.trim().length > 0) return output
    }
    throw cause
  }
}

export type HerdrCliResult = {
  readonly result?: {
    readonly agent?: {
      readonly pane_id?: string
      /** Herdr's process report for the pane's agent; `done` once the
       * complete process group has exited (the pane itself is retained
       * for inspection until it is closed). */
      readonly agent_status?: string
    }
  }
  readonly error?: { readonly code?: string; readonly message?: string }
}

export class HerdrAgentRunner implements VisibleAgentRunner {
  readonly kind = HERDR_ADAPTER

  private readonly exec: HerdrExec
  /** How long a termination waits for Herdr to confirm the pane is gone. */
  private readonly exitConfirmTimeoutMs: number

  constructor(exec: HerdrExec = execHerdr, exitConfirmTimeoutMs = 10_000) {
    this.exec = exec
    this.exitConfirmTimeoutMs = exitConfirmTimeoutMs
  }

  async launch(request: AgentLaunchRequest): Promise<AttachedAgentProcess> {
    const plan = planHerdrAgentStart(request.context.invocationId, {
      cwd: request.cwd,
      env: [nornAgentContextEnv(request.context as unknown as CanonicalJsonValue)],
      argv: request.argv,
    })
    const payload = parseHerdrJson(await this.exec(plan), 'agent start')
    const paneId = payload.result?.agent?.pane_id
    if (typeof paneId !== 'string' || paneId.length === 0) {
      throw new Error(`herdr agent start returned no pane id for ${request.context.invocationId}`)
    }
    return {
      kind: this.kind,
      adapterHandle: encodeHerdrHandle(paneId, herdrAgentName(request.context.invocationId)),
    }
  }

  attach(adapterHandle: string): AttachedAgentProcess {
    decodeHerdrHandle(adapterHandle)
    return { kind: this.kind, adapterHandle }
  }

  async isLive(processRef: AttachedAgentProcess): Promise<boolean> {
    const { paneId } = decodeHerdrHandle(processRef.adapterHandle)
    const payload = parseHerdrJson(await this.exec(planHerdrAgentGet(paneId)), 'agent get')
    if (payload.error?.code === 'agent_not_found') return false
    const agent = payload.result?.agent
    if (agent === undefined) {
      throw new Error(`herdr agent get returned an unrecognized response for pane ${paneId}`)
    }
    // Herdr keeps a finished agent's pane open so the operator can inspect
    // it; the process group itself is gone once herdr reports its status as
    // `done`. Any other reported status (or an older herdr without the
    // field) counts as live.
    return agent.agent_status !== 'done'
  }

  async waitForExit(
    processRef: AttachedAgentProcess,
    timeoutMs: number,
  ): Promise<'exited' | 'timeout'> {
    const deadline = Date.now() + timeoutMs
    while (await this.isLive(processRef)) {
      if (Date.now() >= deadline) return 'timeout'
      await delay(Math.min(100, Math.max(1, deadline - Date.now())))
    }
    return 'exited'
  }

  async terminate(processRef: AttachedAgentProcess): Promise<'terminated' | 'terminate-failed'> {
    const { paneId } = decodeHerdrHandle(processRef.adapterHandle)
    try {
      await this.exec(planHerdrPaneClose(paneId))
    } catch {
      // Closing an already-gone pane is success as long as the process is
      // provably gone; anything else fails the termination.
    }
    const settled = await this.waitForExit(processRef, this.exitConfirmTimeoutMs)
    return settled === 'exited' ? 'terminated' : 'terminate-failed'
  }
}

function parseHerdrJson(stdout: string, what: string): HerdrCliResult {
  try {
    return JSON.parse(stdout) as HerdrCliResult
  } catch {
    throw new Error(`herdr ${what} printed non-JSON output: ${stdout.slice(0, 200)}`)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
