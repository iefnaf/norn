/**
 * Shared fixtures for the Ship push, remote verification, and retry tests
 * (ticket #11, design.md §11.3 + §13.3 steps 1–2).
 *
 * The "GitHub target" is a real local bare remote: pushes, non-fast-forward
 * rejections, protected-branch pre-receive declines, fetches, ancestry, and
 * commit-shape probes all run through the real git plumbing, deterministically
 * and offline. The harness wires the real §11.2 reconciliation, the real
 * Run-State-backed Ship Checkpoint store, and the real git delivery facts,
 * while the map read, the push seam, and the lock are scriptable so tests can
 * stage races, crashes, and extensions mid-Ship.
 *
 * `harness.run(script)` executes one complete `shipPush` invocation over the
 * shared repository, home, and Run State document — repeated calls model
 * kill-and-resume across coordinator restarts (same store, same counters).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ok } from '../../src/core/outcome.ts'
import type { Outcome } from '../../src/core/outcome.ts'
import { canonicalJsonDigest } from '../../src/core/digest.ts'
import { encodePathSegment, targetLockPath } from '../../src/config/paths.ts'
import { isLockHeld } from '../../src/runstate/locks.ts'
import {
  gitCliDeliveryFacts,
  gitCliPush,
  runGit,
  runGitDetailed,
} from '../../src/adapters/git-repository.ts'
import type { GitPushOutcome, GitPushRequest, GitPushSeam } from '../../src/adapters/git-repository.ts'
import type { VisibleAgentRunner } from '../../src/agents/runner.ts'
import { loadRunState, saveRunState } from '../../src/runstate/run-state-store.ts'
import type { RunState, ShippableChange, ShipCheckpoint } from '../../src/runstate/types.ts'
import { osTargetLock, runStateShipCheckpointStore, shipPush } from '../../src/ship/push.ts'
import type {
  LoadedShipState,
  ShipCheckpointStore,
  ShipPushDeps,
  ShipPushParams,
  ShipPushOutcome,
  ShipTargetLock,
  ShipTargetLockHandle,
} from '../../src/ship/push.ts'
import { runStateAdoptExtension } from '../../src/ship/reconcile.ts'
import type { ShipExtensionAdoption, ShipFacts } from '../../src/ship/reconcile.ts'
import type { StableSnapshotOutcome } from '../../src/map/stable-read.ts'
import type { TaskMapSnapshot } from '../../src/map/snapshot.ts'
import type { EvidenceGateV1 } from '../../src/runstate/types.ts'
import type { CommandRunner } from '../../src/work/command-runner.ts'
import type { CommandExecution, CommandExecutionRequest } from '../../src/work/command-runner.ts'
import { createTicketWorkspace } from '../../src/work/workspace.ts'
import { tempGitRepository, gitText, commitInWorkspace } from './round-gate-fixtures.ts'
import type { TempRepository } from './round-gate-fixtures.ts'
import { fakeReviewerRunner, fakeShipCommands } from './ship-fixtures.ts'
import type { FakeShipCommands } from './ship-fixtures.ts'
import {
  REPOSITORY_ID,
  RUN_ID,
  TICKET_ISSUE_ID,
  WORK_ATTEMPT_ID,
  acceptedEntryOf,
  defaultMap,
  memberC,
  revisionOf,
  sealedChange,
  snapshotOf,
  ticket7,
} from './ship-fixtures.ts'

export const MAP_ISSUE_ID = 'I_map'
export const ENCODED_MAP = encodePathSegment(MAP_ISSUE_ID)
export const ACTOR_ID = 'I_actor'
export const CONFIG_REVISION = canonicalJsonDigest({ fixture: 'push-config' } as never)
export const NORN_VERSION = '0.1.0'
export const SEALED_AT = '2025-01-02T03:04:05.006Z'
export const MAP_URL = 'https://github.com/acme/widget/issues/6'

/**
 * The sealed gate: exactly the harness's one configured test, so it matches
 * both the reused Work evidence (one `npm test` entry) and the fresh ship
 * evidence reconciliation builds from the same configured list (§14 rule 8).
 */
