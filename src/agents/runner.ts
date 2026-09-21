/**
 * The Visible Agent Runner seam (design.md §6, §17).
 *
 * Norn launches Worker and Reviewer Pi processes as visible agent invocations
 * the operator can inspect and steer. Behind this narrow interface an adapter
 * owns the real process: the production adapter opens a visible Herdr pane,
 * while the deterministic test adapter spawns plain node scripts — both
 * exercised through the identical settlement protocol implemented here:
 *
 *   settle := valid completion sidecar  ∧  complete process group exited
 *
 * Process exit without a sidecar is a protocol error. Operator interruption
 * before settlement is `blocked(user-abort)`; agent timeout and malformed
 * settlement are ticket-scoped errors for Work, while Ship and map-completion
 * reviewers take the scope of their enclosing operation (passed in by the
 * caller). The sidecar is never business evidence: only the typed
 * discriminants and codes leave this module.
 */
import type { Evidence, Outcome, OutcomeScope } from '../core/outcome.ts'
import { blocked, error, isOk, ok } from '../core/outcome.ts'

import type {
  AgentCompletion,
  AgentCompletionContext,
  ReviewerCompletion,
  WorkerCompletion,
} from './completion.ts'
import { CompletionStore } from './completion.ts'

/** Discriminates the two adapters; persisted inside `adapterHandle`. */
export type VisibleAgentRunnerKind = 'local-process' | 'herdr'

/**
 * A stable handle to one launched agent process group, persistable in
 * `ProcessGroupCheckpoint.adapterHandle` (design.md §13.1) so a recovering
 * coordinator can reattach to a live invocation.
 */
export type AttachedAgentProcess = {
  readonly kind: VisibleAgentRunnerKind
  readonly adapterHandle: string
}

