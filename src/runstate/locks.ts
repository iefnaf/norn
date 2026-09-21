/**
 * OS-backed advisory locks under repository home (design.md §16).
 *
 * Norn uses three lock files under `<repository-home>/locks/`: one map lock
 * per Task Map (a second live coordinator for the same map is excluded), one
 * short-held repository control lock, and one target lock per repository and
 * branch (Ship is serialized across every active map).
 *
 * Node exposes no `flock(2)`, so each lock is held by a tiny helper process
 * (perl or python3, whichever the platform provides) that opens the lock file
 * and takes an exclusive non-blocking `flock` on it, then blocks reading its
 * stdin until the coordinator closes the pipe. This gives exactly the
 * semantics the design requires:
 *
 * - the lock auto-releases when the owning coordinator exits, however it dies
 *   (the kernel closes the pipe write end, the helper sees EOF and exits, the
 *   kernel drops its flock);
 * - child agents and commands never hold or inherit the lock: the coordinator
 *   itself holds no lock file descriptor at all, only a pipe that Node never
 *   passes to spawned children, and the helper opens its descriptor
 *   close-on-exec and spawns nothing;
 * - contention is decided by the kernel's flock, not by file-existence races.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { blocked, error, ok } from '../core/outcome.ts'
import type { Outcome } from '../core/outcome.ts'
import {
  controlLockPath,
  mapLockPath,
  targetLockPath,
} from '../config/paths.ts'

export type LockBlockCode = 'lock-held'
export type LockErrorCode = 'lock-failed'

export type LockOutcome = Outcome<HeldLock, LockBlockCode, LockErrorCode>

/** A lock held by this process; released exactly once. */
export type HeldLock = {
  readonly path: string
  /**
   * Release the lock: closes the holder's pipe and resolves once the helper
   * has exited, so the flock is provably dropped. Rejects as an error when
   * the holder already died unexpectedly — the lock is no longer held.
   */
  release(): Promise<Outcome<void, never, LockErrorCode>>
}

