/**
 * The Command runner seam (design.md §6, §8, §10.2).
 *
 * Executes configured argument arrays — `argv[0]` is the executable, no
 * shell, no per-command environment or working directory — with the active
 * gate workspace as working directory, a coordinator-defined environment
 * that excludes GitHub tokens and push credentials, a wall-clock timeout,
 * complete process-group termination and settlement, and exactly framed
 * captured stdout/stderr.
 *
 * Every execution returns only after its complete process group has settled:
 * either the whole group exited before the wall-clock budget elapsed, or the
 * group was terminated after timeout and proven exited. A caller may
 * therefore inspect the repository the moment `execute` resolves — the
 * settlement precondition of the protocol-valid command check (§10.2) holds
 * by construction.
 *
 * The production adapter reuses the POSIX process-group primitives from
 * `src/agents/process-group.ts`, extending the spawn to piped stdio so the
 * captured bytes are exact.
 */
import { type ChildProcess, spawn } from 'node:child_process'

import { terminateProcessGroup, waitForProcessGroupExit } from '../agents/process-group.ts'
import type { GroupTerminateOptions } from '../agents/process-group.ts'
import type { Sha256Digest } from '../core/digest.ts'

import { commandOutputDigest } from './command-output.ts'
import { sanitizeCommandEnvironment } from './environment.ts'

/** One configured command execution request. */
export type CommandExecutionRequest = {
  readonly argv: readonly string[]
  readonly cwd: string
  /** Wall-clock budget of the complete process group, in milliseconds. */
  readonly timeoutMs: number
}

/** Byte-accurate captured output plus its framed digest (design.md §10.3). */
export type CapturedOutput = {
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
  readonly outputDigest: Sha256Digest
}

/**
 * The typed result of one command execution. Every settled variant proves
 * the complete process group exited — normally, or terminated after timeout
 * — before that value existed.
 */
export type CommandExecution =
  | ({
      /** The complete group exited before the wall-clock budget elapsed. */
      readonly status: 'exited'
      /** Leader exit status; `null` when it died from a signal. */
      readonly exitCode: number | null
      readonly processGroup: { readonly state: 'settled'; readonly terminated: false }
    } & CapturedOutput)
  | ({
      /** The budget elapsed and the group was terminated and settled. */
      readonly status: 'timeout-terminated'
      readonly exitCode: number | null
      readonly processGroup: { readonly state: 'settled'; readonly terminated: true }
    } & CapturedOutput)
  | { readonly status: 'launch-failed'; readonly message: string }
  | {
      /**
       * Termination could not prove group exit, or the capture never
       * completed: the process state is unknown and the caller must treat
       * the workspace as uninspectable.
       */
      readonly status: 'settle-failed'
      readonly message: string
      readonly exitCode: number | null
    }

/**
 * The Command runner seam (design.md §6): one built-in production adapter;
 * deterministic fakes replace it in tests.
 */
export interface CommandRunner {
  execute(request: CommandExecutionRequest): Promise<CommandExecution>
}

export type ProcessGroupCommandRunnerOptions = {
  /**
   * Source of the coordinator-defined environment; defaults to the
   * coordinator's own environment, sanitized of GitHub tokens and push
   * credentials. Injectable so tests supply explicit data.
   */
  readonly environment?: () => Readonly<Record<string, string | undefined>>
  /** Options passed to process-group termination after a timeout. */
  readonly terminate?: GroupTerminateOptions
  /** Bound on waiting for the piped streams to close after group settlement. */
  readonly streamCloseGraceMs?: number
}

const DEFAULT_STREAM_CLOSE_GRACE_MS = 5_000

/** Bound on reaping the leader's exit status once the group is settled. */
const LEADER_EXIT_GRACE_MS = 2_000

/**
 * The built-in production adapter: one detached POSIX process group per
 * command, piped output, wall-clock timeout, group termination and
 * settlement. Never resolves a result while any group member lives.
 */
export class ProcessGroupCommandRunner implements CommandRunner {
  private readonly options: ProcessGroupCommandRunnerOptions

  /**
   * Spawned leaders stay referenced so Node keeps reaping them; a dropped
   * `ChildProcess` could leave an unreaped zombie whose pid keeps the group
   * looking alive to `kill(-pgid, 0)`.
   */
  private readonly children = new Map<number, ChildProcess>()

  constructor(options: ProcessGroupCommandRunnerOptions = {}) {
    this.options = options
  }

  async execute(request: CommandExecutionRequest): Promise<CommandExecution> {
    if (request.argv.length === 0 || typeof request.argv[0] !== 'string') {
      return { status: 'launch-failed', message: 'argv must name an executable' }
    }

    const spawned = await trySpawnGroup(request, this.environment())
    if (spawned.failure !== undefined) {
      return { status: 'launch-failed', message: spawned.failure }
    }
    const child = spawned.child
    const pgid = child.pid as number
    this.children.set(pgid, child)
    child.once('exit', () => this.children.delete(pgid))

    const deadline = Date.now() + request.timeoutMs
    const capture = captureStreams(child)
    const leaderExit = waitForLeaderExit(child)

    if (await Promise.race([leaderExit.then(() => true), sleepUntil(deadline)])) {
      // The leader exited; settle the rest of the group within the budget
      // that remains — a lingering grandchild keeps a command running.
      const settled = await waitForProcessGroupExit(pgid, {
        timeoutMs: Math.max(0, deadline - Date.now()),
      })
      if (settled) {
        const settledCapture = await this.settledCapture(child, capture, leaderExit)
        if (settledCapture.failure !== undefined) {
          return settleFailed(settledCapture.failure, settledCapture.code)
        }
        const { code, ...captured } = settledCapture
        return {
          status: 'exited',
          exitCode: code,
          processGroup: { state: 'settled', terminated: false },
          ...captured,
        }
      }
    }

    // Wall-clock budget elapsed: terminate and settle the complete group
    // before any result exists.
    const termination = await terminateProcessGroup(pgid, this.options.terminate ?? {})
    if (termination !== 'terminated') {
      const code = await settledLeaderCode(leaderExit)
      return settleFailed('process group could not be proven exited after timeout', code)
    }
    const settledCapture = await this.settledCapture(child, capture, leaderExit)
    if (settledCapture.failure !== undefined) {
      return settleFailed(settledCapture.failure, settledCapture.code)
    }
    const { code, ...captured } = settledCapture
    return {
      status: 'timeout-terminated',
      exitCode: code,
      processGroup: { state: 'settled', terminated: true },
      ...captured,
    }
  }

