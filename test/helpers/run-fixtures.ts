/**
 * Shared fixtures for the wave-execution and run-lifecycle tests (ticket #13,
 * design.md §12–§13).
 *
 * One deterministic harness covers the five seams end to end:
 *
 * - the **Git side is real**: a temporary repository with a bare remote, so
 *   Work branches, workspaces, candidate verification, canonical commits,
 *   replay (`merge-tree`), non-force pushes, fetches, and ancestry all run
 *   through real git plumbing;
 * - the **GitHub side is fake**: a scriptable, mutable multi-issue gateway
 *   serves the Task Map loader, the delivery-evidence reader, and the issue
 *   writer (comments, close, reopen) over plain data whose states the map
 *   loader derives, so map topology and issue state never disagree;
 * - the **agents are fake**: workers perform their scripted effect (real
 *   commits in the attempt workspace) and write real completion sidecars;
 *   reviewers pass;
 * - the **model catalog is fake**: two models in different provider families;
 * - the **control store, locks, and the Work-slot registry are real** under a
 *   temporary Norn home.
 *
 * Map changes (extensions, edits) are staged as `changes` applied at load
 * boundaries when an observable progress predicate first holds, so the
 * stable-read protocol (§7.3) always reads one consistent world per load and
 * tests script "the map changed at the barrier" deterministically.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ok } from '../../src/core/outcome.ts'
import type { Sha256Digest } from '../../src/core/digest.ts'
import type { GitRemote, GitRepositoryAdapter } from '../../src/adapters/git-repository.ts'
import { gitCliDeliveryFacts, gitCliPush, runGit, runGitDetailed } from '../../src/adapters/git-repository.ts'
import type { GitHubGatewayAdapter } from '../../src/adapters/github-gateway.ts'
import type { ModelCatalogAdapter } from '../../src/adapters/model-catalog.ts'
import { CompletionStore, agentRecordedAt } from '../../src/agents/completion.ts'
import type { AgentCompletion, ReviewerCompletion, WorkerCompletion } from '../../src/agents/completion.ts'
import type {
  AgentLaunchRequest,
  AttachedAgentProcess,
  VisibleAgentRunner,
} from '../../src/agents/runner.ts'
import { fsControlStore } from '../../src/control/control-store.ts'
import type { LocalControlStore } from '../../src/control/control-store.ts'
import { encodePathSegment } from '../../src/config/paths.ts'
import { evaluateTaskMapLoad } from '../../src/map/snapshot.ts'
import type { TaskMapSnapshot } from '../../src/map/snapshot.ts'
import { snapshotMapPayload } from '../../src/ship/reconcile.ts'
import type { TaskMapLoader, TaskMapLoadOutcome, RawMemberIssue, RawTaskMapLoad } from '../../src/map/loader.ts'
import { member as memberOf, rawLoad, rawRef } from './map-fixtures.ts'
import type { MapOverrides } from './map-fixtures.ts'
import { osTargetLock } from '../../src/ship/push.ts'
import { runMap } from '../../src/run/lifecycle.ts'
import type { RunLifecycleDeps, RunMapOutcome } from '../../src/run/lifecycle.ts'
import { loadRunState } from '../../src/runstate/run-state-store.ts'
import type { ProcessGroupCheckpoint, RunState } from '../../src/runstate/types.ts'
import { NORN_VERSION } from '../../src/version.ts'
import { resolveRunConfigText } from '../../src/config/run-config.ts'
import { fakeIssueGateway, fakeIssue } from './close-fixtures.ts'
import type { FakeGateway, FakeIssueState, GatewayScript } from './close-fixtures.ts'
import { fakeShipCommands } from './ship-fixtures.ts'
import type { FakeShipCommands } from './ship-fixtures.ts'
import { tempBareRemote } from './push-fixtures.ts'
import type { BareRemote } from './push-fixtures.ts'
import type { TempRepository } from './round-gate-fixtures.ts'
import {
  commitInWorkspace,
  gitText,
  readWorkspaceOids,
  tempGitRepository,
} from './round-gate-fixtures.ts'

// ---------------------------------------------------------------------------
// Fixture identities
// ---------------------------------------------------------------------------

export const HOST = 'github.com'
export const REPOSITORY_ID = 'R_kgDOMAP'
export const MAP_ISSUE_ID = 'I_map'
export const MAP_NUMBER = 6
export const MAP_URL = `https://${HOST}/acme/widget/issues/${MAP_NUMBER}`
export const ACTOR_ID = 'I_actor'
export const SEALED_AT = '2025-01-02T03:04:05.006Z'
export const ENCODED_MAP = encodePathSegment(MAP_ISSUE_ID)

const REMOTE_URL = `https://${HOST}/acme/widget.git`

const REPOSITORY = {
  githubHost: HOST,
  repositoryId: REPOSITORY_ID,
  owner: 'acme',
  name: 'widget',
  defaultBranch: 'main',
}

function configRevisionOfFixture(): Sha256Digest {
  const resolved = resolveRunConfigText(RUN_CONFIG_JSON)
  if (resolved.kind !== 'ok') throw new Error('fixture config is invalid')
  return resolved.value.configRevision
}

export const RUN_CONFIG_JSON = `${JSON.stringify(
  {
    schema: 'norn-run:v1',
    targetBranch: 'main',
    setup: [],
    tests: [{ argv: ['npm', 'test'], timeoutMs: 60_000 }],
    maxWorkRounds: 2,
    maxPushRetries: 1,
    concurrency: 4,
    worker: { model: 'provider-a/model-x', thinking: 'medium', timeoutMs: 60_000 },
    reviewer: { model: 'provider-b/model-y', thinking: 'high', timeoutMs: 60_000 },
    trustedEvidenceAuthorIds: [ACTOR_ID],
  },
  null,
  2,
)}\n`

// ---------------------------------------------------------------------------
// The mutable fake map and its observable progress counters
// ---------------------------------------------------------------------------

/** What one fake worker does with its attempt workspace (§10.2). */
export type WorkerBehavior =
  | { readonly kind: 'commit' }
  | { readonly kind: 'zero-delta' }
  | { readonly kind: 'block' }
  | { readonly kind: 'file'; readonly name: string; readonly content: string }

