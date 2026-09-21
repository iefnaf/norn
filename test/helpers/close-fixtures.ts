/**
 * Shared fixtures for the Ship close tests (ticket #12, design.md §11.3,
 * §13.3 steps 3–5, §14).
 *
 * The "GitHub issue" is a fake multi-issue gateway with a scriptable,
 * mutable timeline: comments, close/reopen events, authorship, and write
 * failures are all staged in plain data, and every read returns the complete
 * current state — the §14 fully-paginated-read contract, deterministically.
 * The Git target truth is the `fakeFacts` data provider from the delivery
 * fixtures; the Ship Checkpoint store is the real Run-State-backed one, so
 * replay and interruption are modeled exactly as the design intends: by
 * re-invoking `shipClose` over the same persisted state.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ok } from '../../src/core/outcome.ts'
import type { Outcome } from '../../src/core/outcome.ts'
import { canonicalJson } from '../../src/core/canonical-json.ts'
import { canonicalJsonDigest } from '../../src/core/digest.ts'
import { encodePathSegment } from '../../src/config/paths.ts'
import { computeDeliveryId } from '../../src/evidence/delivery.ts'
import { formatRecordEnvelope } from '../../src/evidence/envelope.ts'
import type { IssueEvidenceRead, IssueTimelineEvent } from '../../src/evidence/read.ts'
import { loadRunState, saveRunState } from '../../src/runstate/run-state-store.ts'
import type {
  DeliveryRecordV1,
  EvidenceGateV1,
  RunState,
  ShippableChange,
  ShipCheckpoint,
  TestEvidence,
  TicketRef,
  WorkspaceRef,
} from '../../src/runstate/types.ts'
import { runStateShipCheckpointStore } from '../../src/ship/push.ts'
import type {
  LoadedCompletedTicket,
  ShipCheckpointStore,
} from '../../src/ship/push.ts'
import { runStateAdoptExtension } from '../../src/ship/reconcile.ts'
import type { ShipFacts } from '../../src/ship/reconcile.ts'
import { shipClose } from '../../src/ship/close.ts'
import type { ShipCloseDeps, ShipCloseOutcome, ShipCloseParams } from '../../src/ship/close.ts'
import type { StableSnapshotOutcome } from '../../src/map/stable-read.ts'
import type { TaskMapSnapshot } from '../../src/map/snapshot.ts'
import { fakeFacts } from './delivery-fixtures.ts'
import type { FakeFactsData } from './delivery-fixtures.ts'
import { recordingLock } from './push-fixtures.ts'
import type { RecordingLock } from './push-fixtures.ts'
import {
  REPOSITORY_ID,
  RUN_ID,
  TICKET_ISSUE_ID,
  acceptedEntryOf,
  defaultMap,
  revisionOf,
  sealedChange,
  snapshotOf,
  ticket7,
} from './ship-fixtures.ts'
import type { AcceptedMapRevision } from '../../src/runstate/types.ts'

export const MAP_ISSUE_ID = 'I_map'
export const ENCODED_MAP = encodePathSegment(MAP_ISSUE_ID)
export const ACTOR_ID = 'I_actor'
export const OTHER_AUTHOR_ID = 'I_other'
export const NORN_VERSION = '0.1.0'
export const CONFIG_REVISION = canonicalJsonDigest({ fixture: 'close-config' } as never)
export const SEALED_AT = '2025-01-02T03:04:05.006Z'

export const BASE_SHA = `sha1:${'1'.repeat(40)}`
export const BASE_TREE = `sha1:${'2'.repeat(40)}`
export const DELIVERED_TREE = `sha1:${'3'.repeat(40)}`
export const INTEGRATED_SHA = `sha1:${'4'.repeat(40)}`
export const TIP_SHA = `sha1:${'f'.repeat(40)}`
export const MOVED_TIP_SHA = `sha1:${'e'.repeat(40)}`

export const MAP_URL = 'https://github.com/acme/widget/issues/6'
export const TICKET_URL = 'https://github.com/acme/widget/issues/7'

/** The sealed gate: exactly the fixture's one configured test (§14 rule 8). */
export function closeGate(): EvidenceGateV1 {
  return {
    worker: { provider: 'provider-a', model: 'provider-a/model-x', family: 'provider-a', thinking: 'medium' },
    reviewer: { provider: 'provider-b', model: 'provider-b/model-y', family: 'provider-b', thinking: 'high' },
    tests: [{ argv: ['npm', 'test'], timeoutMs: 60_000 }],
  }
}