export type AgentLaunchRequest = {
  readonly context: AgentCompletionContext
  readonly argv: readonly string[]
  readonly cwd: string
  /** Extra environment entries; the adapter supplies the base environment. */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * The narrow adapter seam every launch goes through. Adapters translate
 * `AttachedAgentProcess` into their own ownership mechanism (a detached POSIX
 * process group, or a Herdr pane) and throw only on adapter-level failure —
 * the settlement engine maps those to typed error outcomes.
 */
export interface VisibleAgentRunner {
  readonly kind: VisibleAgentRunnerKind
  /** Launch `argv` as one owned, visible agent invocation. */
  launch(request: AgentLaunchRequest): Promise<AttachedAgentProcess>
  /** Reconstruct a process reference from a persisted adapter handle. */
  attach(adapterHandle: string): AttachedAgentProcess
  /** Whether the invocation's process group is still live. */
  isLive(process: AttachedAgentProcess): Promise<boolean>
  /**
   * Wait for the complete process group to exit. `'timeout'` means the budget
   * elapsed while group members were still live.
   */
  waitForExit(process: AttachedAgentProcess, timeoutMs: number): Promise<'exited' | 'timeout'>
  /**
   * Terminate and settle the complete owned process group. `'terminated'`
   * proves no member remains; `'terminate-failed'` leaves the group state
   * unknown and unsets the invocation.
   */
  terminate(process: AttachedAgentProcess): Promise<'terminated' | 'terminate-failed'>
}

/** Closed outcome codes for the agent settlement protocol (design.md §17). */
export type AgentSettlementBlockCode = 'user-abort'

export type AgentSettlementErrorCode =
  | 'launch-failed'
  | 'agent-timeout'
  | 'protocol-error'
  | 'malformed-sidecar'
  | 'terminate-failed'
  | 'adapter-failure'

export type AgentSettlementOutcome<C extends AgentCompletion = AgentCompletion> = Outcome<
  SettledAgentInvocation<C>,
  AgentSettlementBlockCode,
  AgentSettlementErrorCode
>

/** A settled invocation: valid sidecar plus fully exited process group. */
export type SettledAgentInvocation<C extends AgentCompletion = AgentCompletion> = {
  readonly invocationId: string
  readonly completion: C
  readonly sidecarPath: string
  /**
   * `'settled'` proves the complete owned process group exited before this
   * value existed — the precondition for any tree fingerprinting.
   */
  readonly processGroup: { readonly state: 'settled'; readonly terminated: boolean }
}

export type WorkerSettlement = AgentSettlementOutcome<WorkerCompletion>
export type ReviewerSettlement = AgentSettlementOutcome<ReviewerCompletion>

/** Everything needed to launch and settle one agent invocation. */
export type AgentInvocationPlan = {
  readonly context: AgentCompletionContext
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  /** Wall-clock budget of one launched agent invocation (design.md §8). */
  readonly timeoutMs: number
  /** Scope of the enclosing operation: ticket for Work, per §17 otherwise. */
  readonly scope: OutcomeScope
}

/**
 * Launch and settle one agent invocation through `runner`. The completions
 * area and all bindings come from `plan.context`; a launch that cannot create
 * the owned process at all is `launch-failed`.
 */
export async function runAgentInvocation(
  runner: VisibleAgentRunner,
  plan: AgentInvocationPlan,
): Promise<AgentSettlementOutcome> {
  let processRef: AttachedAgentProcess
  try {
    processRef = await runner.launch({
      context: plan.context,
      argv: plan.argv,
      cwd: plan.cwd,
      env: plan.env,
    })
  } catch (cause) {
    return settlementError('launch-failed', plan.scope, plan.context.invocationId, [
      { launchFailure: describeAdapterFailure(cause) },
    ])
  }
  return settleAgentInvocation(runner, processRef, plan.context, plan.timeoutMs, plan.scope)
}

/**
 * Settle a launched (or reattached) agent invocation: wait for the complete
 * process group to exit within `timeoutMs`, then validate the sidecar.
 *
 * - group exit + valid sidecar → `ok`, with the group proven settled;
 * - group exit without a sidecar → `protocol-error`;
 * - unparseable, invalid, or binding-mismatched sidecar → `malformed-sidecar`;
 * - timeout whose group was successfully terminated → `agent-timeout`;
 * - termination that cannot prove group exit → `terminate-failed`.
 */
export async function settleAgentInvocation(
  runner: VisibleAgentRunner,
  processRef: AttachedAgentProcess,
  context: AgentCompletionContext,
  timeoutMs: number,
  scope: OutcomeScope,
): Promise<AgentSettlementOutcome> {
  const invocationId = context.invocationId
  let exit: 'exited' | 'timeout'
  try {
    exit = await runner.waitForExit(processRef, timeoutMs)
  } catch (cause) {
    return adapterFailure(scope, invocationId, cause)
  }

  if (exit === 'timeout') {
    let termination: 'terminated' | 'terminate-failed'
    try {
      termination = await runner.terminate(processRef)
    } catch (cause) {
      return adapterFailure(scope, invocationId, cause)
    }
    return termination === 'terminated'
      ? settlementError('agent-timeout', scope, invocationId, [
          { timeoutMs, processGroup: 'terminated-and-settled' },
        ])
      : settlementError('terminate-failed', scope, invocationId, [
          { timeoutMs, processGroup: 'unknown' },
        ])
  }

  const store = new CompletionStore(context.completionsDir)
  let read: Awaited<ReturnType<CompletionStore['read']>>
  try {
    read = await store.read(invocationId, context)
  } catch (cause) {
    return adapterFailure(scope, invocationId, cause)
  }

  if (read.status === 'missing') {
    return settlementError('protocol-error', scope, invocationId, [
      { processGroup: 'exited', sidecar: 'missing' },
    ])
  }
  if (read.status === 'invalid') {
    return settlementError('malformed-sidecar', scope, invocationId, [
      { processGroup: 'exited', sidecar: read.problem },
    ])
  }

  return ok({
    invocationId,
    completion: read.sidecar.completion,
    sidecarPath: store.pathFor(invocationId),
    processGroup: { state: 'settled', terminated: false },
  })
}

/**
 * Operator interruption before settlement (design.md §9, §17): terminate and
 * settle the whole owned group, then report `blocked(user-abort)`. Even a
 * sidecar that exists by the time the group settles does not convert an
 * explicit interrupt into an agent completion.
 */
export async function interruptAgentInvocation(
  runner: VisibleAgentRunner,
  processRef: AttachedAgentProcess,
  context: AgentCompletionContext,
  scope: OutcomeScope,
): Promise<InterruptOutcome> {
  const invocationId = context.invocationId
  let termination: 'terminated' | 'terminate-failed'
  try {
    termination = await runner.terminate(processRef)
  } catch (cause) {
    return adapterFailure(scope, invocationId, cause)
  }
  if (termination !== 'terminated') {
    return settlementError('terminate-failed', scope, invocationId, [
      { interrupt: 'user-abort', processGroup: 'unknown' },
    ])
  }
  return blocked({
    scope,
    code: 'user-abort',
    reason: `operator interrupted agent invocation ${invocationId} before settlement`,
    sharedWrite: 'none',
    evidence: [{ invocationId, processGroup: 'terminated-and-settled' }],
  })
}

export type InterruptOutcome = Outcome<null, AgentSettlementBlockCode, AgentSettlementErrorCode>

/**
 * One owned agent invocation of a Work attempt or later gate, as the
 * coordinator tracks it for the fingerprinting precondition: either settled
 * (a final settlement outcome exists) or still pending.
 */
export type OwnedInvocationState = {
  readonly invocationId: string
  readonly adapterHandle: string
  readonly settlement: AgentSettlementOutcome | undefined
}

/** Error codes whose settlement proves (or never created) the process group exited. */
const GROUP_PROVEN_EXITED: readonly AgentSettlementErrorCode[] = [
  'launch-failed',
  'agent-timeout',
  'protocol-error',
  'malformed-sidecar',
]

/**
 * The tree-fingerprinting precondition (design.md §10.2, §17): every process
 * group owned by the attempt must be settled — exited or terminated-and-settled
 * — before Norn fingerprints a final tree. A pending invocation, an outcome
 * after an adapter failure, or a failed termination leaves the state unknown
 * and forbids fingerprinting.
 */
export function fingerprintingPermitted(states: readonly OwnedInvocationState[]): boolean {
  return states.every((state) => {
    if (state.settlement === undefined) return false
    if (isOk(state.settlement)) return true
    return state.settlement.kind === 'error' && GROUP_PROVEN_EXITED.includes(state.settlement.code)
  })
}

function settlementError<T>(
  code: AgentSettlementErrorCode,
  scope: OutcomeScope,
  invocationId: string,
  facts: Evidence[],
): Outcome<T, AgentSettlementBlockCode, AgentSettlementErrorCode> {
  return error({ scope, code, reason: `agent invocation ${invocationId}: ${code}`, evidence: facts })
}

function adapterFailure<T>(
  scope: OutcomeScope,
  invocationId: string,
  cause: unknown,
): Outcome<T, AgentSettlementBlockCode, AgentSettlementErrorCode> {
  return settlementError<T>('adapter-failure', scope, invocationId, [
    { adapterFailure: describeAdapterFailure(cause) },
  ])
}

function describeAdapterFailure(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`
  return String(cause)
}
