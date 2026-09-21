/**
 * Shared fixtures for the cross-map concurrency stress tests (ticket #17,
 * design.md §16).
 *
 * One deterministic harness drives **two real coordinators** — two `runMap`
 * invocations, two map locks, two Run State documents — over one shared
 * world:
 *
 * - the **Git side is real**: one repository with one bare remote as the
 *   shared target, so both runs' branches, replays, non-force pushes, and
 *   fetches run through real git plumbing against the same `main`;
 * - the **GitHub side is fake**: one scriptable multi-issue gateway serves
 *   both maps' loaders, the delivery-evidence reader, and the issue writer;
 *   each map world owns its member list, so staged changes (extensions) are
 *   per-map while issue states and timelines are shared;
 * - the **agents are scripted**: workers perform real commits and write real
 *   sidecars, but their settlement is *gated* — a held invocation stays in
 *   flight (its Work slot stays charged) until the test releases it, so
 *   overlapping Work is observed deterministically at quiescent points;
 *   adapter handles that decode to real POSIX process groups (crafted
 *   crashed-coordinator orphans) are probed, waited on, and terminated for
 *   real;
 * - the **control surfaces are real**: one repository home, one repository
 *   control lock, one OS-backed target lock, and one repository-wide
 *   Work-slot registry with a single authoritative capacity.
 *
 * The push seam records in-flight overlap, so tests can assert that
 * interleaved Ships never push simultaneously.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GitRemote, GitRepositoryAdapter, GitPushRequest } from '../../src/adapters/git-repository.ts'
import { gitCliDeliveryFacts, gitCliPush, runGit, runGitDetailed } from '../../src/adapters/git-repository.ts'
import type { Sha256Digest } from '../../src/core/digest.ts'
import type { GitHubGatewayAdapter } from '../../src/adapters/github-gateway.ts'
import type { ModelCatalogAdapter } from '../../src/adapters/model-catalog.ts'
import { CompletionStore, agentRecordedAt } from '../../src/agents/completion.ts'
import type { AgentCompletion, ReviewerCompletion } from '../../src/agents/completion.ts'
import { decodeLocalProcessHandle } from '../../src/agents/local-runner.ts'
import {
  isProcessGroupAlive,
  terminateProcessGroup,
  waitForProcessGroupExit,
} from '../../src/agents/process-group.ts'
import type {
  AgentLaunchRequest,
  AttachedAgentProcess,
  VisibleAgentRunner,
} from '../../src/agents/runner.ts'
import { fsControlStore } from '../../src/control/control-store.ts'
import type { LocalControlStore } from '../../src/control/control-store.ts'
import { encodePathSegment } from '../../src/config/paths.ts'
import { resolveRunConfigText } from '../../src/config/run-config.ts'
import type { EvidenceIssueLocator } from '../../src/evidence/read.ts'
import { evaluateTaskMapLoad } from '../../src/map/snapshot.ts'
import type { TaskMapSnapshot } from '../../src/map/snapshot.ts'
import type { TaskMapLoader, TaskMapLoadOutcome, RawMemberIssue, RawTaskMapLoad } from '../../src/map/loader.ts'
import { rawRef } from './map-fixtures.ts'
import { snapshotMapPayload } from '../../src/ship/reconcile.ts'
import { osTargetLock } from '../../src/ship/push.ts'
import { runMap } from '../../src/run/lifecycle.ts'
import type { RunLifecycleDeps, RunMapOutcome } from '../../src/run/lifecycle.ts'
import { loadRunState } from '../../src/runstate/run-state-store.ts'
import type { RunState } from '../../src/runstate/types.ts'
import { readWorkSlotRegistry } from '../../src/runstate/slot-registry.ts'
import type { WorkSlotReservation } from '../../src/runstate/slot-registry.ts'
import { NORN_VERSION } from '../../src/version.ts'
import { fakeIssueGateway, fakeIssue } from './close-fixtures.ts'
import type { FakeIssueState } from './close-fixtures.ts'
import { fakeShipCommands } from './ship-fixtures.ts'
import type { FakeShipCommands } from './ship-fixtures.ts'
import { tempBareRemote } from './push-fixtures.ts'
import type { BareRemote } from './push-fixtures.ts'
import type { TempRepository } from './round-gate-fixtures.ts'
import { commitInWorkspace, gitText, readWorkspaceOids, tempGitRepository } from './round-gate-fixtures.ts'

// ---------------------------------------------------------------------------
// Fixture identities
// ---------------------------------------------------------------------------

export const HOST = 'github.com'
export const REPOSITORY_ID = 'R_kgDOMAP'
export const ACTOR_ID = 'I_actor'
export const SEALED_AT = '2025-01-02T03:04:05.006Z'

const REMOTE_URL = `https://${HOST}/acme/widget.git`

const REPOSITORY = {
  githubHost: HOST,
  repositoryId: REPOSITORY_ID,
  owner: 'acme',
  name: 'widget',
  defaultBranch: 'main',
}

/** One member Ticket of one map world. */
export type MemberSpec = {
  readonly issueId: string
  readonly number: number
  readonly blockers?: readonly string[]
  /** The file this member's worker commits; default `work-<issueId>-r<n>.txt`. */
  readonly file?: string
  /** Zero-delta workers hand off the unchanged base tree. */
  readonly zeroDelta?: boolean
}

