/**
 * Production adapter for the Visible Agent Runner seam: one visible Herdr
 * tab per agent invocation (design.md §2.1, §6, §17).
 *
 * Herdr 0.9 separates pane creation from agent start, so one launch is two
 * CLI steps: `tab create --no-focus` opens a visible tab whose root shell
 * pane carries the requested cwd/env, then `agent start --kind pi --pane`
 * starts Pi's native command line in that exact pane. A tab per invocation
 * keeps concurrent agents readable instead of crowding the coordinator's
 * tab with ever more splits. If the second step fails, the freshly created
 * tab is closed again — a launch never leaks a stray shell pane.
 *
 * The tab — and with it the agent's complete process group — is owned by
 * Herdr on Norn's behalf: teardown is `herdr tab close`, so a settled
 * invocation leaves nothing behind. Herdr clears an
 * agent's record the moment its process exits, so exit is proven only by the
 * agent target no longer resolving (`agent_not_found` / `agent_not_running`);
 * every reported status — including `done`, which is idle-after-work in an
 * unseen tab — describes a live occupant. Each agent loads the Norn
 * completion extension (see `completion-extension.ts`) so it can create its
 * sidecar and shut down, which is what makes the pane's agent record
 * disappear.
 *
 * Every Herdr CLI call is built by a pure `plan*` function, which is what
 * tests assert; the adapter itself only executes the plans.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { canonicalJson, compareUtf16CodeUnits } from '../core/canonical-json.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'
import { sha256Digest } from '../core/digest.ts'
import { sanitizeCommandEnvironment } from '../work/environment.ts'

import { NORN_AGENT_CONTEXT_ENV } from './completion-extension.ts'
import type { AgentLaunchRequest, AttachedAgentProcess, VisibleAgentRunner } from './runner.ts'

export const HERDR_ADAPTER = 'herdr' as const

/** A single planned Herdr CLI invocation, fully determined before execution. */
export type HerdrPlan = {
  readonly file: 'herdr'
  readonly args: readonly string[]
}

export type HerdrEnvEntry = { readonly key: string; readonly value: string }

/**
 * The Herdr release line this adapter's CLI contract was validated against
 * (issue #31): a two-step `tab create --no-focus` + `agent start --kind pi
 * --pane` launch, `agent wait --until blocked`, and exit proven by the agent
 * record clearing. Herdr is pre-1.0 and its CLI surface changed within the
 * 0.7 → 0.9 line, so builds outside this range are rejected until norn is
 * re-validated against them. Herdr is not an npm package — it is an
 * operator-installed binary — so the range is enforced by the launch-time
 * probe below, not by a dependency pin.
 */
export const HERDR_SUPPORTED_VERSION_RANGE = '>=0.9.0 <0.10.0'

/** Inclusive lower bound of `HERDR_SUPPORTED_VERSION_RANGE`. */
const HERDR_MIN_VERSION: HerdrVersion = [0, 9, 0]
/** Exclusive upper bound of `HERDR_SUPPORTED_VERSION_RANGE`. */
const HERDR_MAX_VERSION: HerdrVersion = [0, 10, 0]

/** A `major.minor.patch` release reported by `herdr --version`. */
export type HerdrVersion = readonly [number, number, number]

