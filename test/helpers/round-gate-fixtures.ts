/**
 * Shared fixtures for the Work round gate tests (ticket #9).
 *
 * The gate runs against a real temporary git repository (real branches,
 * worktrees, OIDs, lineage, and diffs) with fake agents, fake command
 * executions, an in-memory attempt store, and an in-memory slot seam. The
 * fake agent runner performs its scripted effects — real `git` commits in
 * the attempt workspace — and then writes its completion sidecar through
 * the same `CompletionStore` path a real agent uses, so settlement,
 * independent OID reads, and evidence binding are exercised end to end
 * without a single Pi launch.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ok } from '../../src/core/outcome.ts'
import type { RunConfigCommand } from '../../src/config/run-config.ts'
import { runGit } from '../../src/adapters/git-repository.ts'
import type { GitCommandRunner } from '../../src/adapters/git-repository.ts'
import type { ReviewerCompletion, WorkerCompletion } from '../../src/agents/completion.ts'
import { CompletionStore, agentRecordedAt } from '../../src/agents/completion.ts'
import type {
  AgentLaunchRequest,
  AttachedAgentProcess,
  VisibleAgentRunner,
} from '../../src/agents/runner.ts'
import type { ProcessGroupCheckpoint, WorkInput } from '../../src/runstate/types.ts'
import { commandOutputDigest } from '../../src/work/command-output.ts'
import type { CommandExecution, CommandExecutionRequest, CommandRunner } from '../../src/work/command-runner.ts'
import type {
  AgentLaunchPlan,
  ReviewerLaunchInput,
  RoundGateDeps,
  RoundGateStore,
  WorkAttemptParams,
  WorkAttemptRecord,
  WorkAttemptTerminal,
  WorkOutcome,
  WorkSlotSeam,
  WorkerLaunchInput,
} from '../../src/work/round-gate.ts'
import { completionsDirFor, runWorkAttempt } from '../../src/work/round-gate.ts'
import { createTicketWorkspace } from '../../src/work/workspace.ts'

// ---------------------------------------------------------------------------
// Real temporary repositories
// ---------------------------------------------------------------------------

export type TempRepository = {
  readonly root: string
  readonly baseSha: string
  readonly baseTreeHex: string
  readonly cleanup: () => void
}

export function tempGitRepository(label: string): TempRepository {
  const scratch = mkdtempSync(join(tmpdir(), `norn-round-gate-${label}-`))
  const root = join(scratch, 'repo')
  execFileSync('git', ['init', '--quiet', '-b', 'main', root])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'norn@example.invalid'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Norn Test'])
  writeFileSync(join(root, 'README.md'), '# temp\n', 'utf8')
  execFileSync('git', ['-C', root, 'add', '.'])
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'init'])
  const baseSha = gitText(root, ['rev-parse', 'HEAD'])
  const baseTreeHex = gitText(root, ['rev-parse', 'HEAD^{tree}'])
  return { root, baseSha, baseTreeHex, cleanup: () => rmSync(scratch, { recursive: true, force: true }) }
}

export function tempRepositoryHome(label: string): { readonly home: string; readonly cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), `norn-round-gate-home-${label}-`))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

export function gitText(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

export type GitOids = { readonly commit: string; readonly treeOid: string }

/** The independently read commit and tree OIDs of a workspace's HEAD. */
export function readWorkspaceOids(workspacePath: string): GitOids {
  return {
    commit: `sha1:${gitText(workspacePath, ['rev-parse', 'HEAD'])}`,
    treeOid: `sha1:${gitText(workspacePath, ['rev-parse', 'HEAD^{tree}'])}`,
  }
}

/** Commit one file change on the workspace's current branch. */
export function commitInWorkspace(workspacePath: string, name: string, content: string): GitOids {
  writeFileSync(join(workspacePath, name), content, 'utf8')
  execFileSync('git', ['-C', workspacePath, 'add', '-A'])
  execFileSync('git', ['-C', workspacePath, 'commit', '--quiet', '--no-gpg-sign', '-m', name])
  return readWorkspaceOids(workspacePath)
}

/** Leave a non-ignored untracked file in the workspace. */
export function writeUntracked(workspacePath: string, name: string): void {
  writeFileSync(join(workspacePath, name), 'untracked\n', 'utf8')
}

// ---------------------------------------------------------------------------
// Fake agents: scripted effects plus real completion sidecars
// ---------------------------------------------------------------------------

