/**
 * Deterministic delivery-evidence fixtures (design.md §14): valid records
 * with correctly sealed `deliveryId`s, issue comment/timeline reads, and a
 * fake Git-facts provider — no network, no clock, no Git binary.
 */
import { canonicalJson } from '../../src/core/canonical-json.ts'
import { canonicalJsonDigest } from '../../src/core/digest.ts'
import { computeTicketRevision } from '../../src/core/revision.ts'
import { ok } from '../../src/core/outcome.ts'
import type { Outcome } from '../../src/core/outcome.ts'
import { formatRecordEnvelope } from '../../src/evidence/envelope.ts'
import { computeDeliveryId } from '../../src/evidence/delivery.ts'
import type {
  DeliveryCommitFacts,
  DeliveryFactsErrorCode,
  DeliveryTargetFacts,
} from '../../src/evidence/delivery.ts'
import type {
  IssueEvidenceComment,
  IssueEvidenceRead,
  IssueTimelineEvent,
} from '../../src/evidence/read.ts'
import type { DeliveryRecordV1, EvidenceGateV1, TestEvidence } from '../../src/runstate/types.ts'

export const HOST = 'github.com'
export const REPOSITORY_ID = 'R_kgDOMAP'
export const MAP_ISSUE_ID = 'I_map'
export const TICKET_ISSUE_ID = 'I_A'
export const ACTOR_ID = 'I_actor'
export const OTHER_AUTHOR_ID = 'I_other'
export const TARGET_BRANCH = 'main'

export const BASE_SHA = `sha1:${'1'.repeat(40)}`
export const INTEGRATED_SHA = `sha1:${'4'.repeat(40)}`
export const BASE_TREE = `sha1:${'2'.repeat(40)}`
export const DELIVERED_TREE = `sha1:${'3'.repeat(40)}`
export const TIP_SHA = `sha1:${'f'.repeat(40)}`

/** The current Ticket Revision of the fixture ticket specification. */
export function fixtureTicketRevision(
  ticketIssueId: string = TICKET_ISSUE_ID,
): string {
  return computeTicketRevision({
    githubHost: HOST,
    repositoryId: REPOSITORY_ID,
    ticketIssueId,
    title: `Ticket ${ticketIssueId}`,
    body: `Body of ${ticketIssueId}`,
  }).revision
}

export const MAP_REVISION = canonicalJsonDigest({ fixture: 'map-revision' })

/** The default sealed gate: two families, one test command. */
export function fixtureGate(): EvidenceGateV1 {
  return {
    worker: { provider: 'provider-a', model: 'provider-a/model-x', family: 'provider-a', thinking: 'medium' },
    reviewer: { provider: 'provider-b', model: 'provider-b/model-y', family: 'provider-b', thinking: 'high' },
    tests: [{ argv: ['npm', 'test'], timeoutMs: 60_000 }],
  }
}

export function fixtureTests(options: {
  phase?: 'work' | 'ship'
  baseSha?: string
  treeOid?: string
  count?: number
} = {}): TestEvidence[] {
  const phase = options.phase ?? 'work'
  const baseSha = options.baseSha ?? BASE_SHA
  const treeOid = options.treeOid ?? DELIVERED_TREE
  const count = options.count ?? 1
  return Array.from({ length: count }, (_, index) => ({
    phase,
    testIndex: index,
    argv: ['npm', 'test'],
    timeoutMs: 60_000,
    baseSha,
    treeOid,
    exitCode: 0 as const,
    outputDigest: canonicalJsonDigest({ test: index, output: 'ok' }),
  }))
}

export type MakeRecordOptions = {
  mapIssueId?: string
  repositoryId?: string
  mapRevision?: string
  ticketIssueId?: string
  ticketRevision?: string
  actorId?: string
  branch?: string
  baseSha?: string
  integratedSha?: string
  treeOid?: string
  phase?: 'work' | 'ship'
  gate?: EvidenceGateV1
  tests?: TestEvidence[]
  /** Apply arbitrary mutations before the deliveryId is sealed. */
  mutate?: (draft: Record<string, unknown>) => void
}

/**
 * Build one structurally valid `DeliveryRecordV1` whose `deliveryId` is
 * sealed over the exact mutated content, so tests tamper through `mutate`
 * and the recomputation check notices.
 */
