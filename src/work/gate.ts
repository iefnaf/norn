/**
 * The protocol-valid command check (design.md §10.2).
 *
 * Configured setup and test commands execute sequentially in Run Config
 * order and stop at the first non-pass. A command execution counts only when
 * its complete process group has settled — exited, or terminated and settled
 * after timeout — before repository inspection, and the repository still
 * holds the commit and tree expected for that phase with no staged or
 * unstaged tracked changes and no non-ignored untracked files:
 *
 * - a protocol-valid command **passes** only when it exits with code zero
 *   before timeout;
 * - a clean non-zero exit, or a timeout whose process group was successfully
 *   terminated, is **structured feedback**, never machine evidence;
 * - failure to start or settle a command, or any unexpected repository
 *   mutation, is a **protocol error**.
 *
 * Ignored dependency and cache directories may remain — `git status
 * --porcelain` never lists them — but they are not part of evidence.
 */
import type { GitCommandRunner } from '../adapters/git-repository.ts'
import type { GitObjectOid } from '../agents/completion.ts'
import type { RunConfigCommand } from '../config/run-config.ts'
import { error, ok } from '../core/outcome.ts'
import type { Evidence, Outcome, OutcomeScope } from '../core/outcome.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'

import type { CapturedOutput, CommandRunner } from './command-runner.ts'
import { inspectWorkspace } from './workspace.ts'

/** The gate workspace a command runs in, with the state expected of it. */
export type GateWorkspace = {
  /** Working directory of the command: the active gate workspace (§8). */
  readonly path: string
  /** The commit `HEAD` must still equal after the command settles (§10.2). */
  readonly expectedHead: GitObjectOid
  /** The tree OID that must be unchanged after the command settles (§10.2). */
  readonly expectedTreeOid: GitObjectOid
}

/** Closed error codes of the protocol-valid command check. */
export type GateCommandErrorCode =
  | 'command-launch-failed'
  | 'command-settle-failed'
  | 'workspace-inspection-failed'
  | 'command-protocol'

/** One protocol-valid pass: exit code zero before timeout. */
export type GateCommandPass = {
  readonly status: 'pass'
  readonly argv: readonly string[]
  readonly timeoutMs: number
  readonly exitCode: 0
} & CapturedOutput

/**
 * One protocol-valid non-pass: structured feedback for the next worker
 * round — a clean non-zero exit, or a timeout whose process group was
 * successfully terminated and settled.
 */
export type GateCommandFeedback = {
  readonly status: 'feedback'
  readonly cause: 'non-zero-exit' | 'timeout-terminated'
  readonly argv: readonly string[]
  readonly timeoutMs: number
  readonly exitCode: number | null
} & CapturedOutput

export type GateCommandValue = GateCommandPass | GateCommandFeedback

export type GateCommandOutcome = Outcome<GateCommandValue, never, GateCommandErrorCode>

export type GateDeps = {
  /** The Command runner seam (design.md §6). */
  readonly runner: CommandRunner
  /** The injectable git seam used for repository inspection. */
  readonly git: GitCommandRunner
}

export type RunGateCommandParams = {
  readonly command: RunConfigCommand
  readonly workspace: GateWorkspace
  /** Scope of the enclosing operation; Work commands are ticket-scoped. */
  readonly scope?: OutcomeScope
}

/**
 * Execute one configured command in the gate workspace and apply the
 * protocol-valid checks of design.md §10.2. The command runner settles the
 * complete process group before this function inspects the repository, so
 * the result never counts against an unsettled group; a mutation of HEAD,
 * the tree, or cleanliness turns the result into a protocol error rather
 * than feedback.
 */