export type AcquireOptions = {
  /** How long to keep retrying a contended lock; 0 (default) tries once. */
  readonly waitMs?: number
  /** Retry interval while waiting; also the helper-startup poll interval. */
  readonly pollMs?: number
  /** Upper bound on waiting for one helper to report in, per attempt. */
  readonly startupTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// Lock programs executed by an external interpreter
// ---------------------------------------------------------------------------

/**
 * Perl holder: sysopen the lock file, flock it exclusively and
 * non-blocking, report the result on stdout, then sleep on stdin until the
 * coordinator closes the pipe (release or coordinator death) and exit — the
 * kernel then drops the flock.
 */
const PERL_PROGRAM = [
  'use Fcntl qw(:flock O_RDWR O_CREAT);',
  '$| = 1;',
  'my $fd;',
  'unless (sysopen($fd, $ARGV[0], O_RDWR | O_CREAT, 0644)) { print "open-error\\n"; exit 2; }',
  'unless (flock($fd, LOCK_EX | LOCK_NB)) { print "held\\n"; exit 1; }',
  'print "acquired\\n";',
  'while (read(STDIN, my $buf, 4096)) {}',
  'exit 0;',
].join(' ')

/**
 * Python holder with identical semantics (used when perl is unavailable).
 * The descriptor is opened with O_CLOEXEC; perl's sysopen sets FD_CLOEXEC on
 * capable platforms, and neither holder spawns children in any case.
 */
const PYTHON_PROGRAM = [
  'import os, sys, fcntl',
  'path = sys.argv[1]',
  'try:',
  '    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o644)',
  'except OSError:',
  '    print("open-error"); sys.exit(2)',
  'try:',
  '    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)',
  'except OSError:',
  '    print("held"); sys.exit(1)',
  'print("acquired"); sys.stdout.flush()',
  'while sys.stdin.buffer.read(4096):',
  '    pass',
  'sys.exit(0)',
].join('\n')

type Interpreter = { readonly command: string; readonly program: string; readonly pathArgIndex: number }

const INTERPRETERS: readonly Interpreter[] = [
  { command: 'perl', program: PERL_PROGRAM, pathArgIndex: 0 },
  { command: 'python3', program: PYTHON_PROGRAM, pathArgIndex: 1 },
]

/** Resolved interpreter, cached once it has proven runnable on this host. */
let cachedInterpreter: Interpreter | undefined

class HolderProcess {
  readonly child: ChildProcess

  constructor(child: ChildProcess) {
    this.child = child
  }
}

function spawnHolder(lockPath: string, startupTimeoutMs: number): Promise<Outcome<HolderProcess, LockBlockCode, LockErrorCode>> {
  return new Promise((resolvePromise) => {
    const candidates = cachedInterpreter === undefined ? INTERPRETERS : [cachedInterpreter]

    const attempt = (index: number): void => {
      const interpreter = candidates[index]
      if (interpreter === undefined) {
        resolvePromise(
          error({
            scope: 'operation',
            code: 'lock-failed',
            reason: 'no lock-holder interpreter is available (need perl or python3 on PATH)',
          }),
        )
        return
      }

      let child: ChildProcess
      try {
        child = spawn(interpreter.command, ['-e', interpreter.program, lockPath], {
          stdio: ['pipe', 'pipe', 'ignore'],
        })
      } catch (cause) {
        resolvePromise(
          error({
            scope: 'operation',
            code: 'lock-failed',
            reason: `failed to spawn the lock holder: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
        )
        return
      }

      let settled = false
      let output = ''

      const finish = (result: Outcome<HolderProcess, LockBlockCode, LockErrorCode>): void => {
        if (settled) return
        settled = true
        clearTimeout(startupTimer)
        resolvePromise(result)
      }

      const tryNext = (why: string): void => {
        if (settled) return
        if (cachedInterpreter === undefined && index + 1 < candidates.length) {
          // The interpreter itself is unusable (ENOENT); try the next one.
          clearTimeout(startupTimer)
          attempt(index + 1)
          return
        }
        finish(
          error({
            scope: 'operation',
            code: 'lock-failed',
            reason: `lock holder failed to start: ${why}`,
          }),
        )
      }

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        output += chunk
        const line = output.split('\n')[0]
        if (line === 'acquired') {
          cachedInterpreter = interpreter
          finish(ok(new HolderProcess(child)))
        } else if (line === 'held') {
          cachedInterpreter = interpreter
          finish(
            blocked({
              scope: 'operation',
              code: 'lock-held',
              reason: `the lock at ${lockPath} is held by a live process`,
            }),
          )
          child.stdin?.end()
          child.kill()
        } else if (line === 'open-error') {
          finish(
            error({
              scope: 'operation',
              code: 'lock-failed',
              reason: `the lock file at ${lockPath} could not be opened`,
            }),
          )
          child.kill()
        }
      })
      child.on('error', (cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') tryNext(`interpreter "${interpreter.command}" not found`)
        else tryNext(cause.message)
      })
      child.on('exit', () => {
        if (!settled) tryNext(`the lock holder exited before reporting (${output.trim()})`)
      })

      const startupTimer = setTimeout(() => {
        child.kill()
        finish(
          error({
            scope: 'operation',
            code: 'lock-failed',
            reason: `the lock holder did not report within ${startupTimeoutMs}ms`,
          }),
        )
      }, startupTimeoutMs)
    }

    attempt(0)
  })
}

function makeHeldLock(holder: HolderProcess, path: string): HeldLock {
  let released = false
  let holderDied = false
  holder.child.on('exit', () => {
    holderDied = true
  })
  return {
    path,
    release: async () => {
      if (released) {
        return error({ scope: 'operation', code: 'lock-failed', reason: 'lock already released' })
      }
      released = true
      if (holderDied) {
        return error({
          scope: 'operation',
          code: 'lock-failed',
          reason: 'the lock holder exited unexpectedly; the lock is no longer held',
        })
      }
      await closeAndWait(holder.child)
      // Exit code 0 after stdin EOF is the normal release path; anything else
      // means the holder died for another reason while we believed we held it.
      if (holder.child.exitCode !== 0 || holder.child.signalCode !== null) {
        return error({
          scope: 'operation',
          code: 'lock-failed',
          reason: `the lock holder exited abnormally while releasing (code ${holder.child.exitCode}, signal ${holder.child.signalCode ?? 'none'})`,
        })
      }
      return ok(undefined)
    },
  }
}

function closeAndWait(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => {
    let stdinClosed = false
    let exited = false
    const maybeResolve = (): void => {
      if (stdinClosed && exited) resolvePromise()
    }
    child.stdin?.end(() => {
      stdinClosed = true
      maybeResolve()
    })
    if (child.stdin === null) {
      stdinClosed = true
      maybeResolve()
    }
    child.once('exit', () => {
      exited = true
      maybeResolve()
    })
    // The holder may already have exited before release was requested.
    if (child.exitCode !== null || child.signalCode !== null) {
      exited = true
      maybeResolve()
    }
  })
}

/**
 * Acquire one OS-backed advisory lock at `path`. With `waitMs > 0` a held
 * lock is retried until the budget elapses; `lock-held` after the wait is a
 * blocked outcome, and infrastructure failures are `lock-failed` errors.
 */
export async function acquireLock(path: string, options: AcquireOptions = {}): Promise<LockOutcome> {
  if (process.platform === 'win32') {
    return error({
      scope: 'operation',
      code: 'lock-failed',
      reason: 'OS-backed locks require a POSIX platform',
    })
  }
  const waitMs = options.waitMs ?? 0
  const pollMs = options.pollMs ?? 25
  const startupTimeoutMs = options.startupTimeoutMs ?? 10_000
  const deadline = Date.now() + waitMs
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch (cause) {
    return error({
      scope: 'operation',
      code: 'lock-failed',
      reason: `could not create the lock directory: ${cause instanceof Error ? cause.message : String(cause)}`,
    })
  }

  for (;;) {
    const outcome = await spawnHolder(path, startupTimeoutMs)
    if (outcome.kind === 'ok') return ok(makeHeldLock(outcome.value, path))
    if (outcome.kind === 'blocked') {
      if (Date.now() >= deadline) return outcome
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
      continue
    }
    return outcome
  }
}

/**
 * Whether the lock at `path` is currently held by a live process. Creates no
 * files: a missing lock file means provably not held.
 */
export async function isLockHeld(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  const outcome = await acquireLock(path, { waitMs: 0 })
  if (outcome.kind === 'ok') {
    await outcome.value.release()
    return false
  }
  return outcome.kind === 'blocked'
}

/**
 * The map lock: one live coordinator per Task Map (§16). Try-only — a second
 * live coordinator gets an immediate `lock-held`, it never waits.
 */
export function acquireMapLock(repositoryHome: string, encodedIssueId: string): Promise<LockOutcome> {
  return acquireLock(mapLockPath(repositoryHome, encodedIssueId))
}

/** Whether a live coordinator currently holds this map's lock. */
export async function isMapLockHeld(repositoryHome: string, encodedIssueId: string): Promise<boolean> {
  return isLockHeld(mapLockPath(repositoryHome, encodedIssueId))
}

/**
 * The repository control lock (§16): short-held, for atomic active-run
 * registration, extension ticket claims, configuration replacement, and slot
 * accounting. Waits briefly for a current holder.
 */
export async function acquireControlLock(
  repositoryHome: string,
  options: AcquireOptions = {},
): Promise<LockOutcome> {
  return acquireLock(controlLockPath(repositoryHome), {
    waitMs: options.waitMs ?? 10_000,
    pollMs: options.pollMs,
    startupTimeoutMs: options.startupTimeoutMs,
  })
}

/**
 * The target lock: per repository and branch, serializing Ship across every
 * active map (§16). Waits while another coordinator ships.
 */
export function acquireTargetLock(
  repositoryHome: string,
  branch: string,
  options: AcquireOptions = {},
): Promise<LockOutcome> {
  return acquireLock(targetLockPath(repositoryHome, branch), {
    waitMs: options.waitMs ?? 0,
    pollMs: options.pollMs,
    startupTimeoutMs: options.startupTimeoutMs,
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
