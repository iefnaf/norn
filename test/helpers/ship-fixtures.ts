/**
 * Shared fixtures for the Ship final-candidate reconciliation tests
 * (ticket #10).
 *
 * Two deterministic harnesses cover the two halves of design.md §11:
 *
 * - a fake-seam harness (no git at all) for the §11.1 preconditions — the
 *   git runners throw if reached, proving those paths never touch git;
 * - a real-repository harness for the §11.2 mechanics: real branches,
 *   worktrees, replays (`merge-tree`), canonical commits (`commit-tree`),
 *   ancestry, and messages. The "remote" target is the local `main` branch
 *   read through the Ship facts seam; spies record every git invocation so
 *   tests can prove no push ever happens.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ok } from '../../src/core/outcome.ts'
import type { Outcome } from '../../src/core/outcome.ts'
import { canonicalJsonDigest } from '../../src/core/digest.ts'
import { runGit, runGitDetailed } from '../../src/adapters/git-repository.ts'
import type {
  GitCommandRunner,
  GitFactsCommandResult,
  GitFactsCommandRunner,
} from '../../src/adapters/git-repository.ts'
import { CompletionStore, agentRecordedAt } from '../../src/agents/completion.ts'
import type { ReviewerCompletion } from '../../src/agents/completion.ts'
import type { AttachedAgentProcess, VisibleAgentRunner } from '../../src/agents/runner.ts'
import { evaluateTaskMapLoad } from '../../src/map/snapshot.ts'
import type { TaskMapSnapshot } from '../../src/map/snapshot.ts'
import type { StableSnapshotOutcome } from '../../src/map/stable-read.ts'
import type { AcceptedMapRevision, ShippableChange, TestEvidence } from '../../src/runstate/types.ts'
import type { CommandRunner } from '../../src/work/command-runner.ts'
import type { CommandExecution, CommandExecutionRequest } from '../../src/work/command-runner.ts'
import { commandOutputDigest } from '../../src/work/command-output.ts'
import type {
  AgentLaunchPlan,
  ReviewerLaunchInput,
} from '../../src/work/round-gate.ts'
import type {
  ShipExtensionAdoption,
  ShipFacts,
  ShipReconcileDeps,
  ShipReconcileParams,
} from '../../src/ship/reconcile.ts'
import { snapshotMapPayload } from '../../src/ship/reconcile.ts'
import { createTicketWorkspace } from '../../src/work/workspace.ts'
import { commitInWorkspace, gitText, tempGitRepository } from './round-gate-fixtures.ts'
import type { TempRepository } from './round-gate-fixtures.ts'
import { member as memberOf, rawLoad } from './map-fixtures.ts'
import type { MapOverrides, MemberOverrides } from './map-fixtures.ts'

// ---------------------------------------------------------------------------
// Map fixtures: snapshots and accepted lineage entries
// ---------------------------------------------------------------------------

export const TICKET_ISSUE_ID = 'I_7'
export const TICKET_NUMBER = 7
export const RUN_ID = 'run-9'
export const WORK_ATTEMPT_ID = 'wa-1'
export const REPOSITORY_ID = 'R_kgDOMAP'
export const HOST = 'github.com'

export const ticket7 = (overrides: MemberOverrides = {}) =>
  memberOf(TICKET_ISSUE_ID, TICKET_NUMBER, overrides)
export const memberC = () => memberOf('I_C', 9)

/** One structurally valid snapshot of the given members. */
export function snapshotOf(
  members: readonly ReturnType<typeof memberOf>[],
  mapOverrides: MapOverrides = {},
): TaskMapSnapshot {
  const evaluation = evaluateTaskMapLoad(rawLoad([...members], mapOverrides))
  if (!evaluation.valid) {
    throw new Error(`fixture map is invalid: ${JSON.stringify(evaluation.findings)}`)
  }
  return evaluation.snapshot
}

/** The accepted lineage entry of a snapshot, exactly as §13.1 persists it. */
export function acceptedEntryOf(snapshot: TaskMapSnapshot): AcceptedMapRevision {
  return { revision: snapshot.mapRevision, payload: snapshotMapPayload(snapshot).payload }
}