/** One map world: identity plus the mutable member list and staged changes. */
export type MapWorld = {
  readonly issueId: string
  readonly number: number
  readonly url: string
  readonly encoded: string
  readonly runId: string
  members: MemberSpec[]
  /** Staged member-list mutations, applied at load boundaries when due. */
  readonly changes: Array<{ when: () => boolean; apply: () => void }>
  readonly observed: {
    mapReads: number
    workerLaunches: number
    workReviewerLaunches: number
    shipReviewerLaunches: number
    completionReviewerLaunches: number
    pushes: number
    closeCalls: number
    commentCalls: number
    mapCloseCalls: number
    mapCommentCalls: number
    /** Evidence reads by issue number. */
    readonly evidenceReads: Map<number, number>
    /** Map reads that served a snapshot containing the given issue ID. */
    readonly membersSeen: Set<string>
  }
}

export type WorldHarnessOptions = {
  readonly label: string
  /** The one repository-wide `concurrency` both runs share (§8, §16). */
  readonly concurrency: number
  readonly maps: ReadonlyArray<{
    readonly issueId: string
    readonly number: number
    readonly runId: string
    readonly members: readonly MemberSpec[]
  }>
}

// ---------------------------------------------------------------------------
// The gated agent runner: held workers, real orphan process groups
// ---------------------------------------------------------------------------

export type LaunchRecord = {
  readonly world: MapWorld | undefined
  readonly role: 'worker' | 'reviewer'
  readonly phase: 'work' | 'ship' | 'map-completion'
  readonly invocationId: string
  readonly ticketIssueId: string | undefined
  adapterHandle: string
}

/** A launch the test holds in flight until it releases it. */
export type HeldInvocation = {
  /** Resolves once the matching launch happened and its sidecar exists. */
  readonly launched: Promise<void>
  /** Let the held invocation settle; the attempt proceeds. */
  release(): void
}

/** One test-controlled settlement gate of a held invocation. */
type HoldGate = {
  released: boolean
  resolvers: Array<() => void>
  promise: Promise<void>
}
function makeGate(): HoldGate {
  const gate = { released: false, resolvers: [] as Array<() => void> } as HoldGate
  gate.promise = new Promise<void>((resolvePromise) => {
    gate.resolvers.push(resolvePromise)
  })
  return gate
}

/**
 * The scripted Visible Agent Runner of the cross-map harness. Workers commit
 * real files and write real sidecars; a held invocation blocks in
 * `waitForExit` until released, so its Work slot stays charged and the world
 * is quiescent while the test observes it. Adapter handles that decode to
 * real POSIX process groups (crashed-coordinator orphans) are probed, waited
 * on, and terminated for real.
 */