export function pushGate(): EvidenceGateV1 {
  return {
    worker: { provider: 'provider-a', model: 'provider-a/model-x', family: 'provider-a', thinking: 'medium' },
    reviewer: { provider: 'provider-b', model: 'provider-b/model-y', family: 'provider-b', thinking: 'high' },
    tests: [{ argv: ['npm', 'test'], timeoutMs: 60_000 }],
  }
}

// ---------------------------------------------------------------------------
// Local bare remotes: the fake GitHub target
// ---------------------------------------------------------------------------

export type BareRemote = {
  readonly path: string
  readonly cleanup: () => void
}

export function tempBareRemote(label: string): BareRemote {
  const scratch = mkdtempSync(join(tmpdir(), `norn-push-remote-${label}-`))
  const path = join(scratch, 'target.git')
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', path])
  return { path, cleanup: () => rmSync(scratch, { recursive: true, force: true }) }
}

/** Install a pre-receive hook that declines every push (protected branch). */
export function protectBranch(
  remote: BareRemote,
  message = 'protected branch: direct pushes are denied',
): void {
  const hook = join(remote.path, 'hooks', 'pre-receive')
  writeFileSync(hook, `#!/bin/sh\necho "remote: error: GH006: ${message}" >&2\nexit 1\n`, 'utf8')
  execFileSync('chmod', ['+x', hook])
}

/**
 * Push one foreign commit onto the remote target — the competing ship that
 * advances the branch under Norn's feet. Returns the new remote tip.
 */