/** The tools every test script receives. */
export type ScriptTools = {
  /** The most recent state the attempt store persisted, live. */
  latestRecord(): WorkAttemptRecord | undefined
  /** The base commit and tree OIDs of the Work input. */
  baseOids(): GitOids
  /** Ordered cross-fake event log: store saves and agent launches. */
  readonly events: readonly string[]
}

export type WorkerScript = (
  launch: { readonly workspacePath: string; readonly round: number },
  tools: ScriptTools,
) => Promise<WorkerCompletion> | WorkerCompletion

export type ReviewerScript = (
  launch: { readonly workspacePath: string; readonly input: ReviewerLaunchInput; readonly call: number },
  tools: ScriptTools,
) => Promise<ReviewerCompletion> | ReviewerCompletion

export type AgentMode = 'run' | 'hang' | 'exit-no-sidecar' | 'throw'

export type LaunchRecord = {
  readonly role: 'worker' | 'reviewer'
  readonly invocationId: string
  readonly round: number | null
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export type FakeAgents = VisibleAgentRunner & {
  readonly launches: readonly LaunchRecord[]
  readonly terminated: readonly string[]
}

/**
 * The fake Visible Agent Runner: `launch` runs the script (real git effects,
 * then the completion sidecar through `CompletionStore`), `waitForExit`
 * returns immediately, and `terminate` records the interrupted invocation.
 * A mode of `hang` or `exit-no-sidecar` launches without writing a sidecar;
 * `waitForExit` then never resolves or resolves with no sidecar present, so
 * the settlement engine reports timeout or protocol-error.
 */
export function fakeAgentRunner(
  script: {
    readonly worker?: WorkerScript
    readonly reviewer?: ReviewerScript
    readonly workerMode?: AgentMode
    readonly reviewerMode?: AgentMode
    readonly onLaunch?: (role: 'worker' | 'reviewer', invocationId: string) => void
    readonly latestReviewerInput?: () => ReviewerLaunchInput | undefined
  },
  tools: ScriptTools,
): FakeAgents {
  const launches: LaunchRecord[] = []
  const terminated: string[] = []
  const hangingHandles = new Set<string>()
  let reviewerCalls = 0
  let nextHandle = 0

  return {
    kind: 'local-process',
    launches,
    terminated,
    async launch(request) {
      const role = request.context.role
      const invocationId = request.context.invocationId
      const round = request.context.work?.round ?? null
      launches.push({ role, invocationId, round, argv: request.argv, env: (request.env ?? {}) as Record<string, string> })
      ;(tools.events as string[]).push(`launch:${invocationId}`)
      script.onLaunch?.(role, invocationId)

      const mode = role === 'worker' ? (script.workerMode ?? 'run') : (script.reviewerMode ?? 'run')
      if (mode === 'throw') throw new Error(`scripted ${role} launch failure`)
      const handle = `fake-${nextHandle++}`
      if (mode === 'hang') {
        hangingHandles.add(handle)
        return { kind: 'local-process', adapterHandle: handle }
      }
      if (mode === 'exit-no-sidecar') {
        return { kind: 'local-process', adapterHandle: handle }
      }

      const completion =
        role === 'worker'
          ? await script.worker?.({ workspacePath: request.cwd, round: round ?? 0 }, tools)
          : await script.reviewer?.(
              {
                workspacePath: request.cwd,
                input: script.latestReviewerInput?.() ?? failNoReviewerInput(),
                call: reviewerCalls++,
              },
              tools,
            )
      if (completion === undefined) throw new Error(`no ${role} script was provided`)

      const store = new CompletionStore(request.context.completionsDir)
      const written = await store.write(request.context, completion, agentRecordedAt())
      assert.notEqual(written.status, 'conflict', 'the sidecar must not conflict')
      return { kind: 'local-process', adapterHandle: handle }
    },
    attach(adapterHandle: string): AttachedAgentProcess {
      return { kind: 'local-process', adapterHandle }
    },    async isLive(): Promise<boolean> {
      return false
    },
    async waitForExit(processRef: AttachedAgentProcess): Promise<'exited' | 'timeout'> {
      if (hangingHandles.has(processRef.adapterHandle)) {
        await new Promise<void>(() => undefined)
      }
      return 'exited'
    },
    async terminate(processRef) {
      terminated.push(processRef.adapterHandle)
      return 'terminated'
    },
  }
}

function failNoReviewerInput(): ReviewerLaunchInput {
  throw new Error('the reviewer script ran without a recorded reviewer input')
}

/** The default happy-path worker: one file commit per round. */
export function committingWorker(): WorkerScript {
  return ({ workspacePath, round }) => {
    const oids = commitInWorkspace(workspacePath, `work-${round}.txt`, `round ${round}\n`)
    return { discriminant: 'candidate', claimedCommit: oids.commit, claimedTreeOid: oids.treeOid }
  }
}

/** A worker that hands off the unchanged base (zero-delta candidate). */
export function zeroDeltaWorker(): WorkerScript {
  return (_launch, tools) => ({
    discriminant: 'candidate',
    claimedCommit: tools.baseOids().commit,
    claimedTreeOid: tools.baseOids().treeOid,
  })
}

// ---------------------------------------------------------------------------
// Fake command runner
// ---------------------------------------------------------------------------

export type FakeCommands = CommandRunner & {
  readonly requests: readonly CommandExecutionRequest[]
}

/**
 * A Command runner fake whose script decides each execution. The default
 * passes every command with distinguishable output (`pass-<call>`), so test
 * evidence digests differ per round and per command.
 */
export function scriptedCommands(
  script?: (request: CommandExecutionRequest, call: number) => CommandExecution,
  events?: string[],
): FakeCommands {
  const requests: CommandExecutionRequest[] = []
  let call = 0
  return {
    requests,
    async execute(request) {
      requests.push(request)
      events?.push(`command:${request.argv.join(' ')}:${call}`)
      const index = call++
      if (script !== undefined) return script(request, index)
      return passed(`pass-${index}`)
    },
  }
}

/** A protocol-valid passing execution with the given stdout text. */
export function passed(stdout: string): CommandExecution {
  return {
    status: 'exited',
    exitCode: 0,
    processGroup: { state: 'settled', terminated: false },
    stdout: Buffer.from(stdout, 'utf8'),
    stderr: Buffer.from('', 'utf8'),
    outputDigest: commandOutputDigest(Buffer.from(stdout, 'utf8'), Buffer.from('', 'utf8')),
  }
}

/** A protocol-valid clean non-pass: exit code 1. */
export function failed(stdout: string): CommandExecution {
  return {
    status: 'exited',
    exitCode: 1,
    processGroup: { state: 'settled', terminated: false },
    stdout: Buffer.from(stdout, 'utf8'),
    stderr: Buffer.from(stdout, 'utf8'),
    outputDigest: commandOutputDigest(Buffer.from(stdout, 'utf8'), Buffer.from(stdout, 'utf8')),
  }
}

/** The framed digest a passing `pass-N` execution captures. */
export function passDigest(n: number): string {
  const stdout = Buffer.from(`pass-${n}`, 'utf8')
  return commandOutputDigest(stdout, Buffer.from('', 'utf8'))
}

// ---------------------------------------------------------------------------
// Fake attempt store and slot seam
// ---------------------------------------------------------------------------

export type TerminalRecord = {
  readonly workAttemptId: string
  readonly terminal: WorkAttemptTerminal
  readonly processes: readonly ProcessGroupCheckpoint[]
}

export type FakeStore = RoundGateStore & {
  readonly working: readonly WorkAttemptRecord[]
  readonly terminals: readonly TerminalRecord[]
  latestRecord(): WorkAttemptRecord | undefined
}

export function fakeStore(initial?: WorkAttemptRecord, events?: string[]): FakeStore {
  const working: WorkAttemptRecord[] = initial === undefined ? [] : [initial]
  const terminals: TerminalRecord[] = []
  return {
    working,
    terminals,
    latestRecord: () => working.at(-1),
    async load(workAttemptId) {
      return ok(working.find((record) => record.attempt.workAttemptId === workAttemptId))
    },
    async saveWorking(record) {
      working.push(record)
      events?.push(`saveWorking:${record.attempt.round}:${record.attempt.slot}`)
      return ok(undefined)
    },
    async saveTerminal(workAttemptId, terminal, processes) {
      terminals.push({ workAttemptId, terminal, processes })
      events?.push(`saveTerminal:${terminal.kind}`)
      return ok(undefined)
    },
  }
}

export type FakeSlots = WorkSlotSeam & {
  readonly reserveCalls: number
  readonly releaseCalls: number
}

export function fakeSlots(
  behavior: { readonly reserve?: 'ok' | 'full' | 'fail'; readonly releaseFails?: boolean } = {},
): FakeSlots {
  const calls = { reserve: 0, release: 0 }
  return {
    get reserveCalls() {
      return calls.reserve
    },
    get releaseCalls() {
      return calls.release
    },
    async reserve() {
      calls.reserve++
      const mode = behavior.reserve ?? 'ok'
      if (mode === 'fail') {
        return {
          kind: 'error' as const,
          scope: 'operation' as const,
          code: 'slot-registry' as const,
          reason: 'scripted registry failure',
          sharedWrite: 'none' as const,
          evidence: [],
        }
      }
      return ok({ reserved: mode === 'ok' })
    },
    async release() {
      calls.release++
      if (behavior.releaseFails === true) {
        return {
          kind: 'error' as const,
          scope: 'operation' as const,
          code: 'slot-registry' as const,
          reason: 'scripted release failure',
          sharedWrite: 'none' as const,
          evidence: [],
        }
      }
      return ok(undefined)
    },
  }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

const HOST = 'github.com'
const REPOSITORY_ID = 'R_1'
export const MAP_ISSUE_ID = 'I_map'
export const TICKET_ISSUE_ID = 'I_7'
const RUN_ID = 'run-9'
const WORK_ATTEMPT_ID = 'wa-1'

export function ticketInput(baseSha: string, baseTreeHex: string): WorkInput {
  return {
    ticket: {
      role: 'ticket',
      githubHost: HOST,
      repositoryId: REPOSITORY_ID,
      issueId: TICKET_ISSUE_ID,
      number: 7,
      url: `https://${HOST}/iefnaf/norn/issues/7`,
    },
    spec: {
      mapTitle: 'The map',
      mapBody: 'Shared intent.',
      mapRevision: 'sha256:' + '1'.repeat(64),
      ticketTitle: 'Ticket 7',
      ticketBody: 'Do the thing.',
      ticketRevision: 'sha256:' + '2'.repeat(64),
    },
    target: {
      branch: 'main',
      baseSha: `sha1:${baseSha}`,
      baseTreeOid: `sha1:${baseTreeHex}`,
    },
  }
}

export function attemptRecord(
  input: WorkInput,
  repositoryHome: string,
  changes: Partial<WorkAttemptRecord['attempt']> = {},
): WorkAttemptRecord {
  const branch = `norn/${RUN_ID}/${input.ticket.number}/${WORK_ATTEMPT_ID}`
  return {
    attempt: {
      workAttemptId: WORK_ATTEMPT_ID,
      input,
      branch,
      workspace: {
        kind: 'ticket',
        repositoryId: REPOSITORY_ID,
        runId: RUN_ID,
        path: join(
          repositoryHome,
          'runs',
          RUN_ID,
          'workspaces',
          String(input.ticket.number),
          WORK_ATTEMPT_ID,
        ),
        branch,
        workAttemptId: WORK_ATTEMPT_ID,
      },
      round: 0,
      slot: 'awaiting-reservation',
      processGroupIds: [],
      ...changes,
    },
    processes: [],
  }
}

export type Harness = {
  readonly repo: TempRepository
  readonly repositoryHome: string
  readonly params: WorkAttemptParams
  readonly input: WorkInput
  readonly workspacePath: string
  readonly runner: FakeAgents
  readonly commands: FakeCommands
  readonly store: FakeStore
  readonly slots: FakeSlots
  readonly workerInputs: readonly WorkerLaunchInput[]
  readonly reviewerInputs: readonly ReviewerLaunchInput[]
  readonly events: readonly string[]
  readonly deps: RoundGateDeps
  run(signal?: AbortSignal): Promise<WorkOutcome>
  baseOids(): GitOids
  readonly git: GitCommandRunner
  cleanup(): void
}

export type HarnessOptions = {
  readonly label: string
  readonly worker?: WorkerScript
  readonly reviewer?: ReviewerScript
  readonly workerMode?: AgentMode
  readonly reviewerMode?: AgentMode
  readonly commandScript?: (request: CommandExecutionRequest, call: number) => CommandExecution
  readonly setup?: readonly RunConfigCommand[]
  readonly tests?: readonly RunConfigCommand[]
  readonly maxWorkRounds?: number
  readonly initialRecord?: WorkAttemptRecord
  readonly slots?: { readonly reserve?: 'ok' | 'full' | 'fail'; readonly releaseFails?: boolean }
  readonly store?: FakeStore
  readonly onLaunch?: (role: 'worker' | 'reviewer', invocationId: string) => void
  readonly reviewerPlannerOverride?: (input: ReviewerLaunchInput) => AgentLaunchPlan
  readonly git?: GitCommandRunner
}

/** Build a complete round-gate harness over a fresh real repository. */
export function makeHarness(options: HarnessOptions): Harness {
  const repo = tempGitRepository(options.label)
  const home = tempRepositoryHome(options.label)
  const input = ticketInput(repo.baseSha, repo.baseTreeHex)
  const workspacePath = join(
    home.home,
    'runs',
    RUN_ID,
    'workspaces',
    String(input.ticket.number),
    WORK_ATTEMPT_ID,
  )
  const events: string[] = []
  const store = options.store ?? fakeStore(options.initialRecord, events)
  const baseOids = (): GitOids => ({
    commit: `sha1:${repo.baseSha}`,
    treeOid: `sha1:${repo.baseTreeHex}`,
  })
  const tools: ScriptTools = {
    events,
    latestRecord: () => store.latestRecord(),
    baseOids,
  }

  const workerInputs: WorkerLaunchInput[] = []
  const reviewerInputs: ReviewerLaunchInput[] = []
  const runner = fakeAgentRunner(
    {
      worker: options.worker,
      reviewer: options.reviewer,
      workerMode: options.workerMode,
      reviewerMode: options.reviewerMode,
      onLaunch: options.onLaunch,
      latestReviewerInput: () => reviewerInputs.at(-1),
    },
    tools,
  )
  const commands = scriptedCommands(options.commandScript, events)
  const slots = fakeSlots(options.slots)

  const params: WorkAttemptParams = {
    input,
    workAttemptId: WORK_ATTEMPT_ID,
    map: { githubHost: HOST, repositoryId: REPOSITORY_ID, issueId: MAP_ISSUE_ID },
    repositoryRoot: repo.root,
    repositoryHome: home.home,
    repositoryId: REPOSITORY_ID,
    runId: RUN_ID,
    completionsDir: completionsDirFor(home.home, RUN_ID),
    setup: options.setup ?? [],
    tests: options.tests ?? [{ argv: ['npm', 'test'], timeoutMs: 60_000 }],
    maxWorkRounds: options.maxWorkRounds ?? 3,
    agents: {
      worker: { model: 'provider-a/model-x', thinking: 'medium', timeoutMs: 60_000 },
      reviewer: { model: 'provider-b/model-y', thinking: 'high', timeoutMs: 60_000, family: 'provider-b' },
    },
  }

  const deps: RoundGateDeps = {
    runner,
    commands,
    git: options.git ?? runGit,
    store,
    slots,
    planWorker: (launchInput) => {
      workerInputs.push(launchInput)
      events.push(`planWorker:${launchInput.round}`)
      return { argv: ['fake-worker'] }
    },
    planReviewer: (launchInput) => {
      reviewerInputs.push(launchInput)
      events.push('planReviewer')
      if (options.reviewerPlannerOverride !== undefined) {
        return options.reviewerPlannerOverride(launchInput)
      }
      // A read-only argv so the default validator accepts the plan.
      return { argv: ['pi', '--tools', 'read,grep,find,ls,norn_complete'] }
    },
  }

  return {
    repo,
    repositoryHome: home.home,
    params,
    input,
    workspacePath,
    runner,
    commands,
    store,
    slots,
    workerInputs,
    reviewerInputs,
    events,
    deps,
    run: (signal?: AbortSignal) =>
      runWorkAttempt(deps, signal === undefined ? params : { ...params, signal }),
    baseOids,
    git: deps.git,
    cleanup: () => {
      repo.cleanup()
      home.cleanup()
    },
  }
}

/** Create the attempt workspace ahead of a resumed run (pre-crash state). */
export async function preCreateWorkspace(harness: Harness): Promise<void> {
  const created = await createTicketWorkspace(
    { git: harness.git },
    {
      repositoryRoot: harness.repo.root,
      repositoryHome: harness.repositoryHome,
      repositoryId: REPOSITORY_ID,
      runId: RUN_ID,
      ticketNumber: harness.input.ticket.number,
      workAttemptId: WORK_ATTEMPT_ID,
      base: { sha: harness.input.target.baseSha, treeOid: harness.input.target.baseTreeOid },
    },
  )
  assert.equal(created.kind, 'ok')
}