export function revisionOf(snapshot: TaskMapSnapshot, issueId: string): string {
  const found = snapshot.tickets.find((ticket) => ticket.ref.issueId === issueId)
  if (found === undefined) throw new Error(`fixture snapshot lacks ${issueId}`)
  return found.ticketRevision
}

/** The default accepted map: exactly ticket I_7, OPEN, no blockers. */
export function defaultMap(): TaskMapSnapshot {
  return snapshotOf([ticket7()])
}

// ---------------------------------------------------------------------------
// The sealed change
// ---------------------------------------------------------------------------

/** Minimal valid work-phase evidence bound to an exact base and tree. */
export function workEvidence(
  baseSha: string,
  treeOid: string,
  mapRevision: string,
  ticketRevision: string,
): { tests: readonly TestEvidence[]; review: ShippableChange['review'] } {
  const tests: readonly TestEvidence[] = [
    {
      phase: 'work',
      testIndex: 0,
      argv: ['npm', 'test'],
      timeoutMs: 60_000,
      baseSha,
      treeOid,
      exitCode: 0,
      outputDigest: canonicalJsonDigest({ fixture: 'work-test-output' }),
    },
  ]
  return {
    tests,
    review: {
      phase: 'work',
      provider: 'provider-b',
      model: 'provider-b/model-y',
      family: 'provider-b',
      thinking: 'high',
      verdict: 'pass',
      mapRevision,
      ticketRevision,
      baseSha,
      treeOid,
      testEvidenceDigest: canonicalJsonDigest(tests as never),
    },
  }
}

export function sealedChange(init: {
  readonly mapRevision: string
  readonly ticketRevision: string
  readonly baseSha: string
  readonly candidateCommit: string
  readonly candidateTreeOid: string
  readonly workspace: ShippableChange['workspace']
}): ShippableChange {
  const { tests, review } = workEvidence(
    init.baseSha,
    init.candidateTreeOid,
    init.mapRevision,
    init.ticketRevision,
  )
  return {
    ticket: {
      role: 'ticket',
      githubHost: HOST,
      repositoryId: REPOSITORY_ID,
      issueId: TICKET_ISSUE_ID,
      number: TICKET_NUMBER,
      url: `https://${HOST}/acme/widget/issues/${TICKET_NUMBER}`,
    },
    mapRevision: init.mapRevision,
    ticketRevision: init.ticketRevision,
    baseSha: init.baseSha,
    candidateCommit: init.candidateCommit,
    candidateTreeOid: init.candidateTreeOid,
    workspace: init.workspace,
    tests,
    review,
  }
}

// ---------------------------------------------------------------------------
// Git spies: every invocation recorded; a push would be visible
// ---------------------------------------------------------------------------

export type GitSpy = {
  readonly git: GitCommandRunner
  readonly gitDetailed: GitFactsCommandRunner
  readonly calls: readonly string[][]
}

export function gitSpy(): GitSpy {
  const calls: string[][] = []
  return {
    calls,
    git: async (args, cwd) => {
      calls.push([...args])
      return runGit(args, cwd)
    },
    gitDetailed: async (args, cwd): Promise<GitFactsCommandResult> => {
      calls.push([...args])
      return runGitDetailed(args, cwd)
    },
  }
}

export function assertNoPush(calls: readonly string[][]): void {
  const pushes = calls.filter((args) => args.includes('push') || args[0] === 'push')
  if (pushes.length !== 0) {
    throw new Error(`a push was attempted: ${JSON.stringify(pushes)}`)
  }
}

// ---------------------------------------------------------------------------
// Local-repository Ship facts: `main` is the remote target
// ---------------------------------------------------------------------------

/** Ship facts over a real local repository's branch, with a call log. */
export function localShipFacts(
  root: string,
  branch = 'main',
  events?: string[],
): ShipFacts & { calls: string[] } {
  const calls: string[] = []
  const record = (what: string): void => {
    calls.push(what)
    events?.push(`facts:${what}`)
  }
  const strip = (sha: string): string =>
    sha.startsWith('sha1:') || sha.startsWith('sha256:') ? sha.slice(sha.indexOf(':') + 1) : sha
  return {
    calls,
    async fetchTarget(target) {
      record(`fetchTarget:${target}`)
      return ok(undefined)
    },
    async targetSha(target) {
      record(`targetSha:${target}`)
      try {
        return ok(gitText(root, ['rev-parse', target]))
      } catch (cause) {
        return gitFactsError(String(cause))
      }
    },
    async commitFacts(sha) {
      record(`commitFacts:${strip(sha).slice(0, 8)}`)
      try {
        const output = gitText(root, ['show', '-s', '--format=%T%n%P', strip(sha)])
        const [treeLine = '', parentLine = ''] = output.split('\n')
        return ok({ treeOid: treeLine, parents: parentLine.split(' ').filter((p) => p !== '') })
      } catch {
        return ok(undefined)
      }
    },
    async isAncestorOfTarget(sha, target) {
      record(`isAncestor:${strip(sha).slice(0, 8)}`)
      try {
        execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', strip(sha), target])
        return ok(true)
      } catch {
        return ok(false)
      }
    },
  }
}