// ---------------------------------------------------------------------------
// The fake multi-issue gateway: scriptable timelines and writes
// ---------------------------------------------------------------------------

/** The mutable state of one fake issue. */
export type FakeIssueState = {
  state: 'OPEN' | 'CLOSED'
  comments: { commentId: string; authorId: string | null; body: string }[]
  timeline: IssueTimelineEvent[]
}

export function fakeIssue(state: 'OPEN' | 'CLOSED' = 'OPEN'): FakeIssueState {
  return { state, comments: [], timeline: [] }
}

export type GatewayScript = {
  /** Fail the next (or every) comment write with this reason. */
  readonly writeCommentFails?: string
  /** Fail the next (or every) close with this reason. */
  readonly closeFails?: string
  /** Fail the next (or every) reopen with this reason. */
  readonly reopenFails?: string
  /** Attribute comments written through the gateway to this author. */
  readonly writeAuthorId?: string
  /** The actor recorded on close/reopen events the gateway appends. */
  readonly stateActorId?: string | null
}

export type FakeGateway = {
  readonly issue: (number: number) => FakeIssueState
  readonly writeCalls: readonly { readonly body: string }[]
  readonly closeCalls: number
  readonly reopenCalls: number
  readonly readCalls: number
}

type GatewayCounters = {
  writeCalls: { body: string }[]
  closeCalls: number
  reopenCalls: number
  readCalls: number
  nextComment: number
  nextEvent: number
}

/**
 * The fake issue gateway: `readIssueEvidence` returns each issue's complete
 * current comments and timeline; `writeIssueComment`, `closeIssue`, and
 * `reopenIssue` mutate the addressed issue and append matching timeline
 * events, or fail as scripted. Failures model *unknown* results: the caller
 * must treat them as recoverable, never as proof the write did not happen.
 * Counters and ID sequences are shared across every run over one harness,
 * so replay tests can assert exactly what a later invocation wrote.
 */
export function fakeIssueGateway(
  issues: Map<number, FakeIssueState>,
  script: GatewayScript = {},
  shared?: GatewayCounters,
): FakeGateway & Pick<ShipCloseDeps, 'readIssueEvidence'> & ShipCloseDeps['writer'] {
  const counters: GatewayCounters = shared ?? {
    writeCalls: [],
    closeCalls: 0,
    reopenCalls: 0,
    readCalls: 0,
    nextComment: 1,
    nextEvent: 1,
  }

  const issueOf = (number: number): FakeIssueState => {
    const issue = issues.get(number)
    if (issue === undefined) throw new Error(`fake gateway has no issue #${number}`)
    return issue
  }
  const failure = (reason: string): Outcome<never, never, 'github-unavailable'> => ({
    kind: 'error' as const,
    scope: 'operation' as const,
    code: 'github-unavailable' as const,
    reason,
    sharedWrite: 'none' as const,
    evidence: [],
  })

  return {
    issue: issueOf,
    writeCalls: counters.writeCalls,
    get closeCalls() {
      return counters.closeCalls
    },
    get reopenCalls() {
      return counters.reopenCalls
    },
    get readCalls() {
      return counters.readCalls
    },

    async readIssueEvidence(locator) {
      counters.readCalls += 1
      const issue = issueOf(locator.number)
      const read: IssueEvidenceRead = {
        comments: issue.comments.map((comment) => ({ ...comment })),
        timeline: issue.timeline.map((event) => ({ ...event })),
      }
      return ok(read)
    },

    async writeIssueComment(locator, body) {
      if (script.writeCommentFails !== undefined) return failure(script.writeCommentFails)
      const issue = issueOf(locator.number)
      const commentId = `C${counters.nextComment++}`
      const eventId = `E${counters.nextEvent++}`
      issue.comments.push({ commentId, authorId: script.writeAuthorId ?? ACTOR_ID, body })
      issue.timeline.push({ kind: 'commented', eventId, commentId })
      counters.writeCalls.push({ body })
      return ok({ commentId })
    },

    async closeIssue(locator) {
      if (script.closeFails !== undefined) return failure(script.closeFails)
      const issue = issueOf(locator.number)
      issue.state = 'CLOSED'
      issue.timeline.push({
        kind: 'closed',
        eventId: `E${counters.nextEvent++}`,
        actorId: script.stateActorId ?? ACTOR_ID,
      })
      counters.closeCalls += 1
      return ok(undefined)
    },

    async reopenIssue(locator) {
      if (script.reopenFails !== undefined) return failure(script.reopenFails)
      const issue = issueOf(locator.number)
      issue.state = 'OPEN'
      issue.timeline.push({
        kind: 'reopened',
        eventId: `E${counters.nextEvent++}`,
        actorId: script.stateActorId ?? ACTOR_ID,
      })
      counters.reopenCalls += 1
      return ok(undefined)
    },
  }
}