  private async settledCapture(
    child: ChildProcess,
    capture: StreamCapture,
    leaderExit: Promise<{ code: number | null }>,
  ): Promise<SettledCapture> {
    if (!(await capture.closed(this.streamCloseGraceMs()))) {
      return {
        failure: 'output streams did not close after group settlement',
        code: await settledLeaderCode(leaderExit),
      }
    }
    const code = await settledLeaderCode(leaderExit)
    this.children.delete(child.pid as number)
    return { code, ...capture.result() }
  }

  private environment(): Readonly<Record<string, string | undefined>> {
    return this.options.environment === undefined
      ? process.env
      : this.options.environment()
  }

  private streamCloseGraceMs(): number {
    return this.options.streamCloseGraceMs ?? DEFAULT_STREAM_CLOSE_GRACE_MS
  }
}

type SpawnOutcome =
  | { readonly child: ChildProcess; readonly failure?: undefined }
  | { readonly child?: undefined; readonly failure: string }

async function trySpawnGroup(
  request: CommandExecutionRequest,
  env: Readonly<Record<string, string | undefined>>,
): Promise<SpawnOutcome> {
  if (request.timeoutMs <= 0 || !Number.isFinite(request.timeoutMs)) {
    return { failure: 'timeoutMs must be a finite number greater than 0' }
  }

  let spawnFailure: unknown
  let child: ChildProcess
  try {
    child = spawn(request.argv[0]!, request.argv.slice(1), {
      cwd: request.cwd,
      env: sanitizeCommandEnvironment(env),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.once('error', (cause) => {
      spawnFailure = cause
    })
  } catch (cause) {
    return { failure: describe(cause) }
  }

  // A failed spawn reports its 'error' event asynchronously; wait one
  // macrotask before trusting the child exists.
  await new Promise<void>((resolveWait) => setImmediate(resolveWait))
  if (spawnFailure !== undefined || child.pid === undefined) {
    return { failure: describe(spawnFailure ?? 'no pid') }
  }
  return { child }
}

/** Resolves once the leader exits; a spawn failure resolves it too. */
function waitForLeaderExit(child: ChildProcess): Promise<{ code: number | null }> {
  return new Promise((resolveExit) => {
    child.once('exit', (code) => resolveExit({ code }))
    child.once('error', () => resolveExit({ code: null }))
  })
}

type StreamCapture = {
  closed(graceMs: number): Promise<boolean>
  result(): CapturedOutput
}

function captureStreams(child: ChildProcess): StreamCapture {
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  const stdout = trackStream(child.stdout, stdoutChunks)
  const stderr = trackStream(child.stderr, stderrChunks)

  return {
    async closed(graceMs) {
      const deadline = Date.now() + graceMs
      while (!stdout.closed || !stderr.closed) {
        if (Date.now() >= deadline) return false
        await sleep(Math.min(10, Math.max(1, deadline - Date.now())))
      }
      return true
    },
    result() {
      const stdoutBytes = concatChunks(stdoutChunks)
      const stderrBytes = concatChunks(stderrChunks)
      return {
        stdout: stdoutBytes,
        stderr: stderrBytes,
        outputDigest: commandOutputDigest(stdoutBytes, stderrBytes),
      }
    },
  }
}

function trackStream(stream: NodeJS.ReadableStream | null, chunks: Buffer[]): { closed: boolean } {
  const state = { closed: stream === null }
  if (stream === null) return state
  stream.on('data', (chunk: Buffer) => chunks.push(chunk))
  stream.once('close', () => {
    state.closed = true
  })
  return state
}

function concatChunks(chunks: readonly Buffer[]): Uint8Array {
  return chunks.length === 0 ? new Uint8Array(0) : Buffer.concat(chunks)
}

async function settledLeaderCode(
  leaderExit: Promise<{ code: number | null }>,
): Promise<number | null> {
  const settled = await withTimeout(leaderExit, LEADER_EXIT_GRACE_MS, { code: null })
  return settled.code
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  return Promise.race([promise, sleep(timeoutMs).then(() => fallback)])
}

type SettledCapture =
  | ({ readonly code: number | null; readonly failure?: undefined } & CapturedOutput)
  | { readonly failure: string; readonly code: number | null }

function sleepUntil(deadline: number): Promise<boolean> {
  return sleep(Math.max(0, deadline - Date.now())).then(() => false)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms)
    timer.unref()
  })
}

function settleFailed(message: string, exitCode: number | null): CommandExecution {
  return { status: 'settle-failed', message, exitCode }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