export async function runGateCommand(
  deps: GateDeps,
  params: RunGateCommandParams,
): Promise<GateCommandOutcome> {
  const scope = params.scope ?? 'ticket'
  const execution = await deps.runner.execute({
    argv: params.command.argv,
    cwd: params.workspace.path,
    timeoutMs: params.command.timeoutMs,
  })

  if (execution.status === 'launch-failed') {
    return gateError(scope, 'command-launch-failed', params.command, [
      { failure: execution.message },
    ])
  }
  if (execution.status === 'settle-failed') {
    // The group's state is unknown: the workspace is uninspectable and no
    // result may count (design.md §10.2).
    return gateError(scope, 'command-settle-failed', params.command, [
      { failure: execution.message, exitCode: execution.exitCode },
    ])
  }

  // The complete process group is settled by contract; only now may the
  // repository be inspected.
  const inspection = await inspectWorkspace(deps.git, params.workspace.path)
  if (inspection.status !== 'ok') {
    return gateError(scope, 'workspace-inspection-failed', params.command, [
      { failure: inspection.message },
    ])
  }

  const mutations: Record<string, CanonicalJsonValue> = {}
  if (inspection.state.head !== params.workspace.expectedHead) {
    mutations.head = { expected: params.workspace.expectedHead, actual: inspection.state.head }
  }
  if (inspection.state.headTree !== params.workspace.expectedTreeOid) {
    mutations.headTree = {
      expected: params.workspace.expectedTreeOid,
      actual: inspection.state.headTree,
    }
  }
  if (inspection.state.status.length !== 0) {
    mutations.status = inspection.state.status
  }
  if (Object.keys(mutations).length !== 0) {
    return gateError(scope, 'command-protocol', params.command, [mutations])
  }

  if (execution.status === 'timeout-terminated') {
    return ok({
      status: 'feedback',
      cause: 'timeout-terminated',
      argv: params.command.argv,
      timeoutMs: params.command.timeoutMs,
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      outputDigest: execution.outputDigest,
    })
  }
  if (execution.exitCode !== 0) {
    return ok({
      status: 'feedback',
      cause: 'non-zero-exit',
      argv: params.command.argv,
      timeoutMs: params.command.timeoutMs,
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      outputDigest: execution.outputDigest,
    })
  }
  return ok({
    status: 'pass',
    argv: params.command.argv,
    timeoutMs: params.command.timeoutMs,
    exitCode: 0,
    stdout: execution.stdout,
    stderr: execution.stderr,
    outputDigest: execution.outputDigest,
  })
}

/** One executed entry of a configured command list. */
export type GateCommandListEntry = {
  /** Zero-based position in the configured list — `TestEvidence.testIndex`. */
  readonly index: number
  readonly command: RunConfigCommand
  readonly result: GateCommandValue
}

export type GateCommandListValue = {
  readonly entries: readonly GateCommandListEntry[]
  /** Index of the first non-pass when the list stopped early, else `null`. */
  readonly stoppedAtIndex: number | null
}

export type GateCommandListOutcome = Outcome<GateCommandListValue, never, GateCommandErrorCode>

export type RunGateCommandListParams = {
  /** The configured command list, in Run Config order (design.md §8, §10.2). */
  readonly commands: readonly RunConfigCommand[]
  readonly workspace: GateWorkspace
  readonly scope?: OutcomeScope
}

/**
 * Execute a configured command list sequentially in Run Config order,
 * stopping at the first non-pass (design.md §10.2). Passes accumulate with
 * their framed output digests; the first non-pass — structured feedback or a
 * protocol error — ends the list. Every entry is protocol-valid before it is
 * recorded, so an entry exists only for a settled, unmutated repository.
 */
export async function runGateCommandList(
  deps: GateDeps,
  params: RunGateCommandListParams,
): Promise<GateCommandListOutcome> {
  const entries: GateCommandListEntry[] = []
  for (const [index, command] of params.commands.entries()) {
    const outcome = await runGateCommand(deps, { command, workspace: params.workspace, scope: params.scope })
    if (outcome.kind !== 'ok') return outcome
    entries.push({ index, command, result: outcome.value })
    if (outcome.value.status !== 'pass') {
      return ok({ entries, stoppedAtIndex: index })
    }
  }
  return ok({ entries, stoppedAtIndex: null })
}

function gateError(
  scope: OutcomeScope,
  code: GateCommandErrorCode,
  command: RunConfigCommand,
  evidence: readonly Evidence[],
): GateCommandOutcome {
  return error({
    scope,
    code,
    reason: `gate command [${command.argv.join(' ')}]: ${code}`,
    sharedWrite: 'none',
    evidence: [...evidence],
  })
}