/** One member Ticket of the fake map. */
export type MemberSpec = {
  readonly issueId: string
  readonly number: number
  readonly blockers?: readonly string[]
  readonly worker?: WorkerBehavior
  readonly title?: string
  readonly body?: string
}

/** Observable progress of the coordinator, for staging map changes. */
export type Observed = {
  readonly mapReads: number
  readonly workerLaunches: number
  readonly workReviewerLaunches: number
  readonly shipReviewerLaunches: number
  readonly pushes: number
  readonly closeCalls: number
  readonly commentCalls: number
  readonly reopenCalls: number
}

/** One staged map change, applied at a load boundary when first due. */
export type StagedChange = {
  readonly when: (observed: Observed) => boolean
  readonly apply: (store: RunMapStore) => void
}

/** GatewayScript with writable fields, so tests can arm and clear failures. */
export type MutableGatewayScript = { -readonly [K in keyof GatewayScript]: GatewayScript[K] }

/** The mutable fake Task Map world: members, issue states, staged changes. */
export class RunMapStore {
  members: MemberSpec[]
  behaviors: Record<string, WorkerBehavior>
  readonly issues = new Map<number, FakeIssueState>()
  readonly changes: StagedChange[] = []
  readonly script: MutableGatewayScript = {}
  /** When set, every map load from this read index on fails (§7.3 loader error). */
  failReadsFrom: number | undefined
  readonly observed = {
    mapReads: 0,
    workerLaunches: 0,
    workReviewerLaunches: 0,
    shipReviewerLaunches: 0,
    pushes: 0,
    closeCalls: 0,
    commentCalls: 0,
    reopenCalls: 0,
  }

  constructor(members: readonly MemberSpec[], behaviors: Readonly<Record<string, WorkerBehavior>> = {}) {
    this.members = [...members]
    // Each member's own `worker` behavior is its default; explicit
    // behaviors override it and tests may mutate them between runs.
    this.behaviors = {
      ...Object.fromEntries(
        members.flatMap((spec) => (spec.worker === undefined ? [] : [[spec.issueId, spec.worker]])),
      ),
      ...behaviors,
    }
    this.issues.set(MAP_NUMBER, fakeIssue('OPEN'))
    for (const spec of members) this.issues.set(spec.number, fakeIssue('OPEN'))
  }

  /** Apply every due staged change; called once before each map load. */
  applyDue(): void {
    for (const change of this.changes) {
      if (change.when(this.observed)) {
        change.apply(this)
        this.changes.splice(this.changes.indexOf(change), 1)
      }
    }
  }

  addMember(spec: MemberSpec): void {
    this.members = [...this.members, spec]
    this.issues.set(spec.number, fakeIssue('OPEN'))
  }

  editMember(issueId: string, edit: Partial<Pick<MemberSpec, 'title' | 'body'>>): void {
    this.members = this.members.map((spec) =>
      spec.issueId === issueId ? { ...spec, ...edit } : spec,
    )
  }
}

