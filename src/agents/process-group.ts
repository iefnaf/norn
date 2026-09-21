/**
 * Owned POSIX process groups for agent invocations (design.md §17).
 *
 * Norn launches every agent invocation as the leader of its own process group
 * and owns that group for its whole life: settlement requires the complete
 * group — the agent and any children it spawned — to have exited, and
 * termination always signals the group, never just the leader. Group
 * liveness is probed with `kill(-pgid, 0)`, so an orphaned grandchild that
 * inherited the group keeps the invocation unsettled until it exits.
 *
 * These primitives are intentionally free of Norn domain knowledge; the
 * adapters and the settlement engine build on them.
 */
import { type ChildProcess, spawn } from 'node:child_process'

/** Signals that a process group with `pgid` still has at least one live member. */
export function isProcessGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (cause) {
    if (isNoSuchProcess(cause)) return false
    // EPERM: members exist but belong to another effective user — still alive.
    return true
  }
}

export type GroupSpawnOptions = {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Spawn `argv` as the leader of a fresh process group (`detached`), with no
 * inherited descriptors, and detach it from this coordinator. The returned
 * child is the group leader; its `pid` is the process-group ID.
 *
 * A failed spawn (missing executable, bad cwd) reports its `'error'` event
 * asynchronously, so this waits one macrotask before resolving; it then
 * throws `ProcessGroupSpawnError` if the process could not be created.
 * Process groups require POSIX; on any other platform this always throws.
 */
export async function spawnProcessGroup(
  argv: readonly string[],
  options: GroupSpawnOptions = {},
): Promise<ChildProcess> {
  if (process.platform === 'win32') {
    throw new ProcessGroupSpawnError('process-group ownership requires a POSIX platform', argv)
  }
  if (argv.length === 0 || typeof argv[0] !== 'string' || argv[0].length === 0) {
    throw new ProcessGroupSpawnError('argv must name an executable', argv)
  }

  let spawnFailure: unknown
  let child: ChildProcess
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env === undefined ? undefined : { ...options.env },
      detached: true,
      stdio: 'ignore',
    })
    child.once('error', (cause) => {
      spawnFailure = cause
    })
  } catch (cause) {
    throw new ProcessGroupSpawnError(
      `failed to spawn ${argv[0]}: ${describeError(cause)}`,
      argv,
      cause,
    )
  }

  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))

  if (spawnFailure !== undefined || child.pid === undefined) {
    throw new ProcessGroupSpawnError(
      `failed to spawn ${argv[0]}: ${describeError(spawnFailure ?? 'no pid')}`,
      argv,
      spawnFailure,
    )
  }
  child.unref()
  return child
}

export class ProcessGroupSpawnError extends Error {
  readonly argv: readonly string[]
  readonly cause?: unknown

  constructor(
    message: string,
    argv: readonly string[],
    cause?: unknown,
  ) {
    super(message)
    this.name = 'ProcessGroupSpawnError'
    this.argv = argv
    this.cause = cause
  }
}

export type GroupWaitOptions = {
  /** How long to wait for every group member to exit before giving up. */
  readonly timeoutMs: number
  /** Poll interval; small keeps tests fast, larger is kinder in production. */
  readonly pollMs?: number
}

/**
 * Wait until the complete process group has exited. Resolves `true` once no
 * member remains, or `false` when `timeoutMs` elapses first — in which case
 * the caller decides between waiting longer and terminating the group.
 */
export async function waitForProcessGroupExit(
  pgid: number,
  options: GroupWaitOptions,
): Promise<boolean> {
  const pollMs = options.pollMs ?? 25
  const deadline = Date.now() + options.timeoutMs
  while (isProcessGroupAlive(pgid)) {
    if (Date.now() >= deadline) return false
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
  return true
}

export type GroupTerminateOptions = {
  /** Grace period between SIGTERM and SIGKILL escalation. */
  readonly graceMs?: number
  /** Upper bound on the whole termination, including the SIGKILL wait. */
  readonly killWaitMs?: number
  readonly pollMs?: number
}

/**
 * Terminate the complete process group and settle it: SIGTERM the group,
 * wait out the grace period, escalate to SIGKILL, and only report
 * `'terminated'` once no member remains. `'terminate-failed'` means the group
 * could not be proven exited within the bounds — the caller must treat its
 * state as unknown rather than settled.
 */
export async function terminateProcessGroup(
  pgid: number,
  options: GroupTerminateOptions = {},
): Promise<'terminated' | 'terminate-failed'> {
  const graceMs = options.graceMs ?? 2_000
  const killWaitMs = options.killWaitMs ?? 5_000
  const pollMs = options.pollMs ?? 25

  try {
    if (!isProcessGroupAlive(pgid)) return 'terminated'

    await signalGroup(pgid, 'SIGTERM')
    if (await waitForProcessGroupExit(pgid, { timeoutMs: graceMs, pollMs })) return 'terminated'

    await signalGroup(pgid, 'SIGKILL')
    const exited = await waitForProcessGroupExit(pgid, { timeoutMs: killWaitMs, pollMs })
    return exited ? 'terminated' : 'terminate-failed'
  } catch {
    // Signalling or probing failed for reasons other than the group being
    // gone: its state is unknown, which is never 'settled'.
    return 'terminate-failed'
  }
}

async function signalGroup(pgid: number, signal: NodeJS.Signals): Promise<void> {
  if (!isProcessGroupAlive(pgid)) return
  try {
    process.kill(-pgid, signal)
  } catch (cause) {
    if (isNoSuchProcess(cause)) return
    throw cause
  }
}

function isNoSuchProcess(cause: unknown): boolean {
  return cause instanceof Error && (cause as NodeJS.ErrnoException).code === 'ESRCH'
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