export class GatedRunner implements VisibleAgentRunner {
  readonly kind = 'local-process' as const
  readonly launches: LaunchRecord[] = []
  private readonly held = new Map<string, HoldGate>()
  private readonly pending: Array<{
    readonly match: (record: LaunchRecord) => boolean
    readonly label: string
    resolveLaunched: () => void
    readonly gate: HoldGate
  }> = []

  private readonly behaviorOf: (world: MapWorld, issueId: string) => MemberSpec
  private readonly worlds: ReadonlyMap<string, MapWorld>

  constructor(
    behaviorOf: (world: MapWorld, issueId: string) => MemberSpec,
    worlds: ReadonlyMap<string, MapWorld>,
  ) {
    this.behaviorOf = behaviorOf
    this.worlds = worlds
  }

  /** Hold the next launch matching `match` in flight until released. */
  hold(match: (record: LaunchRecord) => boolean, label: string): HeldInvocation {
    let resolveLaunched!: () => void
    const launched = new Promise<void>((resolvePromise) => {
      resolveLaunched = resolvePromise
    })
    const gate = makeGate()
    this.pending.push({ match, label, resolveLaunched, gate })
    return {
      launched,
      release: () => {
        // Releasing before the launch happened means the invocation is never
        // held; releasing afterwards resolves the held waitForExit.
        gate.released = true
        for (const resolve of gate.resolvers.splice(0)) resolve()
      },
    }
  }

  /** Convenience: hold the next worker launch of one ticket. */
  holdWorker(ticketIssueId: string): HeldInvocation {
    return this.hold(
      (record) => record.role === 'worker' && record.ticketIssueId === ticketIssueId,
      `worker(${ticketIssueId})`,
    )
  }

  /** Every worker launch of one ticket, in order. */
  workerLaunchesOf(ticketIssueId: string): readonly LaunchRecord[] {
    return this.launches.filter(
      (record) => record.role === 'worker' && record.ticketIssueId === ticketIssueId,
    )
  }

  async launch(request: AgentLaunchRequest): Promise<AttachedAgentProcess> {
    const context = request.context
    const world = context.ticket
      ? [...this.worlds.values()].find((candidate) =>
          candidate.members.some((member) => member.issueId === context.ticket!.issueId),
        )
      : undefined
    const record: LaunchRecord = {
      world,
      role: context.role,
      phase: context.phase,
      invocationId: context.invocationId,
      ticketIssueId: context.ticket?.issueId,
      adapterHandle: '',
    }
    this.launches.push(record)
    if (world !== undefined) {
      if (context.role === 'worker') world.observed.workerLaunches += 1
      else if (context.phase === 'work') world.observed.workReviewerLaunches += 1
      else if (context.phase === 'map-completion') world.observed.completionReviewerLaunches += 1
      else world.observed.shipReviewerLaunches += 1
    }

    const completion: AgentCompletion =
      context.role === 'worker'
        ? this.performWorker(world, context.ticket!.issueId, request)
        : ({ discriminant: 'pass' } satisfies ReviewerCompletion)
    const sidecarStore = new CompletionStore(context.completionsDir)
    const written = await sidecarStore.write(context, completion, agentRecordedAt())
    if (written.status === 'conflict') throw new Error('sidecar conflict')

    const handle = `gated-${this.launches.length - 1}`
    record.adapterHandle = handle
    const index = this.pending.findIndex((entry) => entry.match(record))
    if (index !== -1) {
      const [entry] = this.pending.splice(index, 1)
      entry!.resolveLaunched()
      if (!entry!.gate.released) {
        this.held.set(handle, entry!.gate)
      }
    }
    return { kind: this.kind, adapterHandle: handle }
  }

  /** Release every hold, held or pending: unblock cleanup after failures. */
  releaseAll(): void {
    for (const gate of this.held.values()) {
      gate.released = true
      for (const resolve of gate.resolvers.splice(0)) resolve()
    }
    this.held.clear()
    for (const entry of this.pending.splice(0)) {
      entry.gate.released = true
      for (const resolve of entry.gate.resolvers.splice(0)) resolve()
    }
  }