export function advanceRemoteTarget(remote: BareRemote, name: string): string {
  const scratch = mkdtempSync(join(tmpdir(), 'norn-push-advance-'))
  try {
    const clone = join(scratch, 'clone')
    execFileSync('git', ['clone', '--quiet', remote.path, clone])
    execFileSync('git', ['-C', clone, 'config', 'user.email', 'competitor@example.invalid'])
    execFileSync('git', ['-C', clone, 'config', 'user.name', 'Competitor'])
    writeFileSync(join(clone, name), `competing change ${name}\n`, 'utf8')
    execFileSync('git', ['-C', clone, 'add', '.'])
    execFileSync('git', ['-C', clone, 'commit', '--quiet', '--no-gpg-sign', '-m', `competing ${name}`])
    execFileSync('git', ['-C', clone, 'push', '--quiet', 'origin', 'main'])
    return gitText(clone, ['rev-parse', 'HEAD'])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// The scriptable target lock
// ---------------------------------------------------------------------------

export type LockEvent = 'acquire' | 'release'

export type RecordingLock = ShipTargetLock & {
  readonly events: LockEvent[]
  /** Whether the lock is currently held by the orchestration. */
  isHeldNow(): boolean
}

/** A fake target lock that records every acquire and release in order. */
export function recordingLock(
  script: { readonly failFirstAcquire?: string } = {},
  sharedEvents?: string[],
): RecordingLock {
  const events: LockEvent[] = []
  const record = (event: LockEvent): void => {
    events.push(event)
    sharedEvents?.push(`lock:${event}`)
  }
  let held = false
  let failedOnce = false
  return {
    events,
    isHeldNow: () => held,
    async acquire() {
      if (script.failFirstAcquire !== undefined && !failedOnce) {
        failedOnce = true
        return {
          kind: 'blocked' as const,
          scope: 'operation' as const,
          code: 'lock-held' as const,
          reason: script.failFirstAcquire,
          sharedWrite: 'none' as const,
          evidence: [],
        }
      }
      record('acquire')
      held = true
      const handle: ShipTargetLockHandle = {
        release: async () => {
          record('release')
          held = false
          return ok(undefined)
        },
        isHeld: () => held,
      }
      return ok(handle)
    },
  }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/** One observed push call: the request plus the persisted checkpoint at call time. */
export type PushCall = {
  readonly request: GitPushRequest
  /** The persisted shipping checkpoint read from the Run State during the call. */
  readonly persistedAtCall: ShipCheckpoint | undefined
  /** Whether the OS-backed target lock file was held when the call began. */
  readonly osLockHeld: boolean | null
}

export type RunScript = {
  /** What each push call in this run does; defaults to the real push. */
  readonly push?: (
    call: number,
    real: () => Promise<GitPushOutcome>,
    observed: PushCall,
  ) => Promise<GitPushOutcome>
  /** Fail this run's fetches at these call indices (scripted ambiguity). */
  readonly failFetchAt?: ReadonlySet<number>
  /** Script the map read; the global read index spans every run. */
  readonly mapScript?: (
    read: number,
    snapshot: () => TaskMapSnapshot,
  ) => TaskMapSnapshot | StableSnapshotOutcome
  /** Replace the adoption seam (default: the real Run-State-backed one). */
  readonly adopt?: (
    extension: ShipExtensionAdoption,
    lockHeld: () => boolean,
  ) => Outcome<void, never, 'control-store'> | undefined
  /** Fail the store's markStage in this run (crash after a verified push). */
  readonly markStageFails?: boolean
}

export type PushHarnessOptions = {
  readonly label: string
  /** Worker files applied in the attempt workspace (default: two files). */
  readonly workerFiles?: readonly { readonly name: string; readonly content: string }[]
  /** Files added to main (and pushed to origin) after the branch was cut. */
  readonly targetFiles?: readonly { readonly name: string; readonly content: string }[]
  /** No worker files: the candidate tree equals the target tree. */
  readonly zeroDelta?: boolean
  /** Use the OS-backed target lock instead of the recording fake. */
  readonly osLock?: boolean
  /** Script the very first lock acquisition to fail with this reason. */
  readonly lockFailFirstAcquire?: string
  readonly maxPushRetries?: number
  readonly alreadyShipped?: boolean
  /** Script gate commands by argv (default: pass). */
  readonly commandScript?: (
    argv: readonly string[],
    call: number,
  ) => CommandExecution | void
  /** Script the map read on every run (global read index). */
  readonly mapScript?: RunScript['mapScript']
}

export type PushHarness = {
  readonly repo: TempRepository
  readonly remote: BareRemote
  readonly repositoryHome: string
  readonly change: ShippableChange
  readonly accepted: ReturnType<typeof acceptedEntryOf>
  readonly acceptedMap: TaskMapSnapshot
  readonly extendedMap: TaskMapSnapshot
  readonly events: string[]
  readonly lock: RecordingLock
  readonly pushCalls: PushCall[]
  readonly counts: {
    readonly mapReads: () => number
    readonly factsFetches: () => number
    readonly reviewerLaunches: () => number
    readonly adoptions: () => number
  }
  readonly reviewer: VisibleAgentRunner & { readonly launches: number }
  readonly commands: FakeShipCommands
  run(script?: RunScript): Promise<ShipPushOutcome>
  /** The persisted shipping state, straight from the Run State document. */
  persisted(): LoadedShipState | undefined
  /** Rewrite the persisted shipping checkpoint (recovery-fixture surgery). */
  mutatePersisted(mutate: (checkpoint: ShipCheckpoint) => ShipCheckpoint): void
  remoteMainSha(): string
  cleanup(): void
}

/** Build the full §11.3 harness over one repository with a bare remote. */
export async function makePushHarness(options: PushHarnessOptions): Promise<PushHarness> {
  const repo = tempGitRepository(options.label)
  const remote = tempBareRemote(options.label)
  const home = mkdtempSync(join(tmpdir(), `norn-push-home-${options.label}-`))
  const events: string[] = []
  const pushCalls: PushCall[] = []
  const lock = recordingLock({ failFirstAcquire: options.lockFailFirstAcquire }, events)
  let mapReads = 0
  let factsFetches = 0
  const acceptedMap = defaultMap()
  const extendedMap = snapshotOf([ticket7(), memberC()])

  execFileSync('git', ['-C', repo.root, 'remote', 'add', 'origin', remote.path])

  const baseSha = `sha1:${gitText(repo.root, ['rev-parse', 'HEAD'])}`
  const baseTreeOid = `sha1:${gitText(repo.root, ['rev-parse', 'HEAD^{tree}'])}`

  // The attempt workspace exactly as Work leaves it (§10.1): branch at the
  // base, workspace checked out on it, worker commits on top.
  const workspaceResult = await createTicketWorkspace(
    { git: runGit },
    {
      repositoryRoot: repo.root,
      repositoryHome: home,
      repositoryId: REPOSITORY_ID,
      runId: RUN_ID,
      ticketNumber: 7,
      workAttemptId: WORK_ATTEMPT_ID,
      base: { sha: baseSha, treeOid: baseTreeOid },
    },
  )
  if (workspaceResult.kind !== 'ok') {
    throw new Error(`fixture workspace creation failed: ${workspaceResult.reason}`)
  }
  const workspace = workspaceResult.value
  const workspacePath = workspace.kind === 'ticket' ? workspace.path : ''
  const workerFiles =
    options.zeroDelta === true
      ? []
      : (options.workerFiles ?? [
          { name: 'feature-a.txt', content: 'worker change one\n' },
          { name: 'feature-b.txt', content: 'worker change two\n' },
        ])
  let sealed = { commit: baseSha, treeOid: baseTreeOid }
  for (const file of workerFiles) {
    sealed = commitInWorkspace(workspacePath, file.name, file.content)
  }

  // Target movement after the branch was cut, pushed to the remote target so
  // the facts seam sees it as the current remote truth.
  for (const file of options.targetFiles ?? []) {
    writeFileSync(join(repo.root, file.name), file.content, 'utf8')
    execFileSync('git', ['-C', repo.root, 'add', '-A'])
    execFileSync('git', ['-C', repo.root, 'commit', '--quiet', '--no-gpg-sign', '-m', `target ${file.name}`])
  }
  execFileSync('git', ['-C', repo.root, 'push', '--quiet', 'origin', 'main'])

  const change = sealedChange({
    mapRevision: acceptedMap.mapRevision,
    ticketRevision: revisionOf(acceptedMap, TICKET_ISSUE_ID),
    baseSha,
    candidateCommit: sealed.commit,
    candidateTreeOid: sealed.treeOid,
    workspace,
  })

  const initial: RunState = {
    schema: 'norn-run-state:v1',
    runId: RUN_ID,
    map: {
      role: 'map',
      githubHost: 'github.com',
      repositoryId: REPOSITORY_ID,
      issueId: MAP_ISSUE_ID,
      number: 6,
      url: MAP_URL,
    },
    acceptedMapRevisions: [acceptedEntryOf(acceptedMap)],
    configRevision: CONFIG_REVISION,
    nornVersion: NORN_VERSION,
    status: 'running',
    wave: 1,
    parkedTickets: [],
    tickets: { [TICKET_ISSUE_ID]: { phase: 'shippable', wave: 1, change } },
    activeProcesses: [],
  }
  if (saveRunState(home, ENCODED_MAP, initial).kind !== 'ok') {
    throw new Error('fixture run state failed its integrity checks')
  }

  const store: ShipCheckpointStore = runStateShipCheckpointStore({
    repositoryHome: home,
    encodedMapIssueId: ENCODED_MAP,
    ticketIssueId: TICKET_ISSUE_ID,
  })

  const reviewer = fakeReviewerRunner(() => ({ discriminant: 'pass' }))
  const commandScript = options.commandScript
  const commands = fakeShipCommands(
    commandScript === undefined
      ? undefined
      : (request: CommandExecutionRequest, call: number) => commandScript(request.argv, call),
  )

  const harness: PushHarness = {
    repo,
    remote,
    repositoryHome: home,
    change,
    accepted: acceptedEntryOf(acceptedMap),
    acceptedMap,
    extendedMap,
    events,
    lock,
    pushCalls,
    counts: {
      mapReads: () => mapReads,
      factsFetches: () => factsFetches,
      reviewerLaunches: () => reviewer.launches,
      adoptions: () => loadAdoptionCount(),
    },
    reviewer,
    commands,

    async run(script = {}) {
      const factsAdapter = gitCliDeliveryFacts(runGitDetailed)
      const fetchFailures = new Set(script.failFetchAt ?? [])
      let fetchCall = 0
      const facts: ShipFacts = {
        fetchTarget: async (branch) => {
          const index = fetchCall++
          factsFetches += 1
          events.push(`fetch:${index}`)
          if (fetchFailures.has(index)) {
            return gitFactsFailure('scripted fetch failure')
          }
          return factsAdapter.fetchTarget(repo.root, 'origin', branch)
        },
        targetSha: (branch) => factsAdapter.targetSha(repo.root, 'origin', branch),
        commitFacts: (sha) => factsAdapter.commitFacts(repo.root, sha),
        isAncestorOfTarget: (sha, branch) =>
          factsAdapter.isAncestorOfTarget(repo.root, 'origin', branch, sha),
      }

      const realPush = gitCliPush()
      const pushSeam: GitPushSeam = async (request) => {
        const call = pushCalls.length
        const osLockHeld = options.osLock === true ? await isLockHeld(targetLockPath(home, 'main')) : null
        const observed: PushCall = {
          request,
          persistedAtCall: harness.persisted()?.checkpoint,
          osLockHeld,
        }
        pushCalls.push(observed)
        events.push(`push:${call}`)
        const perform = () => realPush(request)
        return script.push === undefined ? perform() : script.push(call, perform, observed)
      }

      const runStateAdopt = runStateAdoptExtension({
        repositoryHome: home,
        encodedMapIssueId: ENCODED_MAP,
      })

      const deps: ShipPushDeps = {
        git: runGit,
        gitDetailed: runGitDetailed,
        facts,
        readMap: () => {
          const read = mapReads++
          events.push(`readMap:${read}`)
          const scripted = (script.mapScript ?? options.mapScript)?.(read, () => acceptedMap)
          const outcome: StableSnapshotOutcome =
            scripted === undefined || isSnapshot(scripted)
              ? ok(isSnapshot(scripted) ? scripted : acceptedMap)
              : scripted
          return Promise.resolve(outcome)
        },
        adoptExtension: async (extension) => {
          events.push('adopt-begin')
          const scripted = script.adopt?.(extension, lock.isHeldNow)
          if (scripted !== undefined) return scripted
          const adopted = await runStateAdopt(extension)
          events.push('adopt-end')
          return adopted
        },
        readIssueEvidence: async () => ok({ comments: [], timeline: [] }),
        runner: reviewer,
        commands,
        planReviewer: () => ({ argv: ['pi', '--tools', 'read,grep,find,ls,norn_complete'] }),
        newInvocationId: () => `push-rev-${mapReads}-${reviewer.launches}`,
        push: pushSeam,
        checkpoint: script.markStageFails === true ? failingMarkStage(store) : store,
        lock: options.osLock === true ? osTargetLock(home, 'main', { waitMs: 5_000 }) : lock,
        now: () => SEALED_AT,
      }

      const params: ShipPushParams = {
        change,
        accepted: acceptedEntryOf(acceptedMap),
        runId: RUN_ID,
        repositoryRoot: repo.root,
        targetBranch: 'main',
        setup: [],
        tests: [{ argv: ['npm', 'test'], timeoutMs: 60_000 }],
        reviewer: {
          model: 'provider-b/model-y',
          thinking: 'high',
          timeoutMs: 60_000,
          family: 'provider-b',
        },
        trustedEvidenceAuthorIds: [ACTOR_ID],
        completionsDir: join(home, 'runs', RUN_ID, 'completions'),
        alreadyShipped: options.alreadyShipped ?? false,
        map: {
          role: 'map',
          githubHost: 'github.com',
          repositoryId: REPOSITORY_ID,
          issueId: MAP_ISSUE_ID,
          number: 6,
          url: MAP_URL,
        },
        wave: 1,
        configRevision: CONFIG_REVISION,
        nornVersion: NORN_VERSION,
        remote: 'origin',
        maxPushRetries: options.maxPushRetries ?? 0,
        gate: pushGate(),
        actorId: ACTOR_ID,
      }

      return shipPush(deps, params)
    },

    persisted() {
      const loaded = loadRunState(home, ENCODED_MAP)
      if (loaded.kind !== 'ok' || loaded.value === undefined) return undefined
      const ticket = loaded.value.tickets[TICKET_ISSUE_ID]
      if (ticket === undefined || ticket.phase !== 'shipping') return undefined
      return { wave: ticket.wave, change: ticket.change, checkpoint: ticket.checkpoint }
    },

    mutatePersisted(mutate) {
      const loaded = loadRunState(home, ENCODED_MAP)
      if (loaded.kind !== 'ok' || loaded.value === undefined) {
        throw new Error('no persisted run state to mutate')
      }
      const state = loaded.value
      const ticket = state.tickets[TICKET_ISSUE_ID]
      if (ticket === undefined || ticket.phase !== 'shipping') {
        throw new Error('no persisted shipping checkpoint to mutate')
      }
      const next: RunState = {
        ...state,
        tickets: {
          ...state.tickets,
          [TICKET_ISSUE_ID]: { ...ticket, checkpoint: mutate(ticket.checkpoint) },
        },
      }
      if (saveRunState(home, ENCODED_MAP, next).kind !== 'ok') {
        throw new Error('mutated run state failed its integrity checks')
      }
    },

    remoteMainSha() {
      return `sha1:${gitText(remote.path, ['rev-parse', 'main'])}`
    },

    cleanup() {
      rmSync(home, { recursive: true, force: true })
      remote.cleanup()
      repo.cleanup()
    },
  }

  function loadAdoptionCount(): number {
    const loaded = loadRunState(home, ENCODED_MAP)
    if (loaded.kind !== 'ok' || loaded.value === undefined) return 0
    return loaded.value.acceptedMapRevisions.length - 1
  }

  return harness
}

function isSnapshot(value: unknown): value is TaskMapSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TaskMapSnapshot).mapRevision === 'string' &&
    Array.isArray((value as TaskMapSnapshot).tickets)
  )
}

function gitFactsFailure(reason: string): Outcome<never, never, 'git-failed'> {
  return {
    kind: 'error',
    scope: 'operation',
    code: 'git-failed',
    reason,
    sharedWrite: 'none',
    evidence: [],
  } as const
}

/** A store wrapper whose markStage always fails (crash after verification). */
function failingMarkStage(store: ShipCheckpointStore): ShipCheckpointStore {
  return {
    load: store.load,
    loadCompleted: store.loadCompleted,
    prepare: store.prepare,
    incrementPushAttempts: store.incrementPushAttempts,
    complete: store.complete,
    markCleanedUp: store.markCleanedUp,
    async markStage() {
      return {
        kind: 'error',
        scope: 'run',
        code: 'control-store',
        reason: 'scripted markStage failure (crash after remote verification)',
        sharedWrite: 'none',
        evidence: [],
      } as const
    },
  }
}