// ---------------------------------------------------------------------------
// The sealed checkpoint fixture
// ---------------------------------------------------------------------------

export type CloseFixtureInit = {
  readonly zeroDelta?: boolean
  readonly stage?: ShipCheckpoint['stage']
  readonly map?: TaskMapSnapshot
}

/** The sealed record, checkpoint, and change of one fixture shipment. */
export type CloseFixture = {
  readonly record: DeliveryRecordV1
  readonly checkpoint: ShipCheckpoint
  readonly change: ShippableChange
  readonly accepted: AcceptedMapRevision
  readonly map: TaskMapSnapshot
  readonly workspace: WorkspaceRef
}

export function makeCloseFixture(init: CloseFixtureInit = {}): CloseFixture {
  const map = init.map ?? defaultMap()
  const accepted = acceptedEntryOf(map)
  const zeroDelta = init.zeroDelta === true
  const baseSha = BASE_SHA
  const integratedSha = zeroDelta ? BASE_SHA : INTEGRATED_SHA
  const treeOid = zeroDelta ? BASE_TREE : DELIVERED_TREE
  const mapRevision = map.mapRevision
  const ticketRevision = revisionOf(map, TICKET_ISSUE_ID)

  const workspace: WorkspaceRef = {
    kind: 'ticket',
    repositoryId: REPOSITORY_ID,
    runId: RUN_ID,
    path: '/workspace/does-not-exist-yet',
    branch: `norn/${RUN_ID}/7/wa-1`,
    workAttemptId: 'wa-1',
  }
  const change = sealedChange({
    mapRevision,
    ticketRevision,
    baseSha,
    candidateCommit: `sha1:${'a'.repeat(40)}`,
    candidateTreeOid: treeOid,
    workspace,
  })
  // The checkpoint reuses the sealed Work evidence verbatim (§11.2: the
  // target did not advance in the fixture).
  const tests = change.tests
  const review = change.review

  const draft: Omit<DeliveryRecordV1, 'deliveryId'> = {
    schema: 'norn-delivery:v1',
    run: { id: RUN_ID, configRevision: CONFIG_REVISION, nornVersion: NORN_VERSION },
    gate: closeGate(),
    map: { issueId: MAP_ISSUE_ID, revision: mapRevision },
    ticket: { issueId: TICKET_ISSUE_ID, revision: ticketRevision },
    target: {
      repositoryId: REPOSITORY_ID,
      branch: 'main',
      baseSha,
      integratedSha,
      treeOid,
    },
    review,
    tests,
    actorId: ACTOR_ID,
    recordedAt: SEALED_AT,
  }
  const record: DeliveryRecordV1 = { ...draft, deliveryId: computeDeliveryId(draft) }

  const checkpoint: ShipCheckpoint = {
    stage: init.stage ?? 'push-verified',
    pushAttempts: zeroDelta ? 0 : 1,
    zeroDelta,
    baseSha,
    integratedSha,
    treeOid,
    tests,
    review,
    delivery: record,
  }
  return { record, checkpoint, change, accepted, map, workspace }
}

