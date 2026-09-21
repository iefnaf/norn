/**
 * The Work round gate (design.md §10.2, ticket #9).
 *
 * One Ticket taken from eligible to sealed:
 *
 * ```text
 * record Work attempt and reserve one slot
 *     ↓
 * create branch and workspace at exact Wave base
 *     ↓
 * run initial setup; retain a clean non-pass as worker feedback
 *     ↓
 * repeat at most maxWorkRounds times:
 *     run one fresh visible worker invocation with accumulated feedback
 *         ↓
 *     settle it and verify the candidate branch, commit, tree, and cleanliness
 *         ↓
 *     run setup commands again at the candidate tree
 *         ↓
 *     run the complete configured test list
 *         ↓
 *     run one fresh independent read-only reviewer
 *         ↓
 *     on clean setup/test failure or reviewer iterate: add feedback and repeat
 *     on reviewer pass: verify again and seal Shippable Change in Run State
 * ```
 *
 * Orchestration is a pure-ish function over injected seams — Visible Agent
 * Runner, Command runner, git, a Run-State-backed attempt store, and the
 * Work-slot seam — so tests drive fake workers, reviewers, and repositories
 * deterministically. The seams are exactly the ones the earlier tickets
 * built: agent settlement (`src/agents/runner.ts`), the §10.2 command gate
 * (`src/work/gate.ts`), workspace creation (`src/work/workspace.ts`), and
 * Run State plus the slot registry (`src/runstate/`).
 *
 * Crash-safety rules enforced here (§10.2, §16): the attempt's round counter
 * and a `launch-intent` process-group checkpoint are persisted *before* each
 * worker process is created, so a crash cannot reset the round budget or
 * create an unidentifiable child. Test and review evidence is built fresh
 * within each round; nothing from an earlier round enters a sealed
 * `ShippableChange`, and a later round starts from the previous round's
 * clean candidate commit. All outcome values are typed per §9: worker and
 * reviewer blocks, specification contradiction, exhausted rounds, and child
 * interruption are ticket-scoped `blocked`; launch/settle failures and
 * attempt-local invariant violations are ticket-scoped `error`; Run State
 * and slot-registry failures are run-scoped `error`. Every non-`ok` outcome
 * here has `sharedWrite: 'none'` — Work never performs a shared write.
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'

import { canonicalJson } from '../core/canonical-json.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'
import { canonicalJsonDigest } from '../core/digest.ts'
import { blocked, error, ok } from '../core/outcome.ts'
import type { Evidence, Outcome } from '../core/outcome.ts'

import type { RunConfigAgentRole, RunConfigCommand } from '../config/run-config.ts'
import { encodePathSegment } from '../config/paths.ts'
import type { GitCommandRunner } from '../adapters/git-repository.ts'
import { AGENT_COMPLETION_SCHEMA } from '../agents/completion.ts'
import type {
  AgentCompletionContext,
  AgentMapBinding,
  AgentWorkBinding,
  AgentWorkInputBinding,
  GitObjectOid,
  ReviewerCompletion,
  WorkerCompletion,
} from '../agents/completion.ts'
import { NORN_AGENT_CONTEXT_ENV, NORN_COMPLETE_TOOL_NAME } from '../agents/completion-extension.ts'
import { herdrAgentName, planAgentPiArgv } from '../agents/herdr-runner.ts'
import { interruptAgentInvocation, settleAgentInvocation } from '../agents/runner.ts'
import type {
  AgentSettlementBlockCode,
  AgentSettlementErrorCode,
  AttachedAgentProcess,
  SettledAgentInvocation,
  VisibleAgentRunner,
} from '../agents/runner.ts'
import { releaseWorkSlot, reserveWorkSlot } from '../runstate/slot-registry.ts'
import type {
  ProcessGroupLivenessProbe,
  ReleaseOutcome,
  ReserveOutcome,
  WorkSlotReservation,
} from '../runstate/slot-registry.ts'
import { loadRunState, saveRunState } from '../runstate/run-state-store.ts'
import type {
  EffectiveTicketSpec,
  ProcessGroupCheckpoint,
  ReviewEvidence,
  ShippableChange,
  TestEvidence,
  TicketRef,
  WorkAttemptCheckpoint,
  WorkInput,
  WorkspaceRef,
} from '../runstate/types.ts'

import type { CommandRunner } from './command-runner.ts'
import type { GateCommandErrorCode, GateCommandListValue, GateDeps } from './gate.ts'
import { runGateCommandList } from './gate.ts'
import { ticketBranch, ticketWorkspaceDir } from './naming.ts'
import { createTicketWorkspace, inspectWorkspace, parseGitObjectOid } from './workspace.ts'
import type { WorkspaceErrorCode } from './workspace.ts'

// ---------------------------------------------------------------------------
// Outcome vocabulary (§9, §10.2)
// ---------------------------------------------------------------------------

/** Closed block codes of the Work round gate. All ticket-scoped (§10.2). */
export type WorkBlockCode =
  /** A typed worker `block` handoff carrying a closed machine code. */
  | 'worker-block'
  /** A typed reviewer `block` verdict carrying a closed machine code. */
  | 'reviewer-block'
  /** The persisted attempt binds a Work input that contradicts this one. */
  | 'spec-contradiction'
  /** `maxWorkRounds` worker invocations were used without a passing round. */
  | 'work-rounds-exhausted'
  /** A child agent invocation was interrupted before settlement (§17). */
  | 'user-abort'
  /** The repository-wide Work capacity is fully charged (§8, §16). */
  | 'slot-unavailable'

/** Closed error codes of the Work round gate; scope is fixed per code (§9). */
export type WorkErrorCode =
  | AgentSettlementErrorCode
  | GateCommandErrorCode
  | WorkspaceErrorCode
  /** The coordinator-generated base-to-candidate diff could not be read. */
  | 'diff-failed'
  /** The settled candidate violated the owned-branch/lineage/cleanliness rules. */
  | 'candidate-verification'
  /** The handoff's claimed OIDs differ from Norn's independent reads. */
  | 'handoff-mismatch'
  /** The workspace changed between reviewer pass and sealing. */
  | 'reviewer-verification'
  /** The sealed change failed the independent seal check (§10.3). */
  | 'seal-verification'
  /** The reviewer launch plan exposes write-capable tools. */
  | 'reviewer-not-read-only'
  /** Run State persistence failed — run-scoped (§9). */
  | 'control-store'
  /** The Work-slot registry or its lock failed — run-scoped (§9). */
  | 'slot-registry'

/** The outcome of one complete Work attempt: sealed, parked, or run-stopping. */
export type WorkOutcome = Outcome<ShippableChange, WorkBlockCode, WorkErrorCode>

// ---------------------------------------------------------------------------
// Launch planning: what each agent invocation receives
// ---------------------------------------------------------------------------

/** One structured feedback entry accumulated across rounds (§10.2). */
export type RoundFeedback =
  | {
      readonly kind: 'setup'
      /** Round the failure belongs to; 0 marks the attempt's initial setup. */
      readonly round: number
      readonly origin: 'initial' | 'candidate'
      readonly argv: readonly string[]
      readonly cause: 'non-zero-exit' | 'timeout-terminated'
      readonly exitCode: number | null
      readonly stdout: string
      readonly stderr: string
    }
  | {
      readonly kind: 'tests'
      readonly round: number
      readonly testIndex: number
      readonly argv: readonly string[]
      readonly cause: 'non-zero-exit' | 'timeout-terminated'
      readonly exitCode: number | null
      readonly stdout: string
      readonly stderr: string
    }
  | {
      readonly kind: 'review'
      readonly round: number
      readonly feedback: string
    }

/** What the worker invocation is launched with, beyond its bound context. */
export type WorkerLaunchInput = {
  readonly round: number
  /** The previous round's clean candidate commit, or null at the base. */
  readonly previousCandidateCommit: GitObjectOid | null
  /** Every structured feedback entry accumulated so far, in order. */
  readonly feedback: readonly RoundFeedback[]
}

/** The captured output of one passing test, handed to the reviewer. */
export type ReviewerTestOutput = {
  readonly testIndex: number
  readonly argv: readonly string[]
  readonly stdout: string
  readonly stderr: string
  readonly outputDigest: string
}

/** Everything the independent reviewer judges (§10.2). */
export type ReviewerLaunchInput = {
  readonly spec: EffectiveTicketSpec
  readonly target: { readonly branch: string; readonly baseSha: GitObjectOid; readonly baseTreeOid: GitObjectOid }
  readonly candidate: {
    readonly commit: GitObjectOid
    readonly treeOid: GitObjectOid
    readonly zeroDelta: boolean
  }
  /** The coordinator-generated base-to-candidate diff. */
  readonly diff: string
  /** The ordered successful test evidence of this round. */
  readonly tests: readonly TestEvidence[]
  /** The captured output of those tests, in configuration order. */
  readonly testOutput: readonly ReviewerTestOutput[]
}