/** One complete raw load of the current map world (§7.2-valid). */
function loadOf(store: RunMapStore): RawTaskMapLoad {
  const numberByIssueId = new Map(store.members.map((spec) => [spec.issueId, spec.number]))
  const members: RawMemberIssue[] = store.members.map((spec) =>
    memberOf(spec.issueId, spec.number, {
      title: spec.title ?? `Ticket ${spec.issueId}`,
      body: spec.body ?? `Body of ${spec.issueId}`,
      state: store.issues.get(spec.number)?.state ?? 'OPEN',
      blockers: (spec.blockers ?? []).map((id) => rawRef(id, numberByIssueId.get(id) ?? 0)),
    }),
  )
  const mapOverrides: MapOverrides =
    store.issues.get(MAP_NUMBER)?.state === 'CLOSED' ? { state: 'CLOSED' } : {}
  const load = rawLoad(members, mapOverrides)
  return load
}

// ---------------------------------------------------------------------------
// The fake agents
// ---------------------------------------------------------------------------

export type AgentLaunchRecord = {
  readonly role: 'worker' | 'reviewer'
  readonly phase: 'work' | 'ship' | 'map-completion'
  readonly invocationId: string
  readonly ticketIssueId: string | undefined
  readonly round: number | null
  readonly cwd: string
}

export type FakeRunAgents = VisibleAgentRunner & {
  readonly launches: readonly AgentLaunchRecord[]
  workerBehavior(issueId: string): WorkerBehavior
}