/** The machine-comment body of one record, exactly as Norn renders it. */
export function recordBodyOf(record: DeliveryRecordV1): string {
  return formatRecordEnvelope(canonicalJson(record as never))
}

/** A record comment carrying tampered content under the same claimed ID. */
export function divergentBodyOf(record: DeliveryRecordV1): string {
  const tampered = { ...record, recordedAt: '2025-01-02T03:04:05.007Z' }
  return formatRecordEnvelope(canonicalJson(tampered as never))
}

/** A marked comment whose machine block is malformed. */
export const MALFORMED_MARKED_BODY = '<!-- norn:record -->\n```json\n{not json}\n```\n'

/**
 * A valid Delivery Record for a *different* member of the same map — the
 * fixture blocker's Completed Ticket evidence — sealed like the shipped
 * record and bound to the same fake target truth.
 */
export function auxiliaryDeliveryRecord(map: TaskMapSnapshot, ticketIssueId: string): DeliveryRecordV1 {
  const ticketRevision = revisionOf(map, ticketIssueId)
  const tests: TestEvidence[] = [
    {
      phase: 'work',
      testIndex: 0,
      argv: ['npm', 'test'],
      timeoutMs: 60_000,
      baseSha: BASE_SHA,
      treeOid: DELIVERED_TREE,
      exitCode: 0,
      outputDigest: canonicalJsonDigest({ fixture: 'auxiliary-test' } as never),
    },
  ]
  const draft: Omit<DeliveryRecordV1, 'deliveryId'> = {
    schema: 'norn-delivery:v1',
    run: { id: 'run-earlier', configRevision: CONFIG_REVISION, nornVersion: NORN_VERSION },
    gate: closeGate(),
    map: { issueId: MAP_ISSUE_ID, revision: map.mapRevision },
    ticket: { issueId: ticketIssueId, revision: ticketRevision },
    target: {
      repositoryId: REPOSITORY_ID,
      branch: 'main',
      baseSha: BASE_SHA,
      integratedSha: INTEGRATED_SHA,
      treeOid: DELIVERED_TREE,
    },
    review: {
      phase: 'work',
      provider: 'provider-b',
      model: 'provider-b/model-y',
      family: 'provider-b',
      thinking: 'high',
      verdict: 'pass',
      mapRevision: map.mapRevision,
      ticketRevision,
      baseSha: BASE_SHA,
      treeOid: DELIVERED_TREE,
      testEvidenceDigest: canonicalJsonDigest(tests as never),
    },
    tests,
    actorId: ACTOR_ID,
    recordedAt: SEALED_AT,
  }
  return { ...draft, deliveryId: computeDeliveryId(draft) }
}