  attach(adapterHandle: string): AttachedAgentProcess {
    return { kind: this.kind, adapterHandle }
  }

  async isLive(processRef: AttachedAgentProcess): Promise<boolean> {
    const pgid = this.realPgidOf(processRef.adapterHandle)
    return pgid === undefined ? false : isProcessGroupAlive(pgid)
  }

  async waitForExit(
    processRef: AttachedAgentProcess,
    timeoutMs: number,
  ): Promise<'exited' | 'timeout'> {
    const held = this.held.get(processRef.adapterHandle)
    if (held !== undefined) {
      await held.promise // the test decides when this invocation settles
      return 'exited'
    }
    const pgid = this.realPgidOf(processRef.adapterHandle)
    if (pgid !== undefined) {
      const exited = await waitForProcessGroupExit(pgid, { timeoutMs })
      return exited ? 'exited' : 'timeout'
    }
    return 'exited'
  }

  async terminate(processRef: AttachedAgentProcess): Promise<'terminated' | 'terminate-failed'> {
    const pgid = this.realPgidOf(processRef.adapterHandle)
    if (pgid !== undefined) return terminateProcessGroup(pgid)
    return 'terminated'
  }

  /** The real process-group ID behind a crafted local-process handle, if any. */
  private realPgidOf(adapterHandle: string): number | undefined {
    try {
      return decodeLocalProcessHandle(adapterHandle)
    } catch {
      return undefined
    }
  }