function gitFactsError(reason: string): Outcome<never, never, 'git-failed'> {
  return {
    kind: 'error',
    scope: 'operation',
    code: 'git-failed',
    reason,
    sharedWrite: 'none',
    evidence: [],
  } as const
}

// ---------------------------------------------------------------------------
// Fake reviewer runner and command runner
// ---------------------------------------------------------------------------

/** Fake reviewer runner: writes a real completion sidecar for the script. */
export function fakeReviewerRunner(
  verdict: () => ReviewerCompletion,
  options: { readonly launchMode?: 'run' | 'throw' } = {},
): VisibleAgentRunner & { readonly launches: number } {
  const state = { launches: 0 }
  return {
    kind: 'local-process',
    get launches() {
      return state.launches
    },
    async launch(request) {
      state.launches += 1
      if (options.launchMode === 'throw') throw new Error('scripted reviewer launch failure')
      const store = new CompletionStore(request.context.completionsDir)
      const written = await store.write(request.context, verdict(), agentRecordedAt())
      if (written.status === 'conflict') throw new Error('sidecar conflict')
      return { kind: 'local-process', adapterHandle: `fake-${state.launches}` }
    },
    attach(adapterHandle: string): AttachedAgentProcess {
      return { kind: 'local-process', adapterHandle }
    },
    async isLive(): Promise<boolean> {
      return false
    },
    async waitForExit(): Promise<'exited' | 'timeout'> {
      return 'exited'
    },
    async terminate(): Promise<'terminated' | 'terminate-failed'> {
      return 'terminated'
    },
    async release(): Promise<void> {},
  }
}

export type FakeShipCommands = CommandRunner & {
  readonly requests: readonly CommandExecutionRequest[]
}

/** A command fake whose script decides each execution; default passes. */
export function fakeShipCommands(
  script?: (request: CommandExecutionRequest, call: number) => CommandExecution | void,
): FakeShipCommands {
  const requests: CommandExecutionRequest[] = []
  let call = 0
  return {
    requests,
    async execute(request) {
      requests.push(request)
      const index = call++
      const scripted = script?.(request, index)
      if (scripted !== undefined) return scripted
      const stdout = `ship-pass-${index}`
      return {
        status: 'exited',
        exitCode: 0,
        processGroup: { state: 'settled', terminated: false },
        stdout: Buffer.from(stdout, 'utf8'),
        stderr: Buffer.from('', 'utf8'),
        outputDigest: commandOutputDigest(Buffer.from(stdout, 'utf8'), Buffer.from('', 'utf8')),
      }
    },
  }
}

/** A clean non-passing execution. */
export function commandFailure(stdout: string): CommandExecution {
  return {
    status: 'exited',
    exitCode: 1,
    processGroup: { state: 'settled', terminated: false },
    stdout: Buffer.from(stdout, 'utf8'),
    stderr: Buffer.from(stdout, 'utf8'),
    outputDigest: commandOutputDigest(Buffer.from(stdout, 'utf8'), Buffer.from(stdout, 'utf8')),
  }
}

// ---------------------------------------------------------------------------
// The real-repository harness (§11.2 mechanics)
// ---------------------------------------------------------------------------