/** A closed blocker issue carrying valid Completed Ticket evidence. */
export function completedBlockerIssue(map: TaskMapSnapshot, ticketIssueId: string): FakeIssueState {
  const record = auxiliaryDeliveryRecord(map, ticketIssueId)
  const issue = fakeIssue('CLOSED')
  issue.comments.push({ commentId: 'B1', authorId: ACTOR_ID, body: recordBodyOf(record) })
  issue.timeline.push(
    { kind: 'commented', eventId: 'BE1', commentId: 'B1' },
    { kind: 'closed', eventId: 'BE2', actorId: ACTOR_ID },
  )
  return issue
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export type RunCloseScript = {
  /** Script the map read; the global read index spans every run. */
  readonly mapScript?: (
    read: number,
    snapshot: () => TaskMapSnapshot,
  ) => TaskMapSnapshot | StableSnapshotOutcome
  /** Fail the gateway's comment write in this run. */
  readonly writeCommentFails?: string
  /** Fail the gateway's close in this run. */
  readonly closeFails?: string
  /** Fail the gateway's reopen in this run. */
  readonly reopenFails?: string
  /** Attribute this run's written comments to another author. */
  readonly writeAuthorId?: string
  /** Fail this run's workspace cleanup. */
  readonly cleanupFails?: string
  /** Fail the store's markStage call for this stage once (crash model). */
  readonly failMarkStageOnce?: ShipCheckpoint['stage']
  /** Override the fake Git facts data for this run. */
  readonly facts?: FakeFactsData
}

export type CloseHarnessOptions = {
  readonly label: string
  readonly zeroDelta?: boolean
  readonly stage?: ShipCheckpoint['stage']
  /** A map with blockers for blocker-revalidation coverage. */
  readonly map?: TaskMapSnapshot
  /** Extra fake issues (blockers), keyed by issue number. */
  readonly issues?: ReadonlyMap<number, FakeIssueState>
  /** Comments pre-seeded on the shipped ticket before the first run. */
  readonly preseedComments?: readonly { authorId?: string | null; body: string }[]
  /** Timeline events pre-seeded after the pre-seeded comments' events. */
  readonly preseedEvents?: readonly IssueTimelineEvent[]
  /** The initial state of the shipped ticket. */
  readonly ticketState?: 'OPEN' | 'CLOSED'
  /** Script the map read on every run (global read index). */
  readonly mapScript?: RunCloseScript['mapScript']
  readonly alreadyShipped?: boolean
}

export type CloseHarness = {
  readonly repositoryHome: string
  readonly fixture: CloseFixture
  readonly ticketIssue: FakeIssueState
  readonly gateway: FakeGateway
  readonly lock: RecordingLock
  readonly events: string[]
  readonly workspacePath: string
  readonly counts: { readonly mapReads: () => number }
  run(script?: RunCloseScript): Promise<ShipCloseOutcome>
  /** The persisted shipping state of the ticket, or `undefined`. */
  persisted(): ShipCheckpoint | undefined
  /** The persisted completed state of the ticket, or `undefined`. */
  persistedCompleted(): LoadedCompletedTicket | undefined
  cleanup(): void
}

/** Build the full §11.3 close harness over one fake gateway and Run State. */
export function makeCloseHarness(options: CloseHarnessOptions): CloseHarness {
  const home = mkdtempSync(join(tmpdir(), `norn-close-home-${options.label}-`))
  const workspaceScratch = mkdtempSync(join(tmpdir(), `norn-close-ws-${options.label}-`))
  const events: string[] = []
  let mapReads = 0

  const fixture = makeCloseFixture({
    zeroDelta: options.zeroDelta,
    stage: options.stage,
    map: options.map,
  })
  const workspacePath = workspaceScratch
  const workspace: WorkspaceRef = { ...fixture.workspace, path: workspacePath }
  // Rebuild the fixture map with one dynamic fact overridden — the shipped
  // ticket's state — leaving every revision untouched (§7.3).
  const mapOf = (state: 'OPEN' | 'CLOSED'): TaskMapSnapshot =>
    options.map === undefined
      ? snapshotOf([ticket7({ state })])
      : withTicketState(options.map, TICKET_ISSUE_ID, state)

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
    acceptedMapRevisions: [fixture.accepted],
    configRevision: CONFIG_REVISION,
    nornVersion: NORN_VERSION,
    status: 'running',
    wave: 1,
    parkedTickets: [],
    tickets: {
      [TICKET_ISSUE_ID]: {
        phase: 'shipping',
        wave: 1,
        change: { ...fixture.change, workspace },
        checkpoint: fixture.checkpoint,
      },
    },
    activeProcesses: [],
  }
  if (saveRunState(home, ENCODED_MAP, initial).kind !== 'ok') {
    throw new Error('fixture run state failed its integrity checks')
  }

  const ticketIssue = fakeIssue(options.ticketState ?? 'OPEN')
  const issues = new Map<number, FakeIssueState>([[7, ticketIssue], ...(options.issues ?? [])])
  let nextPreseedComment = 100
  let nextPreseedEvent = 100
  for (const comment of options.preseedComments ?? []) {
    const commentId = `P${nextPreseedComment++}`
    ticketIssue.comments.push({
      commentId,
      authorId: comment.authorId === undefined ? ACTOR_ID : comment.authorId,
      body: comment.body,
    })
    ticketIssue.timeline.push({
      kind: 'commented',
      eventId: `PE${nextPreseedEvent++}`,
      commentId,
    })
  }
  for (const event of options.preseedEvents ?? []) ticketIssue.timeline.push({ ...event })

  const gatewayScript: GatewayScript = {}
  const sharedCounters: GatewayCounters = {
    writeCalls: [],
    closeCalls: 0,
    reopenCalls: 0,
    readCalls: 0,
    nextComment: 1,
    nextEvent: 1,
  }
  const gateway = fakeIssueGateway(issues, gatewayScript, sharedCounters)
  const lock = recordingLock({}, events)
  // The live map read: exactly what a fresh GitHub read of the fixture map
  // would report — the shipped ticket's dynamic state mirrors the fake
  // issue, while every revision stays the accepted one (§7.3).
  const liveMap = (): TaskMapSnapshot =>
    mapOf(ticketIssue.state)
  const store = runStateShipCheckpointStore({
    repositoryHome: home,
    encodedMapIssueId: ENCODED_MAP,
    ticketIssueId: TICKET_ISSUE_ID,
  })

  const harness: CloseHarness = {
    repositoryHome: home,
    fixture,
    ticketIssue,
    gateway,
    lock,
    events,
    workspacePath,
    counts: { mapReads: () => mapReads },
    run(script = {}) {
      return runShipClose(script)
    },
    persisted() {
      const loaded = loadRunState(home, ENCODED_MAP)
      if (loaded.kind !== 'ok' || loaded.value === undefined) return undefined
      const ticket = loaded.value.tickets[TICKET_ISSUE_ID]
      if (ticket === undefined || ticket.phase !== 'shipping') return undefined
      return ticket.checkpoint
    },
    persistedCompleted() {
      const loaded = loadRunState(home, ENCODED_MAP)
      if (loaded.kind !== 'ok' || loaded.value === undefined) return undefined
      const ticket = loaded.value.tickets[TICKET_ISSUE_ID]
      if (ticket === undefined || ticket.phase !== 'completed') return undefined
      return {
        deliveryId: ticket.deliveryId,
        integratedSha: ticket.integratedSha,
        ...(ticket.cleanupWorkspace !== undefined
          ? { cleanupWorkspace: ticket.cleanupWorkspace }
          : {}),
      }
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true })
      rmSync(workspaceScratch, { recursive: true, force: true })
    },
  }

  async function runShipClose(script: RunCloseScript): Promise<ShipCloseOutcome> {
    const zeroDelta = fixture.checkpoint.zeroDelta
    const factsData: FakeFactsData =
      script.facts ??
      {
        targetSha: zeroDelta ? BASE_SHA : TIP_SHA,
        commits: zeroDelta
          ? { [BASE_SHA]: { treeOid: BASE_TREE, parents: [] } }
          : {
              [INTEGRATED_SHA]: { treeOid: DELIVERED_TREE, parents: [BASE_SHA] },
              [BASE_SHA]: { treeOid: BASE_TREE, parents: [] },
            },
        ancestors: zeroDelta ? [BASE_SHA, TIP_SHA] : [INTEGRATED_SHA, BASE_SHA, TIP_SHA],
      }
    const baseFacts = fakeFacts(factsData)
    const facts: ShipFacts = {
      ...baseFacts,
      fetchTarget: async () => ok(undefined),
    }

    const runScopedGateway = fakeIssueGateway(
      issues,
      {
        writeCommentFails: script.writeCommentFails,
        closeFails: script.closeFails,
        reopenFails: script.reopenFails,
        writeAuthorId: script.writeAuthorId,
      },
      sharedCounters,
    )

    const adopt = runStateAdoptExtension({
      repositoryHome: home,
      encodedMapIssueId: ENCODED_MAP,
    })

    const scriptedStore: ShipCheckpointStore = script.failMarkStageOnce
      ? failMarkStageOnce(store, script.failMarkStageOnce)
      : store

    const cleanup = async (target: WorkspaceRef) => {
      if (script.cleanupFails !== undefined) {
        return {
          kind: 'error' as const,
          scope: 'run' as const,
          code: 'cleanup-failed' as const,
          reason: script.cleanupFails,
          sharedWrite: 'none' as const,
          evidence: [],
        }
      }
      rmSync(target.path, { recursive: true, force: true })
      return ok(undefined)
    }

    const deps: ShipCloseDeps = {
      readMap: () => {
        const read = mapReads++
        events.push(`readMap:${read}`)
        const scripted = (script.mapScript ?? options.mapScript)?.(read, liveMap)
        const outcome: StableSnapshotOutcome =
          scripted === undefined || isSnapshot(scripted) ? ok(scripted ?? liveMap()) : scripted
        return Promise.resolve(outcome)
      },
      readIssueEvidence: (locator) => runScopedGateway.readIssueEvidence(locator),
      writer: runScopedGateway,
      facts,
      adoptExtension: async (extension) => {
        events.push('adopt')
        return adopt(extension)
      },
      checkpoint: scriptedStore,
      lock,
      cleanup,
    }

    const params: ShipCloseParams = {
      map: {
        role: 'map',
        githubHost: 'github.com',
        repositoryId: REPOSITORY_ID,
        issueId: MAP_ISSUE_ID,
        number: 6,
        url: MAP_URL,
      },
      ticket: fixture.change.ticket,
      accepted: fixture.accepted,
      runId: RUN_ID,
      targetBranch: 'main',
      trustedEvidenceAuthorIds: [ACTOR_ID],
      alreadyShipped: options.alreadyShipped ?? false,
    }

    return shipClose(deps, params)
  }

  return harness
}