/** Workers keyed by ticket issue ID; the reviewer verdict is scriptable. */
export function fakeRunRunner(
  store: RunMapStore,
  reviewer: () => ReviewerCompletion = () => ({ discriminant: 'pass' }),
): FakeRunAgents {
  const launches: AgentLaunchRecord[] = []
  let nextHandle = 0
  return {
    kind: 'local-process',
    launches,
    workerBehavior(issueId) {
      return store.behaviors[issueId] ?? { kind: 'commit' }
    },
    async launch(request: AgentLaunchRequest) {
      const context = request.context
      launches.push({
        role: context.role,
        phase: context.phase,
        invocationId: context.invocationId,
        ticketIssueId: context.ticket?.issueId,
        round: context.work?.round ?? null,
        cwd: request.cwd,
      })
      if (context.role === 'worker') store.observed.workerLaunches += 1
      else if (context.phase === 'work') store.observed.workReviewerLaunches += 1
      else store.observed.shipReviewerLaunches += 1

      const completion: AgentCompletion =
        context.role === 'worker'
          ? performWorker(this.workerBehavior(context.ticket!.issueId), request)
          : reviewer()
      const sidecarStore = new CompletionStore(context.completionsDir)
      const written = await sidecarStore.write(context, completion, agentRecordedAt())
      if (written.status === 'conflict') throw new Error('sidecar conflict')
      return { kind: 'local-process', adapterHandle: `fake-${nextHandle++}` }
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
  }
}

function performWorker(behavior: WorkerBehavior, request: AgentLaunchRequest): WorkerCompletion {
  if (behavior.kind === 'block') {
    return { discriminant: 'block', code: 'cannot-satisfy-spec', reason: 'scripted worker block' }
  }
  if (behavior.kind === 'zero-delta') {
    const oids = readWorkspaceOids(request.cwd)
    return { discriminant: 'candidate', claimedCommit: oids.commit, claimedTreeOid: oids.treeOid }
  }
  const round = request.context.work?.round ?? 1
  const file =
    behavior.kind === 'file'
      ? { name: behavior.name, content: behavior.content }
      : { name: `work-${request.context.ticket!.issueId}-r${round}.txt`, content: `work ${round}\n` }
  const oids = commitInWorkspace(request.cwd, file.name, file.content)
  return { discriminant: 'candidate', claimedCommit: oids.commit, claimedTreeOid: oids.treeOid }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export type RunHarnessOptions = {
  readonly label: string
  readonly members: readonly MemberSpec[]
  /** Worker behaviors keyed by ticket issue ID; default: one commit. */
  readonly behaviors?: Readonly<Record<string, WorkerBehavior>>
  /** The reviewer verdict script; default: pass. */
  readonly reviewer?: () => ReviewerCompletion
  /** Staged map changes applied at load boundaries. */
  readonly changes?: readonly StagedChange[]
  /** Overrides the gateway write script (failures model unknown results). */
  readonly gatewayScript?: GatewayScript
  /** Deterministic run IDs; default: run-1, run-2, ... per harness. */
  readonly newRunId?: () => string
}

export type RunHarness = {
  readonly repo: TempRepository
  readonly remote: BareRemote
  readonly nornHome: string
  readonly repositoryHome: string
  readonly store: RunMapStore
  readonly gateway: FakeGateway
  readonly runner: FakeRunAgents
  readonly commands: FakeShipCommands
  /** The ticket issue IDs that have been worked, in launch order. */
  workedTickets(): readonly string[]
  /** The full lifecycle deps the harness drives `runMap` with. */
  deps(): RunLifecycleDeps
  run(): Promise<RunMapOutcome>
  /** The evaluated snapshot of the current map world (§7.3 shape). */
  snapshot(): TaskMapSnapshot
  /** A valid running Run State for the current map world, run ID `run-crafted`. */
  craftRunningState(processes?: readonly ProcessGroupCheckpoint[]): RunState
  runState(): RunState | undefined
  remoteMainSha(): string
  /** Remote main's commit subjects, oldest first. */
  remoteLog(): readonly string[]
  cleanup(): void
}

/** Build the complete §12–§13 harness over one real repository and fake seams. */
export async function makeRunHarness(options: RunHarnessOptions): Promise<RunHarness> {
  const repo = tempGitRepository(options.label)
  const remote = tempBareRemote(options.label)
  const nornHome = mkdtempSync(join(tmpdir(), `norn-run-home-${options.label}-`))
  const store = new RunMapStore(options.members, options.behaviors)
  for (const change of options.changes ?? []) store.changes.push(change)
  Object.assign(store.script, options.gatewayScript ?? {})

  // The real repository: origin points at the bare remote, and the initial
  // main is pushed so the target branch exists remotely from the start.
  execFileSync('git', ['-C', repo.root, 'remote', 'add', 'origin', remote.path])
  execFileSync('git', ['-C', repo.root, 'push', '--quiet', 'origin', 'main'])

  const control: LocalControlStore = fsControlStore(nornHome)
  const repositoryHome = control.repositoryHome({
    githubHost: HOST,
    repositoryId: REPOSITORY_ID,
  })

  const gateway = fakeIssueGateway(store.issues, store.script)
  // The fake gateway writes through its own script; expose the counters the
  // staged changes observe by wrapping the mutating methods.
  const baseWriter = gateway
  const writer = {
    readIssueEvidence: gateway.readIssueEvidence,
    writer: {
      async writeIssueComment(locator: Parameters<typeof baseWriter.writeIssueComment>[0], body: string) {
        const outcome = await baseWriter.writeIssueComment(locator, body)
        if (outcome.kind === 'ok') store.observed.commentCalls += 1
        return outcome
      },
      async closeIssue(locator: Parameters<typeof baseWriter.closeIssue>[0]) {
        const outcome = await baseWriter.closeIssue(locator)
        if (outcome.kind === 'ok') store.observed.closeCalls += 1
        return outcome
      },
      async reopenIssue(locator: Parameters<typeof baseWriter.reopenIssue>[0]) {
        const outcome = await baseWriter.reopenIssue(locator)
        if (outcome.kind === 'ok') store.observed.reopenCalls += 1
        return outcome
      },
    },
  }

  const runner = fakeRunRunner(store, options.reviewer)
  const commands = fakeShipCommands()
  const gitAdapter: GitRepositoryAdapter = {
    async resolveRoot(cwd: string) {
      return { kind: 'ok' as const, value: cwd === repo.root ? repo.root : repo.root }
    },
    async listRemotes() {
      return { kind: 'ok' as const, value: [{ name: 'origin', url: REMOTE_URL }] as readonly GitRemote[] }
    },
  }
  const gatewayAdapter: GitHubGatewayAdapter = {
    async resolveRepository() {
      return { kind: 'ok' as const, value: REPOSITORY }
    },
    async authenticatedActor() {
      return { kind: 'ok' as const, value: { id: ACTOR_ID, login: 'norn-test' } }
    },
  }
  const catalog: ModelCatalogAdapter = {
    async listModels() {
      return {
        kind: 'ok' as const,
        value: [
          { id: 'provider-a/model-x', family: 'provider-a', displayName: 'X', thinkingLevels: ['off', 'medium'] },
          { id: 'provider-b/model-y', family: 'provider-b', displayName: 'Y', thinkingLevels: ['off', 'high'] },
        ],
      }
    },
  }
  const loader: TaskMapLoader = {
    async loadTaskMap(): Promise<TaskMapLoadOutcome> {
      store.observed.mapReads += 1
      if (store.failReadsFrom !== undefined && store.observed.mapReads >= store.failReadsFrom) {
        return {
          kind: 'error' as const,
          scope: 'operation' as const,
          code: 'github-unavailable' as const,
          reason: 'scripted loader failure',
          sharedWrite: 'none' as const,
          evidence: [],
        }
      }
      store.applyDue()
      return { kind: 'ok' as const, value: loadOf(store) }
    },
  }

  let runCounter = 0
  let shipInvocation = 0

  const buildDeps = (): RunLifecycleDeps => {
    const realPush = gitCliPush()
    return {
      cwd: repo.root,
      git: gitAdapter,
      gateway: gatewayAdapter,
      loader,
      store: control,
      catalog,
      evidence: { loadIssueEvidence: writer.readIssueEvidence },
      gitFacts: gitCliDeliveryFacts(),
      runner,
      commands,
      workGit: runGit,
      gitDetailed: runGitDetailed,
      push: async (request) => {
        const outcome = await realPush(request)
        if (outcome.kind === 'pushed') store.observed.pushes += 1
        return outcome
      },
      writer: writer.writer,
      launches: {
        planWorkerFor: () => (input) => {
          void input
          return { argv: ['fake-worker'] }
        },
        planWorkReviewerFor: () => () => ({
          argv: ['pi', '--tools', 'read,grep,find,ls,norn_complete'],
        }),
        planShipReviewer: () => () => ({
          argv: ['pi', '--tools', 'read,grep,find,ls,norn_complete'],
        }),
        newShipInvocationId: () => `ship-rev-${++shipInvocation}`,
      },
      targetLockFor: (home, branch) => osTargetLock(home, branch, { waitMs: 5_000 }),
      now: () => SEALED_AT,
      newRunId: options.newRunId ?? (() => `run-${(runCounter += 1)}`),
      agentSettleTimeoutMs: 1_000,
    }
  }

  // Repository-home setup is written once (and awaited before the harness
  // answers), so tests may hand-edit config.json between invocations.
  const setupWritten = await control.writeRepositorySetup(repositoryHome, {
    metadataJson: `${JSON.stringify({
      schema: 'norn-repository-metadata:v1',
      githubHost: HOST,
      repositoryId: REPOSITORY_ID,
      owner: 'acme',
      name: 'widget',
      defaultBranch: 'main',
    })}\n`,
    configJson: RUN_CONFIG_JSON,
  })

  const harness: RunHarness = {
    repo,
    remote,
    nornHome,
    repositoryHome,
    store,
    gateway,
    runner,
    commands,
    workedTickets: () =>
      runner.launches.filter((entry) => entry.role === 'worker').map((entry) => entry.ticketIssueId!),
    deps: buildDeps,
    snapshot(): TaskMapSnapshot {
      const evaluation = evaluateTaskMapLoad(loadOf(store))
      if (!evaluation.valid) {
        throw new Error(`fixture map is invalid: ${JSON.stringify(evaluation.findings)}`)
      }
      return evaluation.snapshot
    },
    async run() {
      return runMap(buildDeps(), MAP_URL)
    },
    craftRunningState(processes: readonly ProcessGroupCheckpoint[] = []): RunState {
      const evaluation = evaluateTaskMapLoad(loadOf(store))
      if (!evaluation.valid) {
        throw new Error(`fixture map is invalid: ${JSON.stringify(evaluation.findings)}`)
      }
      const snapshot = evaluation.snapshot
      const payload = snapshotMapPayload(snapshot)
      return {
        schema: 'norn-run-state:v1',
        runId: 'run-crafted',
        map: snapshot.ref,
        acceptedMapRevisions: [{ revision: snapshot.mapRevision, payload: payload.payload }],
        configRevision: configRevisionOfFixture(),
        nornVersion: NORN_VERSION,
        status: 'running',
        wave: 0,
        parkedTickets: [],
        tickets: {},
        activeProcesses: [...processes],
      }
    },
    runState() {
      const loaded = loadRunState(repositoryHome, ENCODED_MAP)
      if (loaded.kind !== 'ok') throw new Error(`run state failed to load: ${loaded.reason}`)
      return loaded.value
    },
    remoteMainSha() {
      return `sha1:${gitText(remote.path, ['rev-parse', 'main'])}`
    },
    remoteLog() {
      return gitText(remote.path, ['log', '--reverse', '--format=%s', 'main']).split('\n')
    },
    cleanup() {
      rmSync(nornHome, { recursive: true, force: true })
      remote.cleanup()
      repo.cleanup()
    },
  }
  if (setupWritten.kind !== 'ok') {
    throw new Error('fixture repository setup failed')
  }
  return harness
}