export type RepoHarnessOptions = {
  readonly label: string
  /** Files committed to `main` before the attempt branch is cut. */
  readonly baseFiles?: readonly { readonly name: string; readonly content: string }[]
  /** File additions applied in the attempt workspace after the base. */
  readonly workerFiles?: readonly { readonly name: string; readonly content: string }[]
  /** File additions applied to `main` after the attempt branch was cut. */
  readonly targetFiles?: readonly { readonly name: string; readonly content: string }[]
  /** Edits of existing tracked files in the workspace (after additions). */
  readonly workerEdits?: readonly { readonly name: string; readonly content: string }[]
  /** Edits of existing tracked files on `main` (after additions). */
  readonly targetEdits?: readonly { readonly name: string; readonly content: string }[]
  /** The current snapshot the stable read returns (default: the accepted one). */
  readonly currentMap?: TaskMapSnapshot
  /** Scripted failure for the extension-adoption seam. */
  readonly adoptFails?: boolean
  /** The reviewer verdict script; default is one pass. */
  readonly reviewerVerdict?: () => ReviewerCompletion
  readonly reviewerLaunchMode?: 'run' | 'throw'
  /** Command script keyed by argv[0]; default passes everything. */
  readonly commandScript?: (argv: readonly string[], call: number) => CommandExecution | void
  readonly reviewerPlan?: (input: ReviewerLaunchInput) => AgentLaunchPlan
}

export type RepoHarness = {
  readonly repo: TempRepository
  readonly repositoryHome: string
  readonly deps: ShipReconcileDeps
  readonly params: ShipReconcileParams
  readonly change: ShippableChange
  readonly accepted: AcceptedMapRevision
  readonly workspacePath: string
  readonly events: string[]
  readonly gitCalls: readonly string[][]
  readonly reviewerInputs: readonly ReviewerLaunchInput[]
  readonly adoptions: readonly ShipExtensionAdoption[]
  readonly facts: ShipFacts & { calls: string[] }
  readonly commands: FakeShipCommands
  readonly runner: VisibleAgentRunner & { readonly launches: number }
  countAllCommits(): number
  cleanup(): void
}

/** One tracked-file edit committed on the current branch of `cwd`. */
export function commitFile(cwd: string, name: string, content: string, message: string): void {
  writeFileSync(join(cwd, name), content, 'utf8')
  execFileSync('git', ['-C', cwd, 'add', '-A'])
  execFileSync('git', ['-C', cwd, 'commit', '--quiet', '--no-gpg-sign', '-m', message])
}