/** One planned agent process launch: an argv plus optional environment. */
export type AgentLaunchPlan = {
  readonly argv: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

export type WorkerLaunchPlanner = (input: WorkerLaunchInput) => AgentLaunchPlan
export type ReviewerLaunchPlanner = (input: ReviewerLaunchInput) => AgentLaunchPlan

/**
 * The read-only tool allowlist of every reviewer invocation (§3, §10.2):
 * read-capable built-ins plus the completion tool the settlement protocol
 * requires. Write-capable built-ins (`bash`, `powershell`, `edit`, `write`)
 * are never present.
 */
export const REVIEWER_READ_ONLY_TOOLS: readonly string[] = [
  'read',
  'grep',
  'find',
  'ls',
  NORN_COMPLETE_TOOL_NAME,
]

/** Built-in Pi tools that can modify the repository or the host. */
export const WRITE_CAPABLE_TOOLS: readonly string[] = ['bash', 'powershell', 'edit', 'write']

/**
 * Whether an agent argv is read-only: it must carry a `--tools` allowlist
 * that contains no write-capable tool and still exposes the completion tool
 * (without which the invocation could never settle). The Work layer owns
 * this policy (§10.2); the agent runner only launches what it is given.
 */
export function isReadOnlyAgentArgv(argv: readonly string[]): boolean {
  const index = argv.indexOf('--tools')
  if (index === -1 || index + 1 >= argv.length) return false
  const tools = argv[index + 1]!
    .split(',')
    .map((tool) => tool.trim())
    .filter((tool) => tool !== '')
  if (tools.length === 0) return false
  if (tools.some((tool) => WRITE_CAPABLE_TOOLS.includes(tool))) return false
  return tools.includes(NORN_COMPLETE_TOOL_NAME)
}

/** The runstate-shaped evidence list digest (§10.3): order is significant. */
function orderedTestEvidenceDigest(tests: readonly TestEvidence[]): string {
  return canonicalJsonDigest(tests as CanonicalJsonValue)
}

/** The provider of a `provider/model` ID: everything before the first slash. */
export function modelProvider(modelId: string): string {
  const slash = modelId.indexOf('/')
  return slash === -1 ? modelId : modelId.slice(0, slash)
}

function renderWorkerPrompt(input: WorkerLaunchInput): string {
  const brief = {
    schema: 'norn-worker-brief:v1',
    round: input.round,
    previousCandidateCommit: input.previousCandidateCommit,
    feedback: input.feedback,
  }
  return (
    'You are the Norn Worker for this Ticket. The launch context bound in NORN_AGENT_CONTEXT ' +
    'carries the Effective Ticket Spec and the exact target base. Amend the attempt-owned ' +
    'branch in this workspace; finish with the norn_complete tool, handing off either your ' +
    'candidate commit and tree OIDs or a typed block. Round briefing (JSON):\n' +
    canonicalJson(brief as CanonicalJsonValue)
  )
}

/**
 * The production worker launch plan: the configured Pi model with the
 * completion extension, plus the round briefing as the initial prompt. The
 * worker's specification arrives through the completion context
 * (`NORN_AGENT_CONTEXT`), which every adapter injects.
 */
export function piWorkerLaunch(
  input: WorkerLaunchInput,
  options: {
    readonly model: string
    readonly thinking: string
    readonly extensionPath: string
    readonly piSessionId: string
  },
): AgentLaunchPlan {
  return {
    argv: [
      ...planAgentPiArgv(
        { model: options.model, thinking: options.thinking },
        { extensionPath: options.extensionPath, piSessionId: options.piSessionId },
      ),
      renderWorkerPrompt(input),
    ],
  }
}

function renderReviewerPrompt(input: ReviewerLaunchInput): string {
  const brief = {
    schema: 'norn-review-brief:v1',
    spec: input.spec,
    target: input.target,
    candidate: input.candidate,
    tests: input.tests,
    testOutput: input.testOutput,
  }
  return (
    'You are the independent Norn Reviewer. You have read-only tools. Judge whether the ' +
    'candidate satisfies the open Ticket against the bound base and complete candidate ' +
    'tree, using the coordinator-generated diff and the ordered test evidence. ' +
    (input.candidate.zeroDelta
      ? 'This is a zero-delta candidate: the tree equals the base tree, so judge the ' +
        'assertion that the existing target already satisfies the Ticket. '
      : '') +
    'Finish with the norn_complete tool: pass, iterate with feedback, or a typed block. ' +
    'Review briefing (JSON):\n' +
    canonicalJson(brief as CanonicalJsonValue) +
    '\nCoordinator-generated diff:\n' +
    input.diff
  )
}

/**
 * The production reviewer launch plan: the configured Pi model with the
 * completion extension and the strict read-only tool allowlist of §10.2.
 * Write-capable built-ins are absent, so the reviewer cannot modify the
 * repository it judges.
 */
export function piReadOnlyReviewerLaunch(
  input: ReviewerLaunchInput,
  options: {
    readonly model: string
    readonly thinking: string
    readonly extensionPath: string
    readonly piSessionId: string
  },
): AgentLaunchPlan {
  return {
    argv: [
      ...planAgentPiArgv(
        { model: options.model, thinking: options.thinking },
        { extensionPath: options.extensionPath, piSessionId: options.piSessionId },
      ),
      '--tools',
      REVIEWER_READ_ONLY_TOOLS.join(','),
      renderReviewerPrompt(input),
    ],
  }
}

// ---------------------------------------------------------------------------
// The injected seams
// ---------------------------------------------------------------------------

/** The repository-wide Work-slot seam (§8, §16). */
export interface WorkSlotSeam {
  reserve(): Promise<ReserveOutcome>
  release(): Promise<ReleaseOutcome>
}

/** What the gate persists for one live attempt. */
export type WorkAttemptRecord = {
  readonly attempt: WorkAttemptCheckpoint
  readonly processes: readonly ProcessGroupCheckpoint[]
}

/** The terminal record the gate persists for one attempt. */
export type WorkAttemptTerminal =
  | { readonly kind: 'sealed'; readonly change: ShippableChange }
  | {
      readonly kind: 'parked'
      readonly ticket: TicketRef
      readonly workspace?: WorkspaceRef
      readonly outcome: {
        readonly kind: 'blocked' | 'error'
        readonly code: string
        readonly reason: string
        readonly evidence: readonly Evidence[]
      }
    }

/**
 * The Run-State-backed attempt store. `load` returns the persisted *working*
 * checkpoint for the attempt — the resume input — or `undefined` when no
 * live attempt is recorded. Implementations persist atomically; failures are
 * run-scoped `control-store` errors (§9).
 */
export interface RoundGateStore {
  load(workAttemptId: string): Promise<Outcome<WorkAttemptRecord | undefined, never, 'control-store'>>
  saveWorking(record: WorkAttemptRecord): Promise<Outcome<void, never, 'control-store'>>
  saveTerminal(
    workAttemptId: string,
    terminal: WorkAttemptTerminal,
    processes: readonly ProcessGroupCheckpoint[],
  ): Promise<Outcome<void, never, 'control-store'>>
}

/** Everything one Work attempt needs, beyond its injected seams. */
export type RoundGateDeps = {
  /** The Visible Agent Runner seam (§6, §17). */
  readonly runner: VisibleAgentRunner
  /** The Command runner seam (§6, §10.2). */
  readonly commands: CommandRunner
  /** The injectable git seam used for candidate verification and the diff. */
  readonly git: GitCommandRunner
  /** The Run-State-backed attempt store. */
  readonly store: RoundGateStore
  /** The repository-wide Work-slot seam. */
  readonly slots: WorkSlotSeam
  /** Builds the worker process launch for one round. */
  readonly planWorker: WorkerLaunchPlanner
  /** Builds the reviewer's read-only process launch for one round. */
  readonly planReviewer: ReviewerLaunchPlanner
  /**
   * Validates that the reviewer plan exposes no write-capable tools. The
   * default checks the plan's argv (§10.2); tests with non-Pi planners may
   * inject their own check.
   */
  readonly reviewerPlanIsReadOnly?: (plan: AgentLaunchPlan) => boolean
  /** Unique tame invocation IDs; defaults to `<attemptId>-<role>-r<round>`. */
  readonly newInvocationId?: (owner: 'worker' | 'reviewer', round: number) => string
  /** Handle persisted at launch intent; defaults to a stable adapter name. */
  readonly launchIntentHandle?: (invocationId: string) => string
}

/** The immutable input plus everything the gate needs to execute one attempt. */
export type WorkAttemptParams = {
  readonly input: WorkInput
  readonly workAttemptId: string
  /** Identity of the Task Map the Ticket belongs to (sidecar binding, §17). */
  readonly map: AgentMapBinding
  readonly repositoryRoot: string
  readonly repositoryHome: string
  readonly repositoryId: string
  readonly runId: string
  /** Run-owned completions area, outside every workspace (§17). */
  readonly completionsDir: string
  readonly setup: readonly RunConfigCommand[]
  readonly tests: readonly RunConfigCommand[]
  readonly maxWorkRounds: number
  readonly agents: {
    readonly worker: RunConfigAgentRole
    readonly reviewer: RunConfigAgentRole & { readonly family: string }
  }
  /** Interrupts child agent invocations; already-aborted returns user-abort. */
  readonly signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Run-State and slot-registry production adapters
// ---------------------------------------------------------------------------

/**
 * The production attempt store over one Run State document (§13.1). The
 * document must already exist and key its tickets by the same issue ID as
 * `input.ticket`. The gate only ever updates its own ticket's phase between
 * `working`, `shippable`, and `parked`, keeps the ticket's process-group
 * checkpoints recorded while the attempt is live, and drops them at terminal
 * state once their settlement is proven (`settled`). Groups whose settlement
 * is unproven stay recorded so slot release keeps probing them (§16).
 */
export function runStateWorkAttemptStore(options: {
  readonly repositoryHome: string
  readonly encodedMapIssueId: string
  readonly ticketIssueId: string
  readonly wave: number
}): RoundGateStore {
  const { repositoryHome, encodedMapIssueId, ticketIssueId, wave } = options

  const controlStore = (what: string, cause?: unknown): Outcome<never, never, 'control-store'> =>
    error({
      scope: 'run',
      code: 'control-store',
      reason:
        `run state failed while ${what}` +
        (cause === undefined ? '' : `: ${cause instanceof Error ? cause.message : String(cause)}`),
    })

  return {
    async load(workAttemptId) {
      const loaded = loadRunState(repositoryHome, encodedMapIssueId)
      if (loaded.kind !== 'ok') return controlStore('loading the attempt', loaded.reason)
      if (loaded.value === undefined) return ok(undefined)
      const ticket = loaded.value.tickets[ticketIssueId]
      if (ticket === undefined || ticket.phase !== 'working') return ok(undefined)
      if (ticket.attempt.workAttemptId !== workAttemptId) return ok(undefined)
      return ok({
        attempt: ticket.attempt,
        processes: loaded.value.activeProcesses.filter(
          (group) => group.workAttemptId === workAttemptId,
        ),
      })
    },

    async saveWorking(record) {
      const loaded = loadRunState(repositoryHome, encodedMapIssueId)
      if (loaded.kind !== 'ok') return controlStore('recording the attempt', loaded.reason)
      if (loaded.value === undefined) {
        return controlStore('recording the attempt', 'no run state exists for this map')
      }
      const state = loaded.value
      const attemptId = record.attempt.workAttemptId
      const next = {
        ...state,
        tickets: {
          ...state.tickets,
          [ticketIssueId]: { phase: 'working' as const, wave, attempt: record.attempt },
        },
        activeProcesses: [
          ...state.activeProcesses.filter((group) => group.workAttemptId !== attemptId),
          ...record.processes,
        ],
      }
      const saved = saveRunState(repositoryHome, encodedMapIssueId, next)
      if (saved.kind !== 'ok') return controlStore('recording the attempt', saved.reason)
      return ok(undefined)
    },

    async saveTerminal(workAttemptId, terminal, processes) {
      const loaded = loadRunState(repositoryHome, encodedMapIssueId)
      if (loaded.kind !== 'ok') return controlStore('recording the attempt outcome', loaded.reason)
      if (loaded.value === undefined) {
        return controlStore('recording the attempt outcome', 'no run state exists for this map')
      }
      const state = loaded.value
      const entry =
        terminal.kind === 'sealed'
          ? { phase: 'shippable' as const, wave, change: terminal.change }
          : {
              phase: 'parked' as const,
              wave,
              ...(terminal.workspace === undefined ? {} : { workspace: terminal.workspace }),
              outcome: terminal.outcome,
            }
      const alreadyParked = state.parkedTickets.some((ref) => ref.issueId === ticketIssueId)
      const parkedTickets =
        terminal.kind === 'parked' && !alreadyParked
          ? [...state.parkedTickets, terminal.ticket]
          : state.parkedTickets
      const next = {
        ...state,
        tickets: { ...state.tickets, [ticketIssueId]: entry },
        parkedTickets,
        activeProcesses: [
          ...state.activeProcesses.filter((group) => group.workAttemptId !== workAttemptId),
          ...processes.filter((group) => group.state !== 'settled'),
        ],
      }
      const saved = saveRunState(repositoryHome, encodedMapIssueId, next)
      if (saved.kind !== 'ok') return controlStore('recording the attempt outcome', saved.reason)
      return ok(undefined)
    },
  }
}

/** The slot-registry reservation identity of one Work attempt (§16). */
export function workAttemptReservation(params: {
  readonly runId: string
  readonly mapIssueId: string
  readonly workAttemptId: string
}): WorkSlotReservation {
  return {
    runId: params.runId,
    encodedMapIssueId: encodePathSegment(params.mapIssueId),
    workAttemptId: params.workAttemptId,
  }
}

/** The production Work-slot seam over the repository-wide registry (§16). */
export function workSlotSeam(options: {
  readonly repositoryHome: string
  readonly reservation: WorkSlotReservation
  readonly capacity: number
  readonly probe?: ProcessGroupLivenessProbe
}): WorkSlotSeam {
  return {
    reserve: () => reserveWorkSlot(options.repositoryHome, options.reservation, options.capacity),
    release: () =>
      releaseWorkSlot(options.repositoryHome, options.reservation.workAttemptId, {
        ...(options.probe === undefined ? {} : { probe: options.probe }),
      }),
  }
}

/** The run-owned completions area of one run (§2.2, §17). */
export function completionsDirFor(repositoryHome: string, runId: string): string {
  return join(repositoryHome, 'runs', runId, 'completions')
}

// ---------------------------------------------------------------------------
// The independent seal check (§10.3)
// ---------------------------------------------------------------------------

/** The independently established facts a sealed change is checked against. */
export type SealCheckFacts = {
  readonly input: WorkInput
  readonly workspace: WorkspaceRef
  /** HEAD read independently by Norn from the clean owned branch. */
  readonly head: GitObjectOid
  /** Tree OID of that same independent read. */
  readonly treeOid: GitObjectOid
  readonly configuredTests: readonly RunConfigCommand[]
  readonly reviewer: {
    readonly provider: string
    readonly model: string
    readonly family: string
    readonly thinking: string
  }
}

/**
 * The independent seal check of design.md §10.3: before a `ShippableChange`
 * is sealed, every binding is verified against facts Norn established on its
 * own — the Work input's Ticket and revisions, the independently read clean
 * branch, one ordered test entry per configured test all bound to the same
 * base and complete candidate tree, and a review binding the same revisions,
 * base, tree, and the digest of exactly that ordered test list. Returns
 * every violation; an empty list is the proof.
 */
export function verifySealedChange(change: ShippableChange, facts: SealCheckFacts): readonly string[] {
  const violations: string[] = []
  const input = facts.input

  if (!sameJson(change.ticket, input.ticket)) {
    violations.push('the sealed ticket must equal the Work input ticket')
  }
  if (change.mapRevision !== input.spec.mapRevision) {
    violations.push('the sealed map revision must equal the Work input revision')
  }
  if (change.ticketRevision !== input.spec.ticketRevision) {
    violations.push('the sealed ticket revision must equal the Work input revision')
  }
  if (change.baseSha !== input.target.baseSha) {
    violations.push('the sealed base must equal the Work input base')
  }
  if (change.candidateCommit !== facts.head) {
    violations.push('the sealed candidate commit must equal the independently read HEAD')
  }
  if (change.candidateTreeOid !== facts.treeOid) {
    violations.push('the sealed candidate tree must equal the independently read tree')
  }
  if (!sameJson(change.workspace, facts.workspace)) {
    violations.push('the sealed workspace must equal the attempt-owned workspace')
  }

  if (change.tests.length !== facts.configuredTests.length) {
    violations.push(
      `the sealed tests must contain exactly one entry per configured test ` +
        `(${change.tests.length} of ${facts.configuredTests.length})`,
    )
  }
  change.tests.forEach((entry, index) => {
    const configured = facts.configuredTests[index]
    if (entry.phase !== 'work') violations.push(`tests[${index}] must be work-phase evidence`)
    if (entry.testIndex !== index) violations.push(`tests[${index}].testIndex must equal its position`)
    if (configured !== undefined) {
      if (!sameJson(entry.argv, configured.argv)) {
        violations.push(`tests[${index}].argv must equal the configured test`)
      }
      if (entry.timeoutMs !== configured.timeoutMs) {
        violations.push(`tests[${index}].timeoutMs must equal the configured test`)
      }
    }
    if (entry.exitCode !== 0) violations.push(`tests[${index}].exitCode must be 0`)
    if (entry.baseSha !== change.baseSha) {
      violations.push(`tests[${index}] must bind the sealed base`)
    }
    if (entry.treeOid !== change.candidateTreeOid) {
      violations.push(`tests[${index}] must bind the complete sealed candidate tree`)
    }
  })

  const review = change.review
  if (review.phase !== 'work') violations.push('the review must be work-phase evidence')
  if (review.verdict !== 'pass') violations.push('the review verdict must be pass')
  if (
    review.provider !== facts.reviewer.provider ||
    review.model !== facts.reviewer.model ||
    review.family !== facts.reviewer.family ||
    review.thinking !== facts.reviewer.thinking
  ) {
    violations.push('the review must match the configured reviewer identity')
  }
  if (review.mapRevision !== change.mapRevision) {
    violations.push('the review must bind the sealed map revision')
  }
  if (review.ticketRevision !== change.ticketRevision) {
    violations.push('the review must bind the sealed ticket revision')
  }
  if (review.baseSha !== change.baseSha) {
    violations.push('the review must bind the sealed base')
  }
  if (review.treeOid !== change.candidateTreeOid) {
    violations.push('the review must bind the complete sealed candidate tree')
  }
  if (review.testEvidenceDigest !== orderedTestEvidenceDigest(change.tests)) {
    violations.push('the review must bind the digest of the ordered sealed test evidence')
  }

  return violations
}

// ---------------------------------------------------------------------------
// The round gate
// ---------------------------------------------------------------------------

/** The attempt-owned workspace variant of `WorkspaceRef` (§10.1). */
type TicketWorkspaceRef = Extract<WorkspaceRef, { readonly kind: 'ticket' }>

/** Internal result of one round: sealed, continue with feedback, or terminal. */
type RoundResult =
  | { readonly kind: 'sealed'; readonly change: ShippableChange }
  | {
      readonly kind: 'continue'
      readonly candidateCommit: GitObjectOid
      readonly feedback: readonly RoundFeedback[]
    }
  | { readonly kind: 'terminal'; readonly outcome: WorkOutcome }

type GateState = {
  record: WorkAttemptRecord
  readonly processes: Map<string, ProcessGroupCheckpoint>
  reserved: boolean
  readonly workspace: TicketWorkspaceRef
}

/**
 * Run one complete Work attempt through the round gate of design.md §10.2.
 *
 * The attempt records itself and reserves one Work slot before any branch,
 * workspace, or child process exists; the round counter and each agent
 * launch intent are persisted before process creation; and every non-`ok`
 * return is typed per §9 with `sharedWrite: 'none'` — Work never performs a
 * shared write. On success the sealed `ShippableChange` is already persisted
 * in Run State and the slot is released.
 */
export async function runWorkAttempt(
  deps: RoundGateDeps,
  params: WorkAttemptParams,
): Promise<WorkOutcome> {
  const input = params.input
  const gateDeps: GateDeps = { runner: deps.commands, git: deps.git }
  const newInvocationId =
    deps.newInvocationId ??
    ((owner: 'worker' | 'reviewer', round: number) => `${params.workAttemptId}-${owner}-r${round}`)
  const launchIntentHandle =
    deps.launchIntentHandle ??
    ((invocationId: string) =>
      deps.runner.kind === 'herdr' ? herdrAgentName(invocationId) : invocationId)
  const reviewerPlanIsReadOnly =
    deps.reviewerPlanIsReadOnly ?? ((plan: AgentLaunchPlan) => isReadOnlyAgentArgv(plan.argv))

  // --- resume or fresh start ---------------------------------------------

  const loaded = await deps.store.load(params.workAttemptId)
  if (loaded.kind !== 'ok') {
    return error({
      scope: 'run',
      code: 'control-store',
      reason: loaded.reason,
      sharedWrite: 'none',
      evidence: [...loaded.evidence],
    })
  }

  if (loaded.value !== undefined && !sameJson(loaded.value.attempt.input, input)) {
    // Specification contradiction (§10.2): the persisted attempt binds a
    // different immutable Work input. Nothing is persisted or released here —
    // the recorded attempt belongs to the old input.
    return blocked({
      scope: 'ticket',
      code: 'spec-contradiction',
      reason:
        `the persisted Work attempt ${params.workAttemptId} binds a different Work input ` +
        '(Ticket or Map specification changed under the attempt)',
      sharedWrite: 'none',
      evidence: [{ workAttemptId: params.workAttemptId, persistedRound: loaded.value.attempt.round }],
    })
  }

  const branch = ticketBranch(params.runId, input.ticket.number, params.workAttemptId)
  const workspacePath = ticketWorkspaceDir(
    params.repositoryHome,
    params.runId,
    input.ticket.number,
    params.workAttemptId,
  )
  if (branch === undefined || workspacePath === undefined) {
    return error({
      scope: 'ticket',
      code: 'invalid-workspace-name',
      reason: `the Work attempt identity cannot name a branch and workspace: ${params.workAttemptId}`,
      sharedWrite: 'none',
    })
  }
  const workspaceRef: TicketWorkspaceRef = {
    kind: 'ticket',
    repositoryId: params.repositoryId,
    runId: params.runId,
    path: workspacePath,
    branch,
    workAttemptId: params.workAttemptId,
  }

  const processes = new Map<string, ProcessGroupCheckpoint>(
    (loaded.value?.processes ?? []).map((group) => [group.id, group]),
  )
  const state: GateState = {
    record: {
      attempt: {
        workAttemptId: params.workAttemptId,
        input,
        branch,
        workspace: workspaceRef,
        round: loaded.value?.attempt.round ?? 0,
        slot: loaded.value?.attempt.slot ?? 'awaiting-reservation',
        processGroupIds: [...processes.keys()],
      },
      processes: [...processes.values()],
    },
    processes,
    reserved: loaded.value?.attempt.slot === 'reserved',
    workspace: workspaceRef,
  }

  // --- record the attempt, then reserve one slot (§10.1, §16) ------------

  const recorded = await persistWorking(deps.store, state)
  if (recorded.kind !== 'ok') return recorded

  if (!state.reserved) {
    const reservation = await deps.slots.reserve()
    if (reservation.kind !== 'ok') {
      return runScopedSlot('reserving the Work slot', reservation)
    }
    if (!reservation.value.reserved) {
      return finishAttempt(deps, state, blocked({
        scope: 'ticket',
        code: 'slot-unavailable',
        reason:
          `the repository-wide Work capacity is fully charged; attempt ${params.workAttemptId} ` +
          'cannot start',
        sharedWrite: 'none',
        evidence: [{ workAttemptId: params.workAttemptId }],
      }), { retainWorkspace: false })
    }
    state.reserved = true
    state.record = withAttempt(state, { slot: 'reserved' })
    const saved = await persistWorking(deps.store, state)
    if (saved.kind !== 'ok') return saved
  }

  // --- the attempt-owned branch and workspace at the exact Wave base -----

  if (loaded.value === undefined) {
    const created = await createTicketWorkspace(
      { git: deps.git },
      {
        repositoryRoot: params.repositoryRoot,
        repositoryHome: params.repositoryHome,
        repositoryId: params.repositoryId,
        runId: params.runId,
        ticketNumber: input.ticket.number,
        workAttemptId: params.workAttemptId,
        base: { sha: input.target.baseSha, treeOid: input.target.baseTreeOid },
      },
    )
    if (created.kind !== 'ok') return finishAttempt(deps, state, created)
    const createdWorkspace = created.value as TicketWorkspaceRef
    if (
      createdWorkspace.branch !== branch ||
      createdWorkspace.path !== workspacePath ||
      createdWorkspace.workAttemptId !== params.workAttemptId
    ) {
      return finishAttempt(deps, state, error({
        scope: 'ticket',
        code: 'workspace-verification-failed',
        reason: 'the created workspace does not match the recorded attempt workspace',
        sharedWrite: 'none',
        evidence: [{ created: created.value, recorded: workspaceRef }],
      }))
    }
  } else {
    // Resume: a crash may have preceded the workspace creation — the attempt
    // record, slot reservation, and branch all outlive the worktree. Recreate
    // the workspace from the attempt-owned branch (creating the branch at the
    // recorded base when even that crashed first), then re-establish branch
    // ownership through the normal inspection (§13.2).
    const ensured = await ensureResumedWorkspace(deps, params, workspaceRef)
    if (ensured.kind !== 'ok') return finishAttempt(deps, state, ensured)
    const inspection = await inspectWorkspace(deps.git, workspacePath)
    if (inspection.status !== 'ok') {
      return finishAttempt(deps, state, error({
        scope: 'ticket',
        code: 'git-failed',
        reason: `resumed workspace inspection failed: ${inspection.message}`,
        sharedWrite: 'none',
      }))
    }
    if (inspection.state.symbolicHead !== `refs/heads/${branch}`) {
      return finishAttempt(deps, state, error({
        scope: 'ticket',
        code: 'workspace-verification-failed',
        reason: 'the resumed workspace is not on the attempt-owned branch',
        sharedWrite: 'none',
        evidence: [{ symbolicHead: inspection.state.symbolicHead, expected: `refs/heads/${branch}` }],
      }))
    }
  }

  // --- initial setup at the base; a clean non-pass is worker feedback ----

  const feedback: RoundFeedback[] = []
  if (state.record.attempt.round === 0) {
    const setup = await runGateCommandList(gateDeps, {
      commands: params.setup,
      workspace: {
        path: workspacePath,
        expectedHead: input.target.baseSha,
        expectedTreeOid: input.target.baseTreeOid,
      },
      scope: 'ticket',
    })
    if (setup.kind !== 'ok') return finishAttempt(deps, state, setup)
    const initial = initialSetupFeedback(setup.value)
    if (initial !== undefined) feedback.push(initial)
  }

  // --- the rounds ---------------------------------------------------------

  let previousCandidate: GitObjectOid | null = null
  let round = state.record.attempt.round
  while (round < params.maxWorkRounds) {
    round += 1
    // The round counter is persisted before the worker process is created,
    // so a crash cannot reset the budget (§10.2).
    state.record = withAttempt(state, { round })
    const persisted = await persistWorking(deps.store, state)
    if (persisted.kind !== 'ok') return persisted

    const result = await runRound(deps, params, state, {
      round,
      previousCandidate,
      feedback,
      gateDeps,
      newInvocationId,
      launchIntentHandle,
      reviewerPlanIsReadOnly,
    })
    if (result.kind === 'sealed') {
      const sealed = await finishSealed(deps, state, result.change)
      return sealed
    }
    if (result.kind === 'terminal') {
      return result.outcome.kind !== 'ok' && result.outcome.scope === 'run'
        ? result.outcome
        : finishAttempt(deps, state, result.outcome)
    }
    // Continue: the next round starts from this round's clean candidate
    // commit, with the accumulated feedback (§10.2).
    previousCandidate = result.candidateCommit
    feedback.push(...result.feedback)
  }

  return finishAttempt(deps, state, blocked({
    scope: 'ticket',
    code: 'work-rounds-exhausted',
    reason:
      `the Work attempt used its ${params.maxWorkRounds} worker round(s) without a passing ` +
      'setup, test, and review gate',
    sharedWrite: 'none',
    evidence: [
      { workAttemptId: params.workAttemptId, rounds: params.maxWorkRounds, feedback: [...feedback] },
    ],
  }))
}

type RoundContext = {
  readonly round: number
  readonly previousCandidate: GitObjectOid | null
  readonly feedback: readonly RoundFeedback[]
  readonly gateDeps: GateDeps
  readonly newInvocationId: (owner: 'worker' | 'reviewer', round: number) => string
  readonly launchIntentHandle: (invocationId: string) => string
  readonly reviewerPlanIsReadOnly: (plan: AgentLaunchPlan) => boolean
}

/**
 * Repair the workspace of a resumed attempt whose directory is absent: the
 * crash preceded (or interrupted) the attempt-owned worktree creation, while
 * the persisted attempt record already names the branch and workspace. The
 * worktree is recreated from the attempt-owned branch — which holds the last
 * round's candidate when one exists — and the branch itself is created at
 * the recorded Wave base when the crash preceded even that. The caller's
 * inspection then re-establishes branch ownership exactly as for any resumed
 * workspace (§10.1, §13.2).
 */
async function ensureResumedWorkspace(
  deps: RoundGateDeps,
  params: WorkAttemptParams,
  workspace: TicketWorkspaceRef,
): Promise<Outcome<void, never, WorkErrorCode>> {
  if (existsSync(workspace.path)) return ok(undefined)
  const baseHex = parseGitObjectOid(params.input.target.baseSha)?.hex
  if (baseHex === undefined) {
    return error({
      scope: 'ticket',
      code: 'workspace-verification-failed',
      reason: `the recorded base of the resumed attempt is malformed: ${params.input.target.baseSha}`,
      sharedWrite: 'none',
      evidence: [{ workAttemptId: params.workAttemptId }],
    })
  }

  const branchRef = `refs/heads/${workspace.branch}`
  const existing = await deps.git(['rev-parse', '--verify', '--quiet', branchRef], params.repositoryRoot)
  if (!existing.ok) {
    const created = await deps.git(['branch', workspace.branch, baseHex], params.repositoryRoot)
    if (!created.ok) {
      return error({
        scope: 'ticket',
        code: 'git-failed',
        reason: `recreating the attempt-owned branch of the resumed attempt failed: ${created.message}`,
        sharedWrite: 'none',
        evidence: [{ operation: 'branch', branch: workspace.branch }],
      })
    }
  }
  const added = await deps.git(
    ['worktree', 'add', '--checkout', workspace.path, workspace.branch],
    params.repositoryRoot,
  )
  if (!added.ok) {
    return error({
      scope: 'ticket',
      code: 'git-failed',
      reason: `recreating the workspace of the resumed attempt failed: ${added.message}`,
      sharedWrite: 'none',
      evidence: [{ operation: 'worktree-add', path: workspace.path, branch: workspace.branch }],
    })
  }
  return ok(undefined)
}

/** One worker round: candidate → setup → tests → reviewer (§10.2). */
async function runRound(
  deps: RoundGateDeps,
  params: WorkAttemptParams,
  state: GateState,
  round: RoundContext,
): Promise<RoundResult> {
  const input = params.input
  const { attempt } = state.record

  // --- one fresh visible worker invocation -------------------------------

  const workerId = round.newInvocationId('worker', round.round)
  const workerPlan = deps.planWorker({
    round: round.round,
    previousCandidateCommit: round.previousCandidate,
    feedback: round.feedback,
  })
  const workerContext = completionContext(params, state.workspace, {
    invocationId: workerId,
    role: 'worker',
    work: {
      workAttemptId: attempt.workAttemptId,
      round: round.round,
      input: workInputBinding(input),
    },
  })
  const workerSettlement = await runOwnedInvocation(deps, params, state, {
    owner: 'worker',
    invocationId: workerId,
    context: workerContext,
    plan: workerPlan,
    timeoutMs: params.agents.worker.timeoutMs,
    launchIntentHandle: round.launchIntentHandle,
  })
  if (workerSettlement.kind !== 'ok') return { kind: 'terminal', outcome: workerSettlement }
  const handoff = workerSettlement.value.completion as WorkerCompletion
  if (handoff.discriminant === 'block') {
    return {
      kind: 'terminal',
      outcome: blocked({
        scope: 'ticket',
        code: 'worker-block',
        reason: `the worker blocked: ${handoff.code}`,
        sharedWrite: 'none',
        evidence: [{ code: handoff.code, reason: handoff.reason, round: round.round }],
      }),
    }
  }

  // --- settle, then verify the candidate branch, commit, tree, lineage ---

  const verified = await verifyCandidateWorkspace(deps, params, state)
  if (verified.kind !== 'ok') return { kind: 'terminal', outcome: verified }
  const candidate: CandidateRead = verified.value
  if (handoff.claimedCommit !== candidate.head || handoff.claimedTreeOid !== candidate.treeOid) {
    return {
      kind: 'terminal',
      outcome: error({
        scope: 'ticket',
        code: 'handoff-mismatch',
        reason: "the worker handoff OIDs differ from Norn's independent reads",
        sharedWrite: 'none',
        evidence: [
          {
            claimedCommit: handoff.claimedCommit,
            claimedTreeOid: handoff.claimedTreeOid,
            readCommit: candidate.head,
            readTreeOid: candidate.treeOid,
          },
        ],
      }),
    }
  }
  const zeroDelta = candidate.treeOid === input.target.baseTreeOid

  // --- setup again at the candidate tree ----------------------------------

  const setup = await runGateCommandList(round.gateDeps, {
    commands: params.setup,
    workspace: {
      path: state.workspace.path,
      expectedHead: candidate.head,
      expectedTreeOid: candidate.treeOid,
    },
    scope: 'ticket',
  })
  if (setup.kind !== 'ok') return { kind: 'terminal', outcome: setup }
  const setupFeedback = listFeedback(setup.value, round.round, 'setup')
  if (setupFeedback !== undefined) {
    return { kind: 'continue', candidateCommit: candidate.head, feedback: [setupFeedback] }
  }

  // --- the complete configured test list ----------------------------------

  const tests = await runGateCommandList(round.gateDeps, {
    commands: params.tests,
    workspace: {
      path: state.workspace.path,
      expectedHead: candidate.head,
      expectedTreeOid: candidate.treeOid,
    },
    scope: 'ticket',
  })
  if (tests.kind !== 'ok') return { kind: 'terminal', outcome: tests }
  const testFeedback = listFeedback(tests.value, round.round, 'tests')
  if (testFeedback !== undefined) {
    return { kind: 'continue', candidateCommit: candidate.head, feedback: [testFeedback] }
  }
  const evidence = buildTestEvidence(tests.value, input.target.baseSha, candidate.treeOid)

  // --- one fresh independent read-only reviewer ---------------------------

  const diff = await coordinatorDiff(
    deps.git,
    state.workspace.path,
    input.target.baseSha,
    candidate.head,
  )
  if (diff === undefined) {
    return {
      kind: 'terminal',
      outcome: error({
        scope: 'ticket',
        code: 'diff-failed',
        reason: 'the coordinator-generated base-to-candidate diff could not be read',
        sharedWrite: 'none',
        evidence: [{ baseSha: input.target.baseSha, candidateCommit: candidate.head }],
      }),
    }
  }
  const reviewerId = round.newInvocationId('reviewer', round.round)
  const reviewerPlan = deps.planReviewer({
    spec: input.spec,
    target: input.target,
    candidate: { commit: candidate.head, treeOid: candidate.treeOid, zeroDelta },
    diff,
    tests: evidence,
    testOutput: reviewerTestOutput(tests.value),
  })
  if (!round.reviewerPlanIsReadOnly(reviewerPlan)) {
    return {
      kind: 'terminal',
      outcome: error({
        scope: 'ticket',
        code: 'reviewer-not-read-only',
        reason: 'the reviewer launch plan exposes write-capable tools (§10.2)',
        sharedWrite: 'none',
        evidence: [{ argv: reviewerPlan.argv }],
      }),
    }
  }
  const reviewerContext = completionContext(params, state.workspace, {
    invocationId: reviewerId,
    role: 'reviewer',
  })
  const reviewerSettlement = await runOwnedInvocation(deps, params, state, {
    owner: 'reviewer',
    invocationId: reviewerId,
    context: reviewerContext,
    plan: reviewerPlan,
    timeoutMs: params.agents.reviewer.timeoutMs,
    launchIntentHandle: round.launchIntentHandle,
  })
  if (reviewerSettlement.kind !== 'ok') return { kind: 'terminal', outcome: reviewerSettlement }
  const verdict = reviewerSettlement.value.completion as ReviewerCompletion
  if (verdict.discriminant === 'block') {
    return {
      kind: 'terminal',
      outcome: blocked({
        scope: 'ticket',
        code: 'reviewer-block',
        reason: `the reviewer blocked: ${verdict.code}`,
        sharedWrite: 'none',
        evidence: [{ code: verdict.code, reason: verdict.reason, round: round.round }],
      }),
    }
  }
  if (verdict.discriminant === 'iterate') {
    return {
      kind: 'continue',
      candidateCommit: candidate.head,
      feedback: [{ kind: 'review', round: round.round, feedback: verdict.feedback }],
    }
  }

  // --- pass: verify again and seal (§10.2, §10.3) -------------------------

  const reverified = await verifyReviewerExit(deps, state, candidate)
  if (reverified.kind !== 'ok') return { kind: 'terminal', outcome: reverified }

  const reviewer = params.agents.reviewer
  const reviewerIdentity = {
    provider: modelProvider(reviewer.model),
    model: reviewer.model,
    family: reviewer.family,
    thinking: reviewer.thinking,
  }
  const review: ReviewEvidence = {
    phase: 'work',
    ...reviewerIdentity,
    verdict: 'pass',
    mapRevision: input.spec.mapRevision,
    ticketRevision: input.spec.ticketRevision,
    baseSha: input.target.baseSha,
    treeOid: candidate.treeOid,
    testEvidenceDigest: orderedTestEvidenceDigest(evidence),
  }
  const change: ShippableChange = {
    ticket: input.ticket,
    mapRevision: input.spec.mapRevision,
    ticketRevision: input.spec.ticketRevision,
    baseSha: input.target.baseSha,
    candidateCommit: candidate.head,
    candidateTreeOid: candidate.treeOid,
    workspace: state.workspace,
    tests: evidence,
    review,
  }
  const violations = verifySealedChange(change, {
    input,
    workspace: state.workspace,
    head: reverified.value.head,
    treeOid: reverified.value.treeOid,
    configuredTests: params.tests,
    reviewer: reviewerIdentity,
  })
  if (violations.length !== 0) {
    return {
      kind: 'terminal',
      outcome: error({
        scope: 'ticket',
        code: 'seal-verification',
        reason: 'the sealed change failed the independent seal check (§10.3)',
        sharedWrite: 'none',
        evidence: [{ violations: [...violations] }],
      }),
    }
  }
  return { kind: 'sealed', change }
}

// ---------------------------------------------------------------------------
// Owned agent invocations: persist intent, launch, settle, persist settlement
// ---------------------------------------------------------------------------

type OwnedInvocationOutcome = Outcome<
  SettledAgentInvocation<WorkerCompletion | ReviewerCompletion>,
  AgentSettlementBlockCode,
  AgentSettlementErrorCode | 'control-store'
>

/**
 * Launch and settle one owned agent invocation with the write-ahead protocol
 * of §16/§17: the `launch-intent` checkpoint (with a stable pre-derivable
 * handle) is persisted before the process is created, the real adapter
 * handle is persisted once the process exists, and the settled checkpoint is
 * persisted before the outcome leaves. An operator interrupt terminates and
 * settles the whole group and returns `blocked(user-abort)` (§9, §17).
 */
async function runOwnedInvocation(
  deps: RoundGateDeps,
  params: WorkAttemptParams,
  state: GateState,
  invocation: {
    readonly owner: 'worker' | 'reviewer'
    readonly invocationId: string
    readonly context: AgentCompletionContext
    readonly plan: AgentLaunchPlan
    readonly timeoutMs: number
    readonly launchIntentHandle: (invocationId: string) => string
  },
): Promise<OwnedInvocationOutcome> {
  const checkpoint: ProcessGroupCheckpoint = {
    id: invocation.invocationId,
    owner: invocation.owner,
    phase: 'work',
    workspace: state.workspace,
    ticketIssueId: params.input.ticket.issueId,
    workAttemptId: params.workAttemptId,
    adapterHandle: invocation.launchIntentHandle(invocation.invocationId),
    state: 'launch-intent',
  }
  state.processes.set(checkpoint.id, checkpoint)
  const persisted = await persistWorking(deps.store, state)
  if (persisted.kind !== 'ok') return persisted

  if (params.signal?.aborted) {
    // No child exists yet; dropping the in-memory checkpoint lets the
    // terminal save remove the intent from Run State.
    state.processes.delete(checkpoint.id)
    return blocked({
      scope: 'ticket',
      code: 'user-abort',
      reason:
        `operator interrupted before the ${invocation.owner} invocation ` +
        `${invocation.invocationId} launched`,
      sharedWrite: 'none',
      evidence: [{ invocationId: invocation.invocationId }],
    })
  }

  let processRef: AttachedAgentProcess
  try {
    processRef = await deps.runner.launch({
      context: invocation.context,
      argv: invocation.plan.argv,
      cwd: state.workspace.path,
      env: {
        ...(invocation.plan.env ?? {}),
        [NORN_AGENT_CONTEXT_ENV]: canonicalJson(invocation.context as CanonicalJsonValue),
      },
    })
  } catch (cause) {
    // The adapter contract: a launch that throws created no process.
    state.processes.delete(checkpoint.id)
    return error({
      scope: 'ticket',
      code: 'launch-failed',
      reason: `agent invocation ${invocation.invocationId}: launch-failed: ${describe(cause)}`,
      sharedWrite: 'none',
      evidence: [{ invocationId: invocation.invocationId, owner: invocation.owner }],
    })
  }

  state.processes.set(checkpoint.id, {
    ...checkpoint,
    state: 'running',
    adapterHandle: processRef.adapterHandle,
  })
  const runningPersisted = await persistWorking(deps.store, state)
  if (runningPersisted.kind !== 'ok') return runningPersisted

  const watch = watchAbort(params.signal)
  const settlement = settleAgentInvocation(
    deps.runner,
    processRef,
    invocation.context,
    invocation.timeoutMs,
    'ticket',
  )
  const winner = await Promise.race([
    settlement.then((outcome) => ({ kind: 'settled' as const, outcome })),
    ...(watch === undefined ? [] : [watch.promise.then(() => ({ kind: 'aborted' as const }))]),
  ])
  watch?.dispose()

  if (winner.kind === 'aborted') {
    const interrupted = await interruptAgentInvocation(
      deps.runner,
      processRef,
      invocation.context,
      'ticket',
    )
    if (interrupted.kind === 'ok') {
      // Unreachable: an interrupt is blocked(user-abort) or an error, never ok.
      return error({
        scope: 'ticket',
        code: 'protocol-error',
        reason: `agent invocation ${invocation.invocationId}: interrupt resolved without an outcome`,
        sharedWrite: 'none',
        evidence: [{ invocationId: invocation.invocationId }],
      })
    }
    markSettled(state, checkpoint.id, interrupted)
    const settledPersisted = await persistWorking(deps.store, state)
    if (settledPersisted.kind !== 'ok') return settledPersisted
    return interrupted
  }

  markSettled(state, checkpoint.id, winner.outcome)
  const settledPersisted = await persistWorking(deps.store, state)
  if (settledPersisted.kind !== 'ok') return settledPersisted
  return winner.outcome
}

/**
 * Record the strongest process-group state an outcome proves: settlement
 * outcomes that prove group exit (or a launch failure) settle the
 * checkpoint; adapter failures with unknown group state keep it `running`
 * so slot release keeps probing it (§16).
 */
function markSettled(
  state: GateState,
  invocationId: string,
  outcome: Outcome<unknown, AgentSettlementBlockCode, AgentSettlementErrorCode>,
): void {
  const checkpoint = state.processes.get(invocationId)
  if (checkpoint === undefined) return
  const provenExited =
    outcome.kind === 'ok' ||
    outcome.kind === 'blocked' ||
    (outcome.kind === 'error' &&
      ['launch-failed', 'agent-timeout', 'protocol-error', 'malformed-sidecar'].includes(outcome.code))
  if (provenExited) {
    state.processes.set(invocationId, { ...checkpoint, state: 'settled' })
  }
}

function watchAbort(signal: AbortSignal | undefined): {
  readonly promise: Promise<'aborted'>
  readonly dispose: () => void
} | undefined {
  if (signal === undefined) return undefined
  if (signal.aborted) {
    return { promise: Promise.resolve('aborted'), dispose: () => undefined }
  }
  let resolveAborted!: (value: 'aborted') => void
  const promise = new Promise<'aborted'>((resolvePromise) => {
    resolveAborted = resolvePromise
  })
  const onAbort = (): void => resolveAborted('aborted')
  signal.addEventListener('abort', onAbort, { once: true })
  return {
    promise,
    dispose: () => signal.removeEventListener('abort', onAbort),
  }
}

// ---------------------------------------------------------------------------
// Candidate verification: the owned branch, independent OIDs, lineage
// ---------------------------------------------------------------------------

type CandidateRead = { readonly head: GitObjectOid; readonly treeOid: GitObjectOid }

/**
 * The post-worker candidate acceptance of §10.2, on independent reads: the
 * workspace is on the attempt-owned branch with that branch ref as HEAD,
 * HEAD is the base or reaches it through a linear no-merge commit sequence,
 * and the workspace is clean. Returns the independently read OIDs.
 */
async function verifyCandidateWorkspace(
  deps: RoundGateDeps,
  params: WorkAttemptParams,
  state: GateState,
): Promise<Outcome<CandidateRead, never, WorkErrorCode>> {
  const inspection = await inspectWorkspace(deps.git, state.workspace.path)
  if (inspection.status !== 'ok') {
    return error({
      scope: 'ticket',
      code: 'workspace-inspection-failed',
      reason: `candidate inspection failed: ${inspection.message}`,
      sharedWrite: 'none',
    })
  }
  const workspaceState = inspection.state
  const violations: Record<string, CanonicalJsonValue> = {}
  if (workspaceState.symbolicHead !== `refs/heads/${state.workspace.branch}`) {
    violations.symbolicHead = {
      expected: `refs/heads/${state.workspace.branch}`,
      actual: workspaceState.symbolicHead,
    }
  }
  if (workspaceState.status.length !== 0) {
    violations.status = workspaceState.status
  }
  if (workspaceState.head !== params.input.target.baseSha) {
    const lineage = await verifyLinearLineage(
      deps.git,
      state.workspace.path,
      params.input.target.baseSha,
      workspaceState.head,
    )
    if (lineage.length !== 0) violations.lineage = lineage
  }
  if (Object.keys(violations).length !== 0) {
    return error({
      scope: 'ticket',
      code: 'candidate-verification',
      reason:
        'the settled candidate violates the owned-branch, lineage, or cleanliness rules (§10.2)',
      sharedWrite: 'none',
      evidence: [violations],
    })
  }
  return ok({ head: workspaceState.head, treeOid: workspaceState.headTree })
}

/**
 * `base` is reachable from `head` through a linear, no-merge commit
 * sequence: `base` is the merge base of the two, and every commit in
 * `base..head` has at most one parent.
 */
async function verifyLinearLineage(
  git: GitCommandRunner,
  path: string,
  base: GitObjectOid,
  head: GitObjectOid,
): Promise<CanonicalJsonValue[]> {
  const baseHex = parseGitObjectOid(base)?.hex
  const headHex = parseGitObjectOid(head)?.hex
  if (baseHex === undefined || headHex === undefined) return [{ problem: 'malformed object ID' }]

  const mergeBase = await git(['merge-base', baseHex, headHex], path)
  if (!mergeBase.ok) return [{ operation: 'merge-base', failure: mergeBase.message }]
  if (mergeBase.stdout.trim() !== baseHex) {
    return [{ problem: 'the base is not an ancestor of the candidate HEAD' }]
  }
  const all = await git(['rev-list', '--count', `${baseHex}..${headHex}`], path)
  if (!all.ok) return [{ operation: 'rev-list', failure: all.message }]
  const noMerges = await git(['rev-list', '--count', '--no-merges', `${baseHex}..${headHex}`], path)
  if (!noMerges.ok) return [{ operation: 'rev-list --no-merges', failure: noMerges.message }]
  if (all.stdout.trim() !== noMerges.stdout.trim()) {
    return [{ problem: 'the candidate history contains merge commits' }]
  }
  return []
}

/**
 * The post-reviewer re-verification of §10.2: the same branch, HEAD, tree,
 * and cleanliness the reviewer judged must still hold after it exits.
 */
async function verifyReviewerExit(
  deps: RoundGateDeps,
  state: GateState,
  candidate: CandidateRead,
): Promise<Outcome<CandidateRead, never, WorkErrorCode>> {
  const inspection = await inspectWorkspace(deps.git, state.workspace.path)
  if (inspection.status !== 'ok') {
    return error({
      scope: 'ticket',
      code: 'workspace-inspection-failed',
      reason: `post-review inspection failed: ${inspection.message}`,
      sharedWrite: 'none',
    })
  }
  const workspaceState = inspection.state
  const violations: Record<string, CanonicalJsonValue> = {}
  if (workspaceState.symbolicHead !== `refs/heads/${state.workspace.branch}`) {
    violations.symbolicHead = {
      expected: `refs/heads/${state.workspace.branch}`,
      actual: workspaceState.symbolicHead,
    }
  }
  if (workspaceState.head !== candidate.head) {
    violations.head = { expected: candidate.head, actual: workspaceState.head }
  }
  if (workspaceState.headTree !== candidate.treeOid) {
    violations.headTree = { expected: candidate.treeOid, actual: workspaceState.headTree }
  }
  if (workspaceState.status.length !== 0) {
    violations.status = workspaceState.status
  }
  if (Object.keys(violations).length !== 0) {
    return error({
      scope: 'ticket',
      code: 'reviewer-verification',
      reason: 'the workspace changed between the reviewer pass and sealing (§10.2)',
      sharedWrite: 'none',
      evidence: [violations],
    })
  }
  return ok({ head: workspaceState.head, treeOid: workspaceState.headTree })
}

/** The coordinator-generated base-to-candidate diff; undefined on git failure. */
async function coordinatorDiff(
  git: GitCommandRunner,
  path: string,
  base: GitObjectOid,
  candidate: GitObjectOid,
): Promise<string | undefined> {
  const baseHex = parseGitObjectOid(base)?.hex
  const candidateHex = parseGitObjectOid(candidate)?.hex
  if (baseHex === undefined || candidateHex === undefined) return undefined
  const result = await git(['diff', '--no-color', baseHex, candidateHex], path)
  return result.ok ? result.stdout : undefined
}

// ---------------------------------------------------------------------------
// Evidence construction and feedback
// ---------------------------------------------------------------------------

/** One ordered `TestEvidence` entry per passing configured test (§10.3). */
function buildTestEvidence(
  list: GateCommandListValue,
  baseSha: string,
  treeOid: string,
): TestEvidence[] {
  return list.entries.map((entry) => {
    if (entry.result.status !== 'pass') {
      throw new Error('test evidence may only be built from a complete passing list')
    }
    return {
      phase: 'work' as const,
      testIndex: entry.index,
      argv: [...entry.command.argv],
      timeoutMs: entry.command.timeoutMs,
      baseSha,
      treeOid,
      exitCode: 0 as const,
      outputDigest: entry.result.outputDigest,
    }
  })
}

/** The captured output of every passing test, for the reviewer (§10.2). */
function reviewerTestOutput(list: GateCommandListValue): ReviewerTestOutput[] {
  return list.entries.map((entry) => {
    if (entry.result.status !== 'pass') {
      throw new Error('reviewer output may only be built from a complete passing list')
    }
    return {
      testIndex: entry.index,
      argv: [...entry.command.argv],
      stdout: decode(entry.result.stdout),
      stderr: decode(entry.result.stderr),
      outputDigest: entry.result.outputDigest,
    }
  })
}

/** Structured feedback for a stopped list's first non-pass, if any. */
function stoppedListFeedback(
  list: GateCommandListValue,
): { readonly index: number; readonly result: GateCommandFeedbackShape } | undefined {
  if (list.stoppedAtIndex === null) return undefined
  const entry = list.entries[list.stoppedAtIndex]
  if (entry === undefined || entry.result.status === 'pass') return undefined
  return { index: entry.index, result: entry.result }
}

type GateCommandFeedbackShape = {
  readonly cause: 'non-zero-exit' | 'timeout-terminated'
  readonly exitCode: number | null
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

/** Structured feedback for the round's candidate setup or test non-pass. */
function listFeedback(
  list: GateCommandListValue,
  round: number,
  kind: 'setup' | 'tests',
): RoundFeedback | undefined {
  const stopped = stoppedListFeedback(list)
  if (stopped === undefined) return undefined
  const entry = list.entries[stopped.index]!
  if (kind === 'setup') {
    return {
      kind: 'setup',
      round,
      origin: 'candidate',
      argv: [...entry.command.argv],
      cause: stopped.result.cause,
      exitCode: stopped.result.exitCode,
      stdout: decode(stopped.result.stdout),
      stderr: decode(stopped.result.stderr),
    }
  }
  return {
    kind: 'tests',
    round,
    testIndex: stopped.index,
    argv: [...entry.command.argv],
    cause: stopped.result.cause,
    exitCode: stopped.result.exitCode,
    stdout: decode(stopped.result.stdout),
    stderr: decode(stopped.result.stderr),
  }
}

/** The initial setup's clean non-pass, retained as round-1 worker feedback. */
function initialSetupFeedback(list: GateCommandListValue): RoundFeedback | undefined {
  const stopped = stoppedListFeedback(list)
  if (stopped === undefined) return undefined
  const entry = list.entries[stopped.index]!
  return {
    kind: 'setup',
    round: 0,
    origin: 'initial',
    argv: [...entry.command.argv],
    cause: stopped.result.cause,
    exitCode: stopped.result.exitCode,
    stdout: decode(stopped.result.stdout),
    stderr: decode(stopped.result.stderr),
  }
}

function decode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8')
}

// ---------------------------------------------------------------------------
// Completion contexts and small helpers
// ---------------------------------------------------------------------------

function workInputBinding(input: WorkInput): AgentWorkInputBinding {
  return {
    mapTitle: input.spec.mapTitle,
    mapBody: input.spec.mapBody,
    mapRevision: input.spec.mapRevision,
    ticketTitle: input.spec.ticketTitle,
    ticketBody: input.spec.ticketBody,
    ticketRevision: input.spec.ticketRevision,
    target: {
      branch: input.target.branch,
      baseSha: input.target.baseSha,
      baseTreeOid: input.target.baseTreeOid,
    },
  }
}

function completionContext(
  params: WorkAttemptParams,
  workspace: TicketWorkspaceRef,
  init:
    | { readonly invocationId: string; readonly role: 'worker'; readonly work: AgentWorkBinding }
    | { readonly invocationId: string; readonly role: 'reviewer' },
): AgentCompletionContext {
  const ticket: TicketRef = params.input.ticket
  return {
    schema: AGENT_COMPLETION_SCHEMA,
    invocationId: init.invocationId,
    runId: params.runId,
    role: init.role,
    phase: 'work',
    map: params.map,
    ticket: {
      githubHost: ticket.githubHost,
      repositoryId: ticket.repositoryId,
      issueId: ticket.issueId,
      number: ticket.number,
    },
    ...(init.role === 'worker' ? { work: init.work } : {}),
    workspace: { kind: 'ticket', path: workspace.path },
    piSessionId: `${init.invocationId}-pi`,
    completionsDir: params.completionsDir,
  }
}

/** Persist the current working state of the attempt (§13.1). */
async function persistWorking(
  store: RoundGateStore,
  state: GateState,
): Promise<Outcome<void, never, 'control-store'>> {
  state.record = {
    attempt: { ...state.record.attempt, processGroupIds: [...state.processes.keys()] },
    processes: [...state.processes.values()],
  }
  const saved = await store.saveWorking(state.record)
  if (saved.kind !== 'ok') {
    return error({
      scope: 'run',
      code: 'control-store',
      reason: saved.reason,
      sharedWrite: 'none',
      evidence: [...saved.evidence],
    })
  }
  return ok(undefined)
}

function withAttempt(state: GateState, changes: Partial<WorkAttemptCheckpoint>): WorkAttemptRecord {
  return {
    attempt: { ...state.record.attempt, ...changes },
    processes: [...state.processes.values()],
  }
}

/**
 * Persist the terminal outcome, then release the slot (§16): the outcome is
 * durable before capacity is freed. Ticket-scoped non-`ok` outcomes park the
 * Ticket; run-scoped errors are returned without parking. A failure to
 * persist or release is itself run-scoped — the attempt's outcome is
 * recorded in the evidence.
 */
async function finishAttempt(
  deps: RoundGateDeps,
  state: GateState,
  outcome: WorkOutcome,
  options: { readonly retainWorkspace?: boolean } = {},
): Promise<WorkOutcome> {
  if (outcome.kind === 'ok') return finishSealed(deps, state, outcome.value)
  if (outcome.scope === 'run') return outcome

  const parked = await deps.store.saveTerminal(
    state.record.attempt.workAttemptId,
    {
      kind: 'parked',
      ticket: state.record.attempt.input.ticket,
      ...(options.retainWorkspace === false ? {} : { workspace: state.workspace }),
      outcome: {
        kind: outcome.kind === 'blocked' ? 'blocked' : 'error',
        code: outcome.code,
        reason: outcome.reason,
        evidence: [...outcome.evidence],
      },
    },
    [...state.processes.values()],
  )
  if (parked.kind !== 'ok') {
    return error({
      scope: 'run',
      code: 'control-store',
      reason: parked.reason,
      sharedWrite: 'none',
      evidence: [
        ...parked.evidence,
        { parkedOutcome: { kind: outcome.kind, code: outcome.code } },
      ],
    })
  }
  return releaseSlot(deps, state, outcome)
}

/** Persist the sealed change, then release the slot and return the change. */
async function finishSealed(
  deps: RoundGateDeps,
  state: GateState,
  change: ShippableChange,
): Promise<WorkOutcome> {
  const sealed = await deps.store.saveTerminal(
    state.record.attempt.workAttemptId,
    { kind: 'sealed', change },
    [...state.processes.values()],
  )
  if (sealed.kind !== 'ok') {
    return error({
      scope: 'run',
      code: 'control-store',
      reason: sealed.reason,
      sharedWrite: 'none',
      evidence: [...sealed.evidence, { sealedCandidateCommit: change.candidateCommit }],
    })
  }
  return releaseSlot(deps, state, ok(change))
}

async function releaseSlot(
  deps: RoundGateDeps,
  state: GateState,
  outcome: WorkOutcome,
): Promise<WorkOutcome> {
  if (!state.reserved) return outcome
  const released = await deps.slots.release()
  if (released.kind !== 'ok') {
    return runScopedSlot('releasing the Work slot', released, outcome)
  }
  return outcome
}

function runScopedSlot(
  what: string,
  outcome: ReserveOutcome | ReleaseOutcome,
  carried?: WorkOutcome,
): Outcome<never, never, WorkErrorCode> {
  const evidence: Evidence[] = [{ operation: what, slotOutcome: outcome as CanonicalJsonValue }]
  if (carried !== undefined && carried.kind !== 'ok') {
    evidence.push({
      carriedOutcome: { kind: carried.kind, code: carried.code, scope: carried.scope },
    })
  }
  const reason = outcome.kind === 'ok' ? 'the slot outcome was unexpectedly ok' : outcome.reason
  return error({
    scope: 'run',
    code: 'slot-registry',
    reason: `the Work-slot registry failed while ${what}: ${reason}`,
    sharedWrite: 'none',
    evidence,
  })
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a as CanonicalJsonValue) === canonicalJson(b as CanonicalJsonValue)
  } catch {
    return false
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
}