export function makeDeliveryRecord(options: MakeRecordOptions = {}): DeliveryRecordV1 {
  const gate = options.gate ?? fixtureGate()
  const phase = options.phase ?? 'work'
  const baseSha = options.baseSha ?? BASE_SHA
  const integratedSha = options.integratedSha ?? INTEGRATED_SHA
  const treeOid = options.treeOid ?? DELIVERED_TREE
  const tests = options.tests ?? fixtureTests({ phase, baseSha, treeOid })
  const mapRevision = options.mapRevision ?? MAP_REVISION
  const ticketRevision = options.ticketRevision ?? fixtureTicketRevision()

  const draft: Record<string, unknown> = {
    schema: 'norn-delivery:v1',
    deliveryId: '',
    run: {
      id: 'run-1',
      configRevision: canonicalJsonDigest({ fixture: 'config' }),
      nornVersion: '0.1.0',
    },
    gate,
    map: { issueId: options.mapIssueId ?? MAP_ISSUE_ID, revision: mapRevision },
    ticket: {
      issueId: options.ticketIssueId ?? TICKET_ISSUE_ID,
      revision: ticketRevision,
    },
    target: {
      repositoryId: options.repositoryId ?? REPOSITORY_ID,
      branch: options.branch ?? TARGET_BRANCH,
      baseSha,
      integratedSha,
      treeOid,
    },
    review: {
      phase,
      provider: gate.reviewer.provider,
      model: gate.reviewer.model,
      family: gate.reviewer.family,
      thinking: gate.reviewer.thinking,
      verdict: 'pass' as const,
      mapRevision,
      ticketRevision,
      baseSha,
      treeOid,
      testEvidenceDigest: canonicalJsonDigest(tests as never),
    },
    tests,
    actorId: options.actorId ?? ACTOR_ID,
    recordedAt: '2025-01-02T03:04:05.006Z',
  }
  options.mutate?.(draft)

  const { deliveryId: _omit, ...sealed } = draft as DeliveryRecordV1 & { deliveryId: string }
  draft.deliveryId = computeDeliveryId(sealed)
  return draft as DeliveryRecordV1
}

/** The machine-comment body Norn writes for one sealed record. */
export function recordBody(record: DeliveryRecordV1): string {
  return formatRecordEnvelope(canonicalJson(record as never))
}

export function recordComment(
  record: DeliveryRecordV1,
  options: { commentId?: string; authorId?: string | null } = {},
): IssueEvidenceComment {
  return {
    commentId: options.commentId ?? 'C1',
    authorId: options.authorId === undefined ? ACTOR_ID : options.authorId,
    body: recordBody(record),
  }
}

/** A prose comment — never parsed as a record. */
export function proseComment(commentId: string, body = 'Looks good.'): IssueEvidenceComment {
  return { commentId, authorId: ACTOR_ID, body }
}

/** The default timeline: the record comments, then the current close. */
export function fixtureTimeline(
  commentIds: readonly string[] = ['C1'],
  options: { closed?: boolean; actorId?: string | null; extra?: readonly IssueTimelineEvent[] } = {},
): IssueTimelineEvent[] {
  const events: IssueTimelineEvent[] = commentIds.map((commentId, index) => ({
    kind: 'commented',
    eventId: `E${index + 1}`,
    commentId,
  }))
  if (options.closed !== false) {
    events.push({ kind: 'closed', eventId: 'E_close', actorId: options.actorId ?? ACTOR_ID })
  }
  for (const extra of options.extra ?? []) events.push(extra)
  return events
}

export function evidenceRead(
  comments: readonly IssueEvidenceComment[],
  timeline: readonly IssueTimelineEvent[],
): IssueEvidenceRead {
  return { comments: [...comments], timeline: [...timeline] }
}

export type FakeFactsData = {
  targetSha?: string
  commits?: Record<string, DeliveryCommitFacts>
  ancestors?: readonly string[]
  error?: { readonly code: DeliveryFactsErrorCode; readonly reason: string }
}

/** The default commit database: one non-zero integration on the base. */
export function defaultCommits(): Record<string, DeliveryCommitFacts> {
  return {
    [INTEGRATED_SHA]: { treeOid: DELIVERED_TREE, parents: [BASE_SHA] },
    [BASE_SHA]: { treeOid: BASE_TREE, parents: [] },
  }
}

/**
 * A `DeliveryTargetFacts` provider answering from plain data; every method
 * returns `ok`, or the configured infrastructure error, deterministically.
 */
export function fakeFacts(data: FakeFactsData = {}): DeliveryTargetFacts & { calls: string[] } {
  const commits = new Map(Object.entries(data.commits ?? defaultCommits()))
  const ancestors = new Set(data.ancestors ?? [INTEGRATED_SHA, BASE_SHA, TIP_SHA])
  const calls: string[] = []
  const fail = (): Outcome<never, never, DeliveryFactsErrorCode> =>
    ({ kind: 'error', scope: 'operation', code: data.error!.code, reason: data.error!.reason, sharedWrite: 'none', evidence: [] }) as never
  return {
    calls,
    async targetSha(branch) {
      calls.push(`targetSha:${branch}`)
      if (data.error !== undefined) return fail()
      return ok(data.targetSha ?? TIP_SHA)
    },
    async commitFacts(sha) {
      calls.push(`commitFacts:${sha}`)
      if (data.error !== undefined) return fail()
      return ok(commits.get(sha))
    },
    async isAncestorOfTarget(sha, branch) {
      calls.push(`isAncestor:${sha}`)
      if (data.error !== undefined) return fail()
      return ok(ancestors.has(sha))
    },
  }
}