export async function makeRepoHarness(options: RepoHarnessOptions): Promise<RepoHarness> {
  const repo = tempGitRepository(options.label)
  const home = mkdtempSync(join(tmpdir(), `norn-ship-home-${options.label}-`))
  const events: string[] = []
  const acceptedMap = defaultMap()
  const currentMap = options.currentMap ?? acceptedMap

  for (const file of options.baseFiles ?? []) {
    commitFile(repo.root, file.name, file.content, `base ${file.name}`)
  }
  const baseSha = `sha1:${gitText(repo.root, ['rev-parse', 'HEAD'])}`
  const baseTreeOid = `sha1:${gitText(repo.root, ['rev-parse', 'HEAD^{tree}'])}`

  // The attempt workspace exactly as Work leaves it (§10.1): branch at the
  // base, workspace checked out on it.
  const workspaceResult = await createTicketWorkspace(
    { git: runGit },
    {
      repositoryRoot: repo.root,
      repositoryHome: home,
      repositoryId: REPOSITORY_ID,
      runId: RUN_ID,
      ticketNumber: TICKET_NUMBER,
      workAttemptId: WORK_ATTEMPT_ID,
      base: { sha: baseSha, treeOid: baseTreeOid },
    },
  )
  if (workspaceResult.kind !== 'ok') {
    throw new Error(`fixture workspace creation failed: ${workspaceResult.reason}`)
  }
  const workspace = workspaceResult.value
  if (workspace.kind !== 'ticket') throw new Error('fixture workspace is not a ticket workspace')
  const workspacePath = workspace.path

  // Worker commits: messages deliberately resemble issue text and auto-close
  // keywords so tests can prove they never enter the canonical commit.
  const workerFiles = options.workerFiles ?? [
    { name: 'work-1.txt', content: 'first worker change\nmessage: fixes #99 and Do the thing.\n' },
    { name: 'work-2.txt', content: 'second worker change\nmessage: Closes #12 Ticket 7 body text.\n' },
  ]
  let sealed = { commit: baseSha, treeOid: baseTreeOid }
  for (const file of workerFiles) {
    sealed = commitInWorkspace(workspacePath, file.name, file.content)
  }
  for (const edit of options.workerEdits ?? []) {
    sealed = commitInWorkspace(workspacePath, edit.name, edit.content)
  }

  // Target movement after the branch was cut.
  for (const file of options.targetFiles ?? []) {
    commitFile(repo.root, file.name, file.content, `target ${file.name}`)
  }
  for (const edit of options.targetEdits ?? []) {
    commitFile(repo.root, edit.name, edit.content, `target edit ${edit.name}`)
  }

  const change = sealedChange({
    mapRevision: acceptedMap.mapRevision,
    ticketRevision: revisionOf(acceptedMap, TICKET_ISSUE_ID),
    baseSha,
    candidateCommit: sealed.commit,
    candidateTreeOid: sealed.treeOid,
    workspace,
  })

  const spy = gitSpy()
  const facts = localShipFacts(repo.root, 'main', events)
  const adoptions: ShipExtensionAdoption[] = []
  const reviewerInputs: ReviewerLaunchInput[] = []
  const runner = fakeReviewerRunner(options.reviewerVerdict ?? (() => ({ discriminant: 'pass' })), {
    launchMode: options.reviewerLaunchMode,
  })
  const script = options.commandScript
  const commands = fakeShipCommands(
    script === undefined ? undefined : (request, call) => script(request.argv, call),
  )
  let invocation = 0

  const deps: ShipReconcileDeps = {
    git: spy.git,
    gitDetailed: spy.gitDetailed,
    facts,
    readMap: () => {
      events.push('readMap')
      return Promise.resolve(ok(currentMap) as StableSnapshotOutcome)
    },
    adoptExtension: async (extension) => {
      adoptions.push(extension)
      events.push('adopt')
      return options.adoptFails === true ? adoptionScriptFailure() : ok(undefined)
    },
    readIssueEvidence: async () => ok({ comments: [], timeline: [] }),
    runner,
    commands,
    planReviewer: (input) => {
      reviewerInputs.push(input)
      events.push('planReviewer')
      if (options.reviewerPlan !== undefined) return options.reviewerPlan(input)
      return { argv: ['pi', '--tools', 'read,grep,find,ls,norn_complete'] }
    },
    newInvocationId: () => `ship-rev-${++invocation}`,
  }

  const params: ShipReconcileParams = {
    change,
    accepted: acceptedEntryOf(acceptedMap),
    runId: RUN_ID,
    repositoryRoot: repo.root,
    targetBranch: 'main',
    setup: [{ argv: ['setup-cmd'], timeoutMs: 60_000 }],
    tests: [
      { argv: ['npm', 'test'], timeoutMs: 60_000 },
      { argv: ['npm', 'run', 'lint'], timeoutMs: 60_000 },
    ],
    reviewer: { model: 'provider-b/model-y', thinking: 'high', timeoutMs: 60_000, family: 'provider-b' },
    trustedEvidenceAuthorIds: ['I_actor'],
    completionsDir: join(home, 'runs', RUN_ID, 'completions'),
    alreadyShipped: false,
  }

  return {
    repo,
    repositoryHome: home,
    deps,
    params,
    change,
    accepted: params.accepted,
    workspacePath,
    events,
    gitCalls: spy.calls,
    reviewerInputs,
    adoptions,
    facts,
    commands,
    runner,
    countAllCommits: () =>
      Number(
        execFileSync(
          'git',
          ['-C', repo.root, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'],
          { encoding: 'utf8' },
        )
          .split('\n')
          .filter((line) => line.endsWith(' commit')).length,
      ),
    cleanup: () => {
      rmSync(home, { recursive: true, force: true })
      repo.cleanup()
    },
  }
}

function adoptionScriptFailure(): Outcome<void, never, 'control-store'> {
  return {
    kind: 'error',
    scope: 'run',
    code: 'control-store',
    reason: 'scripted adoption failure',
    sharedWrite: 'none',
    evidence: [],
  } as const
}

/** A tracked file both sides may edit, to construct replay conflicts. */
export const SHARED_FILE = 'shared.txt'
export const SHARED_FILE_BASE = 'line one\nline two\nline three\n'
export const WORKER_LINE = 'line two rewritten by the worker\n'
export const TARGET_LINE = 'line two rewritten by the target\n'