/** A store wrapper failing the first markStage of the given stage once. */
function failMarkStageOnce(store: ShipCheckpointStore, stage: ShipCheckpoint['stage']): ShipCheckpointStore {
  let failed = false
  return {
    load: store.load,
    loadCompleted: store.loadCompleted,
    prepare: store.prepare,
    incrementPushAttempts: store.incrementPushAttempts,
    complete: store.complete,
    markCleanedUp: store.markCleanedUp,
    async markStage(requested) {
      if (!failed && requested === stage) {
        failed = true
        return {
          kind: 'error' as const,
          scope: 'run' as const,
          code: 'control-store' as const,
          reason: `scripted markStage(${stage}) failure (crash before the local stage update)`,
          sharedWrite: 'none' as const,
          evidence: [],
        }
      }
      return store.markStage(requested)
    },
  }
}

function isSnapshot(value: unknown): value is TaskMapSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TaskMapSnapshot).mapRevision === 'string' &&
    Array.isArray((value as TaskMapSnapshot).tickets)
  )
}

/** One snapshot with a member's dynamic state overridden (§7.3: revisions ignore state). */
export function withTicketState(
  map: TaskMapSnapshot,
  issueId: string,
  state: 'OPEN' | 'CLOSED',
): TaskMapSnapshot {
  return {
    ...map,
    tickets: map.tickets.map((ticket) =>
      ticket.ref.issueId === issueId ? { ...ticket, state } : ticket,
    ),
  }
}

/** Whether the harness workspace directory currently exists on disk. */
export function workspaceExists(harness: CloseHarness): boolean {
  return existsSync(harness.workspacePath)
}

/** The ticket reference of the fixture shipment. */
export function fixtureTicketRef(): TicketRef {
  return {
    role: 'ticket',
    githubHost: 'github.com',
    repositoryId: REPOSITORY_ID,
    issueId: TICKET_ISSUE_ID,
    number: 7,
    url: TICKET_URL,
  }
}