  private performWorker(
    world: MapWorld | undefined,
    issueId: string,
    request: AgentLaunchRequest,
  ): AgentCompletion {
    if (world === undefined) throw new Error(`worker of unknown ticket ${issueId}`)
    const spec = this.behaviorOf(world, issueId)
    if (spec.zeroDelta) {
      const oids = readWorkspaceOids(request.cwd)
      return { discriminant: 'candidate', claimedCommit: oids.commit, claimedTreeOid: oids.treeOid }
    }
    const round = request.context.work?.round ?? 1
    const name = spec.file ?? `work-${issueId}-r${round}.txt`
    const oids = commitInWorkspace(request.cwd, name, `work ${issueId} round ${round}\n`)
    return { discriminant: 'candidate', claimedCommit: oids.commit, claimedTreeOid: oids.treeOid }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export type PushStat = { readonly world: MapWorld | undefined; readonly sha: string }

export type CrossMapHarness = {
  readonly repo: TempRepository
  readonly remote: BareRemote
  readonly repositoryHome: string
  readonly nornHome: string
  readonly runner: GatedRunner
  readonly commands: FakeShipCommands
  readonly issues: Map<number, FakeIssueState>
  readonly configRevision: Sha256Digest
  readonly concurrency: number
  world(issueId: string): MapWorld
  /** Add one member Ticket to a map world, creating its fake issue (§7.4). */
  addMember(world: MapWorld, spec: MemberSpec): void
  run(world: MapWorld): Promise<RunMapOutcome>
  /** Release every hold and await every tracked run, bounded (test cleanup). */
  settleAll(): Promise<void>
  runStateOf(world: MapWorld): RunState | undefined
  snapshotOf(world: MapWorld): TaskMapSnapshot
  /** The current repository-wide Work reservations. */
  slotReservations(): readonly WorkSlotReservation[]
  /** Push statistics: count, maximum simultaneous in-flight pushes, log. */
  pushStats(): { readonly count: number; readonly maxInFlight: number; readonly log: readonly PushStat[] }
  remoteMainSha(): string
  remoteLog(): readonly string[]
  cleanup(): void
}

function delayOnce(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/** Build the two-coordinator, one-repository harness of design.md §16. */
export async function makeCrossMapHarness(
  options: WorldHarnessOptions,
): Promise<CrossMapHarness> {
  const repo = tempGitRepository(options.label)
  const remote = tempBareRemote(options.label)
  const nornHome = mkdtempSync(join(tmpdir(), `norn-cross-${options.label}-`))
  const control: LocalControlStore = fsControlStore(nornHome)
  const repositoryHome = control.repositoryHome({
    githubHost: HOST,
    repositoryId: REPOSITORY_ID,
  })
  execFileSync('git', ['-C', repo.root, 'remote', 'add', 'origin', remote.path])
  execFileSync('git', ['-C', repo.root, 'push', '--quiet', 'origin', 'main'])

  const issues = new Map<number, FakeIssueState>()
  const worlds = new Map<string, MapWorld>()
  const worldOfNumber = new Map<number, MapWorld>()
  for (const spec of options.maps) {
    const world: MapWorld = {
      issueId: spec.issueId,
      number: spec.number,
      url: `https://${HOST}/acme/widget/issues/${spec.number}`,
      encoded: encodePathSegment(spec.issueId),
      runId: spec.runId,
      members: [...spec.members],
      changes: [],
      observed: {
        mapReads: 0,
        workerLaunches: 0,
        workReviewerLaunches: 0,
        shipReviewerLaunches: 0,
        completionReviewerLaunches: 0,
        pushes: 0,
        closeCalls: 0,
        commentCalls: 0,
        mapCloseCalls: 0,
        mapCommentCalls: 0,
        evidenceReads: new Map(),
        membersSeen: new Set(),
      },
    }
    worlds.set(spec.issueId, world)
    worldOfNumber.set(spec.number, world)
    issues.set(spec.number, fakeIssue('OPEN'))
    for (const member of spec.members) issues.set(member.number, fakeIssue('OPEN'))
  }

  const gateway = fakeIssueGateway(issues)
  const runner = new GatedRunner((world, issueId) => {
    const member = world.members.find((entry) => entry.issueId === issueId)
    if (member === undefined) throw new Error(`unknown member ${issueId} of map ${world.issueId}`)
    return member
  }, worlds)
  const commands = fakeShipCommands()

  const gitAdapter: GitRepositoryAdapter = {
    async resolveRoot(cwd: string) {
      return { kind: 'ok' as const, value: repo.root || cwd }
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

  const configJson = `${JSON.stringify(
    {
      schema: 'norn-run:v1',
      targetBranch: 'main',
      setup: [],
      tests: [{ argv: ['npm', 'test'], timeoutMs: 60_000 }],
      maxWorkRounds: 2,
      maxPushRetries: 1,
      concurrency: options.concurrency,
      worker: { model: 'provider-a/model-x', thinking: 'medium', timeoutMs: 60_000 },
      reviewer: { model: 'provider-b/model-y', thinking: 'high', timeoutMs: 60_000 },
      trustedEvidenceAuthorIds: [ACTOR_ID],
    },
    null,
    2,
  )}\n`
  const resolved = resolveRunConfigText(configJson)
  if (resolved.kind !== 'ok') throw new Error('fixture config is invalid')
  const configRevision = resolved.value.configRevision

  const setupWritten = await control.writeRepositorySetup(repositoryHome, {
    metadataJson: `${JSON.stringify({
      schema: 'norn-repository-metadata:v1',
      githubHost: HOST,
      repositoryId: REPOSITORY_ID,
      owner: 'acme',
      name: 'widget',
      defaultBranch: 'main',
    })}\n`,
    configJson,
  })
  if (setupWritten.kind !== 'ok') throw new Error('fixture repository setup failed')

  // --- the shared loader: one world per map issue number -------------------

  const loadOfWorld = (world: MapWorld): RawTaskMapLoad => {
    const numberByIssueId = new Map(world.members.map((spec) => [spec.issueId, spec.number]))
    const mapRef = rawRef(world.issueId, world.number)
    const members: RawMemberIssue[] = world.members.map((spec) => ({
      ref: rawRef(spec.issueId, spec.number),
      title: `Ticket ${spec.issueId}`,
      body: `Body of ${spec.issueId}`,
      state: issues.get(spec.number)?.state ?? 'OPEN',
      parents: [mapRef],
      subIssues: [],
      blockers: (spec.blockers ?? []).map((id) => rawRef(id, numberByIssueId.get(id) ?? 0)),
    }))
    return {
      map: {
        ref: mapRef,
        title: `Map ${world.issueId}`,
        body: `Shared intent of ${world.issueId}.`,
        state: issues.get(world.number)?.state ?? 'OPEN',
        parents: [],
        blockers: [],
      },
      members,
    }
  }

  const applyDueChanges = (): void => {
    for (const world of worlds.values()) {
      for (const change of [...world.changes]) {
        if (change.when()) {
          change.apply()
          world.changes.splice(world.changes.indexOf(change), 1)
        }
      }
    }
  }

  const loader: TaskMapLoader = {
    async loadTaskMap(locator): Promise<TaskMapLoadOutcome> {
      const world = worldOfNumber.get(locator.number)
      if (world === undefined) {
        return {
          kind: 'error' as const,
          scope: 'operation' as const,
          code: 'github-unavailable' as const,
          reason: `no fixture world for map issue #${locator.number}`,
          sharedWrite: 'none' as const,
          evidence: [],
        }
      }
      world.observed.mapReads += 1
      applyDueChanges()
      const load = loadOfWorld(world)
      for (const member of world.members) world.observed.membersSeen.add(member.issueId)
      return { kind: 'ok' as const, value: load }
    },
  }

  // --- the shared evidence reader and writer (per-world counters) ----------

  /** The world an issue number belongs to: its map, or its member's map. */
  const worldOfIssue = (number: number): MapWorld | undefined => {
    if (worldOfNumber.has(number)) return worldOfNumber.get(number)
    return [...worlds.values()].find((world) =>
      world.members.some((member) => member.number === number),
    )
  }

  const evidenceReader = {
    async loadIssueEvidence(locator: EvidenceIssueLocator) {
      const world = worldOfIssue(locator.number)
      if (world !== undefined) {
        world.observed.evidenceReads.set(
          locator.number,
          (world.observed.evidenceReads.get(locator.number) ?? 0) + 1,
        )
      }
      return gateway.readIssueEvidence(locator)
    },
  }

  const writer = {
    async writeIssueComment(...args: Parameters<typeof gateway.writeIssueComment>) {
      const [locator, body] = args
      const outcome = await gateway.writeIssueComment(locator, body)
      if (outcome.kind === 'ok') {
        const world = worldOfIssue(locator.number)
        if (world !== undefined) {
          if (world.number === locator.number) world.observed.mapCommentCalls += 1
          else world.observed.commentCalls += 1
        }
      }
      return outcome
    },
    async closeIssue(...args: Parameters<typeof gateway.closeIssue>) {
      const [locator] = args
      const outcome = await gateway.closeIssue(locator)
      if (outcome.kind === 'ok') {
        const world = worldOfIssue(locator.number)
        if (world !== undefined) {
          if (world.number === locator.number) world.observed.mapCloseCalls += 1
          else world.observed.closeCalls += 1
        }
      }
      return outcome
    },
    async reopenIssue(...args: Parameters<typeof gateway.reopenIssue>) {
      return gateway.reopenIssue(...args)
    },
  }

  // --- the shared push seam: records simultaneous-push violations ----------

  const pushLog: PushStat[] = []
  let pushCount = 0
  let inFlight = 0
  let maxInFlight = 0
  const realPush = gitCliPush()
  const pushSeamOf = (world: MapWorld) => async (request: GitPushRequest) => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      const outcome = await realPush(request)
      if (outcome.kind === 'pushed') {
        pushCount += 1
        world.observed.pushes += 1
        pushLog.push({ world, sha: request.sha })
      }
      return outcome
    } finally {
      inFlight -= 1
    }
  }

  // --- per-world lifecycle deps over the shared world ----------------------

  const pendingRuns: Array<Promise<RunMapOutcome>> = []
  let shipInvocation = 0
  const buildDeps = (world: MapWorld): RunLifecycleDeps => ({
    cwd: repo.root,
    git: gitAdapter,
    gateway: gatewayAdapter,
    loader,
    store: control,
    catalog,
    evidence: evidenceReader,
    gitFacts: gitCliDeliveryFacts(),
    runner,
    commands,
    workGit: runGit,
    gitDetailed: runGitDetailed,
    push: pushSeamOf(world),
    writer,
    launches: {
      planWorkerFor: () => () => ({ argv: ['gated-worker'] }),
      planWorkReviewerFor: () => () => ({ argv: ['pi', '--tools', 'read,grep,find,ls,norn_complete'] }),
      planShipReviewer: () => () => ({ argv: ['pi', '--tools', 'read,grep,find,ls,norn_complete'] }),
      planMapCompletionReviewer: () => () => ({ argv: ['pi', '--tools', 'read,grep,find,ls,norn_complete'] }),
      newShipInvocationId: () => `ship-rev-${++shipInvocation}`,
    },
    targetLockFor: (home, branch) => osTargetLock(home, branch, { waitMs: 30_000 }),
    now: () => SEALED_AT,
    newRunId: () => world.runId,
    agentSettleTimeoutMs: 10_000,
    slotWaitMs: 60_000,
    slotPollMs: 10,
  })

  return {
    repo,
    remote,
    repositoryHome,
    nornHome,
    runner,
    commands,
    issues,
    configRevision,
    concurrency: options.concurrency,
    world: (issueId) => {
      const world = worlds.get(issueId)
      if (world === undefined) throw new Error(`no world for map ${issueId}`)
      return world
    },
    addMember: (world, spec) => {
      world.members = [...world.members, spec]
      if (!issues.has(spec.number)) issues.set(spec.number, fakeIssue('OPEN'))
    },
    run: (world) => {
      const running = runMap(buildDeps(world), world.url)
      pendingRuns.push(running)
      return running
    },
    settleAll: async () => {
      runner.releaseAll()
      await Promise.race([
        Promise.allSettled(pendingRuns),
        new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 30_000)),
      ])
    },
    runStateOf(world) {
      const loaded = loadRunState(repositoryHome, world.encoded)
      if (loaded.kind !== 'ok') throw new Error(`run state failed to load: ${loaded.reason}`)
      return loaded.value
    },
    snapshotOf(world) {
      const evaluation = evaluateTaskMapLoad(loadOfWorld(world))
      if (!evaluation.valid) {
        throw new Error(`fixture map is invalid: ${JSON.stringify(evaluation.findings)}`)
      }
      return evaluation.snapshot
    },
    slotReservations() {
      const registry = readWorkSlotRegistry(repositoryHome)
      if (registry.kind !== 'ok') throw new Error(`slot registry failed: ${registry.reason}`)
      return registry.value?.reserved ?? []
    },
    pushStats: () => ({ count: pushCount, maxInFlight, log: pushLog }),
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
}

// ---------------------------------------------------------------------------
// Crafted states (§16)
// ---------------------------------------------------------------------------

/**
 * Craft the minimal integrity-valid `running` Run State of one map world:
 * its complete current member set claimed (all waiting), wave 0, nothing in
 * flight. This is the claim another coordinator's preflight or adoption must
 * observe.
 */
export function craftClaimState(
  harness: CrossMapHarness,
  world: MapWorld,
  runId: string,
  configRevision?: Sha256Digest,
): RunState {
  const snapshot = harness.snapshotOf(world)
  const payload = snapshotMapPayload(snapshot)
  const tickets: Record<string, { phase: 'waiting' }> = {}
  for (const ticket of snapshot.tickets) tickets[ticket.ref.issueId] = { phase: 'waiting' }
  return {
    schema: 'norn-run-state:v1',
    runId,
    map: snapshot.ref,
    acceptedMapRevisions: [{ revision: snapshot.mapRevision, payload: payload.payload }],
    configRevision: configRevision ?? harness.configRevision,
    nornVersion: NORN_VERSION,
    status: 'running',
    wave: 0,
    parkedTickets: [],
    tickets,
    activeProcesses: [],
  }
}

/** The persisted world of one coordinator that crashed mid-Work (§16). */
export type CraftedCrash = {
  readonly state: RunState
  readonly workAttemptId: string
}

/**
 * Craft the integrity-valid `running` Run State of one map world whose single
 * member's Work attempt is mid-flight with a reserved slot and one live
 * (running) recorded process group — exactly what a coordinator crash leaves
 * behind. The caller creates the attempt workspace and the orphan group.
 */
export function craftCrashedWorkState(
  harness: CrossMapHarness,
  world: MapWorld,
  init: {
    readonly workAttemptId: string
    readonly runId: string
    readonly adapterHandle: string
    readonly baseSha: string
    readonly baseTreeOid: string
    readonly round: number
  },
): CraftedCrash {
  const snapshot = harness.snapshotOf(world)
  if (snapshot.tickets.length !== 1) {
    throw new Error('craftCrashedWorkState expects a one-member world')
  }
  const ticket = snapshot.tickets[0]!
  const payload = snapshotMapPayload(snapshot)
  const workspace = {
    kind: 'ticket' as const,
    repositoryId: REPOSITORY_ID,
    runId: init.runId,
    path: join(
      harness.repositoryHome,
      'runs',
      init.runId,
      'workspaces',
      String(ticket.ref.number),
      init.workAttemptId,
    ),
    branch: `norn/${init.runId}/${ticket.ref.number}/${init.workAttemptId}`,
    workAttemptId: init.workAttemptId,
  }
  const processGroupId = `${init.workAttemptId}-worker-r${init.round}`
  return {
    state: {
      schema: 'norn-run-state:v1',
      runId: init.runId,
      map: snapshot.ref,
      acceptedMapRevisions: [{ revision: snapshot.mapRevision, payload: payload.payload }],
      configRevision: harness.configRevision,
      nornVersion: NORN_VERSION,
      status: 'running',
      wave: 1,
      activeWave: {
        number: 1,
        mapRevision: snapshot.mapRevision,
        target: { branch: 'main', baseSha: init.baseSha, baseTreeOid: init.baseTreeOid },
        frontierTicketIssueIds: [ticket.ref.issueId],
        shipQueueTicketIssueIds: [],
        nextShipIndex: 0,
      },
      parkedTickets: [],
      tickets: {
        [ticket.ref.issueId]: {
          phase: 'working',
          wave: 1,
          attempt: {
            workAttemptId: init.workAttemptId,
            input: {
              ticket: ticket.ref,
              spec: {
                mapTitle: snapshot.title,
                mapBody: snapshot.body,
                mapRevision: snapshot.mapRevision,
                ticketTitle: ticket.title,
                ticketBody: ticket.body,
                ticketRevision: ticket.ticketRevision,
              },
              target: { branch: 'main', baseSha: init.baseSha, baseTreeOid: init.baseTreeOid },
            },
            branch: workspace.branch,
            workspace,
            round: init.round,
            slot: 'reserved',
            processGroupIds: [processGroupId],
          },
        },
      },
      activeProcesses: [
        {
          id: processGroupId,
          owner: 'worker',
          phase: 'work',
          workspace,
          ticketIssueId: ticket.ref.issueId,
          workAttemptId: init.workAttemptId,
          adapterHandle: init.adapterHandle,
          state: 'running',
        },
      ],
    },
    workAttemptId: init.workAttemptId,
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Poll `predicate` until it holds or the budget elapses (bounded waiting). */
export async function pollUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) {
      throw new Error(`pollUntil timed out after ${timeoutMs}ms waiting for: ${label}`)
    }
    await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())))
  }
}

/** Assert `predicate` never holds within `quietMs` (bounded negative poll). */
export async function assertNever(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  quietMs: number,
): Promise<void> {
  const deadline = Date.now() + quietMs
  while (Date.now() < deadline) {
    if (await predicate()) throw new Error(`unexpectedly observed: ${label}`)
    await delayOnce(10)
  }
}