function compareHerdrVersions(left: HerdrVersion, right: HerdrVersion): number {
  for (const index of [0, 1, 2] as const) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

/** Read the first `major.minor.patch` triple out of `herdr --version` output. */
export function parseHerdrVersion(output: string): HerdrVersion | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Whether a herdr build satisfies the range norn was validated against. */
export function herdrVersionSupported(version: HerdrVersion): boolean {
  return (
    compareHerdrVersions(version, HERDR_MIN_VERSION) >= 0 &&
    compareHerdrVersions(version, HERDR_MAX_VERSION) < 0
  )
}

/** The one-shot version probe gating the first launch (issue #31). */
export function planHerdrVersion(): HerdrPlan {
  return { file: 'herdr', args: ['--version'] }
}

/** Herdr 0.9 agent names: a lowercase letter, then at most 31 characters
 * of `[a-z0-9_-]` — 32 in total. */
const HERDR_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/

/** sha256 hex digits carrying the collision resistance of a compacted name
 * (48 bits; distinct concurrent invocations cannot realistically collide). */
const HERDR_NAME_DIGEST_CHARS = 12

/** Readable invocation-id characters kept by a compacted name: whatever fits
 * beside `norn-`, one `-`, and the digest inside the 32-character budget. */
const HERDR_NAME_PREFIX_CHARS = 32 - 'norn-'.length - 1 - HERDR_NAME_DIGEST_CHARS

/**
 * Visible pane name for an agent invocation; also its agent label in Herdr.
 *
 * Invocation ids may be up to 128 characters of coordinator-chosen text,
 * while Herdr 0.9 accepts only names matching `[a-z][a-z0-9_-]{0,31}` and
 * only names unique among live agents. The readable `norn-<invocation id>`
 * form is kept whenever it already satisfies that grammar; anything longer
 * or richer is compacted to a deterministic `norn-<readable prefix>-<digest>`
 * form — the digest is taken over the full invocation id, so truncation
 * cannot make distinct invocations share a name, while a sanitized prefix
 * preserves readability and the Herdr character grammar.
 */
export function herdrAgentName(invocationId: string): string {
  const readable = `norn-${invocationId}`
  if (HERDR_NAME_PATTERN.test(readable)) return readable

  const digest = sha256Digest(invocationId).slice(-HERDR_NAME_DIGEST_CHARS)
  const prefix = invocationId
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .slice(0, HERDR_NAME_PREFIX_CHARS)
    .replace(/-+$/, '')
  return ['norn', prefix, digest].filter((part) => part.length > 0).join('-')
}

/**
 * Step one of the two-step launch (Herdr 0.9): a new visible tab whose root
 * shell pane starts in `cwd` and inherits every `--env` entry, and through it
 * so does the agent started there in step two. One tab per invocation keeps
 * a fleet of concurrent agents readable — splitting the coordinator's pane
 * would crowd it with splits instead. `--no-focus` keeps the operator where
 * they are.
 */
export function planHerdrTabCreate(
  options: {
    readonly cwd: string
    readonly label: string
    readonly env: readonly HerdrEnvEntry[]
  },
): HerdrPlan {
  const args = ['tab', 'create', '--cwd', options.cwd, '--label', options.label]
  for (const entry of options.env) {
    args.push('--env', `${entry.key}=${entry.value}`)
  }
  args.push('--no-focus')
  return { file: 'herdr', args }
}

/** The agent kind Norn launches; Herdr maps it to the canonical executable. */
const NORN_AGENT_KIND = 'pi'

/**
 * Step two of the two-step launch (Herdr 0.9): start the Pi agent in the pane
 * created by `planHerdrPaneSplit`. Herdr takes no cwd, env, or focus here —
 * the pane already carries them — and the executable comes from `--kind`, so
 * the launch argv contributes only Pi's native arguments after `--`.
 */
export function planHerdrAgentStart(
  invocationId: string,
  options: { readonly paneId: string; readonly argv: readonly string[] },
): HerdrPlan {
  const [executable, ...nativeArgv] = options.argv
  if (executable !== NORN_AGENT_KIND) {
    throw new Error(
      `herdr agent start launches kind ${NORN_AGENT_KIND}, but the launch argv executable is ` +
        `${executable ?? 'none'}`,
    )
  }
  return {
    file: 'herdr',
    args: [
      'agent',
      'start',
      herdrAgentName(invocationId),
      '--kind',
      NORN_AGENT_KIND,
      '--pane',
      options.paneId,
      '--',
      ...nativeArgv,
    ],
  }
}

/** Submit the initial Norn briefing after Herdr has observed an idle Pi. */
export function planHerdrAgentPrompt(paneId: string, prompt: string): HerdrPlan {
  return { file: 'herdr', args: ['agent', 'prompt', paneId, prompt] }
}

function splitPiLaunch(
  argv: readonly string[],
): { readonly argv: readonly string[]; readonly prompt?: string } {
  const delimiter = argv.lastIndexOf('--')
  if (delimiter === -1) return { argv }
  if (delimiter !== argv.length - 2) {
    throw new Error('a Herdr Pi launch delimiter must be followed by exactly one initial prompt')
  }
  return { argv: argv.slice(0, delimiter), prompt: argv[delimiter + 1] }
}

export function planHerdrAgentGet(paneId: string): HerdrPlan {
  return { file: 'herdr', args: ['agent', 'get', paneId] }
}

export function planHerdrAgentWait(paneId: string, timeoutMs: number): HerdrPlan {
  // The budget is a wall-clock deadline, never a zero-length poll: keep the
  // Herdr-side value positive so an elapsed budget still reads current state.
  const budgetMs = Math.max(1, Math.floor(timeoutMs))
  // Herdr 0.9 has no exit status to wait for — statuses classify a live
  // occupant, and exit clears the agent record. `--until blocked` is the one
  // state a Norn agent reaches only by parking on an approval/question UI,
  // so the call stays pending for the whole budget while the agent lives and
  // Herdr ends it early (`agent_not_running`) the moment its process is gone.
  return {
    file: 'herdr',
    args: ['agent', 'wait', paneId, '--until', 'blocked', '--timeout', String(budgetMs)],
  }
}

export function planHerdrPaneClose(paneId: string): HerdrPlan {
  return { file: 'herdr', args: ['pane', 'close', paneId] }
}

/** Teardown of an owned invocation tab: its root pane goes with it. */
export function planHerdrTabClose(tabId: string): HerdrPlan {
  return { file: 'herdr', args: ['tab', 'close', tabId] }
}

/**
 * The teardown plan for one handle. Invocations launched into their own tab
 * close that whole tab; handles persisted before tabs carries a `paneId`
 * only, and still close their pane.
 */
export function planHerdrTeardown(handle: HerdrHandle): HerdrPlan {
  return handle.tabId === undefined
    ? planHerdrPaneClose(handle.paneId)
    : planHerdrTabClose(handle.tabId)
}

/**
 * A decoded adapter handle. `tabId` is absent on handles persisted by the
 * earlier pane-splitting launch, which must stay attachable across an
 * upgrade.
 */
export type HerdrHandle = {
  readonly paneId: string
  readonly agentName: string
  readonly tabId?: string
}

export function encodeHerdrHandle(handle: HerdrHandle): string {
  return JSON.stringify({
    adapter: HERDR_ADAPTER,
    paneId: handle.paneId,
    agentName: handle.agentName,
    ...(handle.tabId === undefined ? {} : { tabId: handle.tabId }),
  })
}

export function decodeHerdrHandle(adapterHandle: string): HerdrHandle {
  let parsed: unknown
  try {
    parsed = JSON.parse(adapterHandle)
  } catch {
    throw new Error(`malformed herdr adapter handle: ${adapterHandle}`)
  }
  const handle = parsed as { adapter?: unknown; paneId?: unknown; agentName?: unknown; tabId?: unknown }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    handle.adapter !== HERDR_ADAPTER ||
    typeof handle.paneId !== 'string' ||
    typeof handle.agentName !== 'string' ||
    (handle.tabId !== undefined && typeof handle.tabId !== 'string')
  ) {
    throw new Error(`malformed herdr adapter handle: ${adapterHandle}`)
  }
  return {
    paneId: handle.paneId as string,
    agentName: handle.agentName as string,
    ...(handle.tabId === undefined ? {} : { tabId: handle.tabId as string }),
  }
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

/** The coordinator-owned environment entry every agent invocation receives. */
export function nornAgentContextEnv(context: CanonicalJsonValue): HerdrEnvEntry {
  return { key: NORN_AGENT_CONTEXT_ENV, value: canonicalJson(context) }
}

/**
 * Build the explicit Herdr environment overrides. Configured extras retain
 * the shared GitHub/push-credential denylist; the coordinator-owned context
 * is always written last and cannot be replaced by a launch plan.
 */
export function herdrAgentEnvironment(
  context: CanonicalJsonValue,
  extra: Readonly<Record<string, string>> = {},
): readonly HerdrEnvEntry[] {
  const sanitized = sanitizeCommandEnvironment(extra)
  const entries = Object.entries(sanitized)
    .filter(([name]) => name !== NORN_AGENT_CONTEXT_ENV)
    .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
    .map(([key, value]) => ({ key, value }))
  return [...entries, nornAgentContextEnv(context)]
}

/** Budget of one Herdr CLI call; `agent start` and `agent wait` override it. */
const HERDR_COMMAND_TIMEOUT_MS = 15_000

/**
 * `agent start` returns only after Herdr detects the started agent and
 * considers it ready for input — up to its default 30 s readiness window —
 * so the CLI execution budget of the start call must exceed that window.
 */
const HERDR_AGENT_START_TIMEOUT_MS = 45_000

type HerdrExec = (plan: HerdrPlan, executionTimeoutMs?: number) => Promise<string>

async function execHerdr(
  plan: HerdrPlan,
  executionTimeoutMs = HERDR_COMMAND_TIMEOUT_MS,
): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(plan.file, [...plan.args], {
      timeout: executionTimeoutMs,
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
    readonly pane?: { readonly pane_id?: string }
    readonly root_pane?: { readonly pane_id?: string }
    readonly tab?: { readonly tab_id?: string }
    readonly agent?: {
      readonly pane_id?: string
      readonly name?: string
      /**
       * Herdr's lifecycle classification of a live pane occupant (`idle`,
       * `working`, `blocked`, `done`, `unknown`). `done` is idle-after-work
       * in an unseen tab, not an exit report: Herdr clears the whole agent
       * record when the process exits, so only a target that no longer
       * resolves proves the process is gone.
       */
      readonly agent_status?: string
    }
  }
  readonly error?: { readonly code?: string; readonly message?: string }
}

/** Herdr error codes proving the pane's agent record — and process — is gone. */
function agentRecordGone(payload: HerdrCliResult): boolean {
  const code = payload.error?.code
  // `agent_not_found`: the target pane/name hosts no agent (cleared on exit,
  // or the pane itself is closed). `agent_not_running`: a wait observed the
  // occupant disappear while it was being tracked.
  return code === 'agent_not_found' || code === 'agent_not_running'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export class HerdrAgentRunner implements VisibleAgentRunner {
  readonly kind = HERDR_ADAPTER

  private readonly exec: HerdrExec
  /** Memoized one-shot version probe; a rejected probe is retried on the
   * next launch instead of caching a permanent verdict. */
  private versionProbe: Promise<void> | undefined
  /** How long a termination waits for Herdr to confirm the pane is gone. */
  private readonly exitConfirmTimeoutMs: number
  /**
   * Pause between re-armed exit waits after an observed `blocked` state, so
   * an agent parked on an approval/question UI keeps its whole budget
   * without a tight re-wait loop.
   */
  private readonly blockedPollIntervalMs: number

  constructor(
    exec: HerdrExec = execHerdr,
    exitConfirmTimeoutMs = 10_000,
    blockedPollIntervalMs = 1_000,
  ) {
    this.exec = exec
    this.exitConfirmTimeoutMs = exitConfirmTimeoutMs
    this.blockedPollIntervalMs = blockedPollIntervalMs
  }

  /**
   * Fail fast on a herdr build outside the supported range (issue #31):
   * without this gate a mismatched CLI surfaces only mid-run — after a tab
   * and agent have already started — as an inscrutable `agent wait`
   * exception, so the version is proven before anything is launched.
   */
  private async ensureSupportedHerdrVersion(): Promise<void> {
    if (this.versionProbe === undefined) {
      this.versionProbe = this.probeHerdrVersion()
    }
    try {
      await this.versionProbe
    } catch (cause) {
      this.versionProbe = undefined
      throw cause
    }
  }

  private async probeHerdrVersion(): Promise<void> {
    let output: string
    try {
      output = await this.exec(planHerdrVersion())
    } catch (cause) {
      throw new Error(
        `herdr --version failed, so norn cannot confirm the required herdr ` +
          `range ${HERDR_SUPPORTED_VERSION_RANGE}: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    const version = parseHerdrVersion(output)
    if (version === undefined) {
      throw new Error(
        `herdr --version printed no recognizable version, so norn cannot confirm ` +
          `the required range ${HERDR_SUPPORTED_VERSION_RANGE}: ${output.slice(0, 200)}`,
      )
    }
    if (!herdrVersionSupported(version)) {
      throw new Error(
        `herdr ${version.join('.')} is outside norn's supported range ` +
          `${HERDR_SUPPORTED_VERSION_RANGE}: this adapter relies on the Herdr 0.9 CLI ` +
          `contract (tab create --no-focus, agent start --kind pi --pane, agent wait ` +
          `--until blocked, exit proven by a cleared agent record); install a herdr ` +
          `0.9.x build or re-validate norn against the newer release`,
      )
    }
  }

  async launch(request: AgentLaunchRequest): Promise<AttachedAgentProcess> {
    await this.ensureSupportedHerdrVersion()
    const invocationId = request.context.invocationId
    const agentName = herdrAgentName(invocationId)
    const piLaunch = splitPiLaunch(request.argv)
    // Validate the executable before creating a tab that would need cleanup.
    const startPlanFor = (paneId: string) =>
      planHerdrAgentStart(invocationId, { paneId, argv: piLaunch.argv })
    startPlanFor('__validate__')

    const created = parseHerdrJson(
      await this.exec(
        planHerdrTabCreate({
          cwd: request.cwd,
          label: agentName,
          env: herdrAgentEnvironment(
            request.context as unknown as CanonicalJsonValue,
            request.env,
          ),
        }),
      ),
      'tab create',
    )
    if (created.error !== undefined) {
      throw new Error(
        `herdr tab create failed (${created.error.code ?? 'unknown'}): ` +
          `${created.error.message ?? 'unknown error'}`,
      )
    }
    const paneId = created.result?.root_pane?.pane_id
    const tabId = created.result?.tab?.tab_id
    if (typeof paneId !== 'string' || paneId.length === 0) {
      throw new Error(`herdr tab create returned no root pane id for ${invocationId}`)
    }
    const handle: HerdrHandle = {
      paneId,
      agentName,
      ...(typeof tabId === 'string' && tabId.length > 0 ? { tabId } : {}),
    }
    try {
      const started = parseHerdrJson(
        await this.exec(startPlanFor(paneId), HERDR_AGENT_START_TIMEOUT_MS),
        'agent start',
      )
      if (started.error !== undefined) {
        throw new Error(
          `herdr agent start failed (${started.error.code ?? 'unknown'}): ` +
            `${started.error.message ?? 'unknown error'}`,
        )
      }
      const startedPane = started.result?.agent?.pane_id
      if (startedPane !== paneId) {
        throw new Error(
          `herdr agent start reported pane ${startedPane ?? 'none'} instead of the split pane ` +
            `${paneId} for ${invocationId}`,
        )
      }
      if (piLaunch.prompt !== undefined) {
        const prompted = parseHerdrJson(
          await this.exec(planHerdrAgentPrompt(paneId, piLaunch.prompt)),
          'agent prompt',
        )
        if (prompted.error !== undefined) {
          throw new Error(
            `herdr agent prompt failed (${prompted.error.code ?? 'unknown'}): ` +
              `${prompted.error.message ?? 'unknown error'}`,
          )
        }
        const promptedPane = prompted.result?.agent?.pane_id
        if (promptedPane !== paneId) {
          throw new Error(
            `herdr agent prompt reported pane ${promptedPane ?? 'none'} instead of ${paneId} ` +
              `for ${invocationId}`,
          )
        }
      }
      return { kind: this.kind, adapterHandle: encodeHerdrHandle(handle) }
    } catch (cause) {
      // The tab is owned by Norn: if the agent could not be started in it,
      // close it instead of leaving a stray shell tab behind.
      await this.release({ kind: this.kind, adapterHandle: encodeHerdrHandle(handle) })
      throw cause
    }
  }

  attach(adapterHandle: string): AttachedAgentProcess {
    decodeHerdrHandle(adapterHandle)
    return { kind: this.kind, adapterHandle }
  }

  async isLive(processRef: AttachedAgentProcess): Promise<boolean> {
    const { paneId } = decodeHerdrHandle(processRef.adapterHandle)
    const payload = parseHerdrJson(await this.exec(planHerdrAgentGet(paneId)), 'agent get')
    if (agentRecordGone(payload)) return false
    const agent = payload.result?.agent
    if (agent === undefined) {
      throw new Error(`herdr agent get returned an unrecognized response for pane ${paneId}`)
    }
    // Any reported agent record is a live occupant — including `done`, which
    // is idle-after-work in an unseen tab — because Herdr clears the record
    // when the process exits.
    return true
  }

  /**
   * Wait for the pane's complete process group to finish (ticket #22). One
   * bounded `herdr agent wait` process covers the whole budget while the
   * agent lives: Herdr ends it early (`agent_not_running`) the moment the
   * occupant disappears, so waiting cost is constant per invocation instead
   * of growing with the invocation's duration. Only a target that no longer
   * resolves proves the process is gone; every reported status is live, so
   * an observed `blocked` — the sole state this plan matches — re-arms the
   * wait after a pause instead of terminating a parked agent early.
   */
  async waitForExit(
    processRef: AttachedAgentProcess,
    timeoutMs: number,
  ): Promise<'exited' | 'timeout'> {
    const { paneId } = decodeHerdrHandle(processRef.adapterHandle)
    const deadline = Date.now() + Math.max(1, Math.floor(timeoutMs))
    for (;;) {
      const remainingMs = Math.max(1, deadline - Date.now())
      const payload = parseHerdrJson(
        await this.exec(
          planHerdrAgentWait(paneId, remainingMs),
          Math.max(HERDR_COMMAND_TIMEOUT_MS, remainingMs + HERDR_COMMAND_TIMEOUT_MS),
        ),
        'agent wait',
      )
      if (agentRecordGone(payload)) return 'exited'
      if (payload.error?.code === 'timeout') return 'timeout'
      if (payload.result?.agent?.agent_status === 'blocked') {
        if (Date.now() >= deadline) return 'timeout'
        await sleep(this.blockedPollIntervalMs)
        continue
      }
      throw new Error(`herdr agent wait returned an unrecognized response for pane ${paneId}`)
    }
  }

  /**
   * Close the owned tab after settlement (ticket #23): the agent's Pi
   * process has exited, so its tab would otherwise linger as a shell the
   * operator has to clean up themselves. Best-effort by contract — cleanup
   * never changes an already-decided settlement.
   */
  async release(processRef: AttachedAgentProcess): Promise<void> {
    let handle: HerdrHandle
    try {
      handle = decodeHerdrHandle(processRef.adapterHandle)
    } catch {
      // An unreadable handle owns nothing this adapter can close.
      return
    }
    try {
      await this.exec(planHerdrTeardown(handle))
    } catch {
      // Closing an already-gone tab is success; anything else is ignorable
      // here because settlement does not depend on cleanup.
    }
  }

  async terminate(processRef: AttachedAgentProcess): Promise<'terminated' | 'terminate-failed'> {
    const handle = decodeHerdrHandle(processRef.adapterHandle)
    try {
      await this.exec(planHerdrTeardown(handle))
    } catch {
      // Closing an already-gone tab is success as long as the process is
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
