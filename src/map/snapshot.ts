/**
 * Task Map snapshot computation and native-topology validation
 * (design.md §7.1–7.3).
 *
 * A `RawTaskMapLoad` becomes a `TaskMapSnapshot` only when its native
 * topology satisfies every §7.2 rule; otherwise the validator reports every
 * independently discoverable violation as typed findings rather than stopping
 * at the first. Revisions are computed only for structurally valid snapshots
 * (§7.3), from the normalized §7.3 payloads in `src/core/revision.ts`, so
 * issue state, labels, display order, URLs, and repository renames never
 * change a revision while any title, body, membership, or topology change
 * does.
 *
 * Pure functions over in-memory data: no I/O, no clock.
 */
import { compareUtf16CodeUnits } from '../core/canonical-json.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'
import { canonicalJson } from '../core/canonical-json.ts'
import type { Sha256Digest } from '../core/digest.ts'
import { computeMapRevision, computeTicketRevision } from '../core/revision.ts'
import { normalizeIssueHost } from './issue-url.ts'
import type { RawIssueRef, RawMapIssue, RawMemberIssue, RawTaskMapLoad } from './loader.ts'

/**
 * A stable issue reference carrying both immutable identity and mutable
 * display locators (§7.3). Reference equality uses canonical `githubHost`,
 * `repositoryId`, and `issueId`; the role tag prevents Map and Ticket
 * references from being mixed accidentally and is not part of identity.
 */
export type StableIssueRef<Role extends 'map' | 'ticket'> = {
  readonly role: Role
  readonly githubHost: string
  readonly repositoryId: string
  readonly issueId: string
  /** Display locator only; never identity (§7.2). */
  readonly number: number
  readonly url: string
}

export type MapRef = StableIssueRef<'map'>
export type TicketRef = StableIssueRef<'ticket'>

/** One member Ticket of a snapshot, with its revision and blockers. */
export type MapTicketSnapshot = {
  readonly ref: TicketRef
  readonly title: string
  readonly body: string
  readonly state: 'OPEN' | 'CLOSED'
  readonly blockedBy: readonly TicketRef[]
  readonly ticketRevision: Sha256Digest
}

/** One complete, structurally valid Task Map snapshot (§7.3). */
export type TaskMapSnapshot = {
  readonly ref: MapRef
  readonly title: string
  readonly body: string
  readonly state: 'OPEN' | 'CLOSED'
  readonly mapRevision: Sha256Digest
  readonly tickets: readonly MapTicketSnapshot[]
}

/**
 * Reference identity: canonical `githubHost`, `repositoryId`, and `issueId`
 * (§7.3). Host is normalized before comparison because reference identity
 * uses the lowercase ASCII host with the default HTTPS port omitted.
 */
export function sameIssueIdentity(
  a: StableIssueRef<'map'> | StableIssueRef<'ticket'> | RawIssueRef,
  b: StableIssueRef<'map'> | StableIssueRef<'ticket'> | RawIssueRef,
): boolean {
  return (
    normalizeIssueHost(a.githubHost) === normalizeIssueHost(b.githubHost) &&
    a.repositoryId === b.repositoryId &&
    a.issueId === b.issueId
  )
}

/**
 * One independently discoverable violation of the §7.2 topology rules.
 * Validation reports every finding, not just the first.
 */
export type TopologyFinding =
  | { readonly code: 'map-has-no-members' }
  | { readonly code: 'map-is-sub-issue'; readonly parents: readonly RawIssueRef[] }
  | { readonly code: 'map-has-blockers'; readonly blockers: readonly RawIssueRef[] }
  | { readonly code: 'duplicate-member'; readonly memberRef: RawIssueRef }
  | { readonly code: 'member-is-map'; readonly memberRef: RawIssueRef }
  | {
      readonly code: 'cross-repository-member'
      readonly memberRef: RawIssueRef
      readonly expected: { readonly githubHost: string; readonly repositoryId: string }
    }
  | { readonly code: 'member-has-sub-issues'; readonly memberRef: RawIssueRef; readonly subIssues: readonly RawIssueRef[] }
  | { readonly code: 'member-has-other-parent'; readonly memberRef: RawIssueRef; readonly otherParents: readonly RawIssueRef[] }
  | { readonly code: 'member-not-child-of-map'; readonly memberRef: RawIssueRef; readonly actualParents: readonly RawIssueRef[] }
  | { readonly code: 'external-blocker'; readonly memberRef: RawIssueRef; readonly blockerRef: RawIssueRef }
  | { readonly code: 'member-self-block'; readonly memberRef: RawIssueRef }
  | { readonly code: 'dependency-cycle'; readonly cycleIssueIds: readonly string[] }

function sameRawIdentity(a: RawIssueRef, b: RawIssueRef): boolean {
  return (
    normalizeIssueHost(a.githubHost) === normalizeIssueHost(b.githubHost) &&
    a.repositoryId === b.repositoryId &&
    a.issueId === b.issueId
  )
}

function compareRawByIssueId(a: RawIssueRef, b: RawIssueRef): number {
  return compareUtf16CodeUnits(a.issueId, b.issueId)
}

function compareMembersByIssueId(a: RawMemberIssue, b: RawMemberIssue): number {
  return compareRawByIssueId(a.ref, b.ref)
}

/**
 * Validate one raw load against every §7.2 topology rule, reporting all
 * independently discoverable findings. Members are keyed by immutable issue
 * ID; duplicate IDs, the map itself as a member, cross-repository members,
 * nested members, unexpected parents, external and self blockers, and
 * dependency cycles each produce their own specific finding.
 */
export function validateTaskMapTopology(load: RawTaskMapLoad): readonly TopologyFinding[] {
  const findings: TopologyFinding[] = []
  const map = load.map

  // Rule 1: at least one direct member.
  if (load.members.length === 0) findings.push({ code: 'map-has-no-members' })

  // Rule 2: the map is not itself a sub-issue of another issue.
  if (map.parents.length > 0) {
    findings.push({ code: 'map-is-sub-issue', parents: [...map.parents].sort(compareRawByIssueId) })
  }

  // Rule 3: the map has no native blockers of its own.
  if (map.blockers.length > 0) {
    findings.push({ code: 'map-has-blockers', blockers: [...map.blockers].sort(compareRawByIssueId) })
  }

  // Rule 4 (identity half): unique immutable member IDs.
  const membersById = new Map<string, RawMemberIssue>()
  for (const member of load.members) {
    if (membersById.has(member.ref.issueId)) {
      findings.push({ code: 'duplicate-member', memberRef: member.ref })
    } else {
      membersById.set(member.ref.issueId, member)
    }
  }
  const members = [...membersById.values()].sort(compareMembersByIssueId)

  for (const member of members) {
    // Rule 4 (map-distinctness half): a member differs from the map issue.
    if (sameRawIdentity(member.ref, map.ref)) {
      findings.push({ code: 'member-is-map', memberRef: member.ref })
    }
    // Rule 4 (repository half): the member belongs to the map's repository.
    if (
      normalizeIssueHost(member.ref.githubHost) !== normalizeIssueHost(map.ref.githubHost) ||
      member.ref.repositoryId !== map.ref.repositoryId
    ) {
      findings.push({
        code: 'cross-repository-member',
        memberRef: member.ref,
        expected: { githubHost: map.ref.githubHost, repositoryId: map.ref.repositoryId },
      })
    }
    // Rule 5: the graph is flat — a member has no sub-issues.
    if (member.subIssues.length > 0) {
      findings.push({
        code: 'member-has-sub-issues',
        memberRef: member.ref,
        subIssues: [...member.subIssues].sort(compareRawByIssueId),
      })
    }
    // Rule 6: this map is the member's only parent issue.
    const otherParents = member.parents.filter((parent) => !sameRawIdentity(parent, map.ref))
    if (otherParents.length > 0) {
      findings.push({
        code: 'member-has-other-parent',
        memberRef: member.ref,
        otherParents: otherParents.sort(compareRawByIssueId),
      })
    }
    if (!member.parents.some((parent) => sameRawIdentity(parent, map.ref))) {
      findings.push({
        code: 'member-not-child-of-map',
        memberRef: member.ref,
        actualParents: [...member.parents].sort(compareRawByIssueId),
      })
    }
    // Rules 7–8 (edge halves): blockers are members, and no member blocks itself.
    for (const blocker of [...member.blockers].sort(compareRawByIssueId)) {
      if (sameRawIdentity(blocker, member.ref)) {
        findings.push({ code: 'member-self-block', memberRef: member.ref })
      } else if (!membersById.has(blocker.issueId)) {
        findings.push({ code: 'external-blocker', memberRef: member.ref, blockerRef: blocker })
      }
    }
  }

  // Rule 8 (graph half): the member dependency graph is acyclic.
  for (const cycle of findDependencyCycles(members, membersById)) {
    findings.push({ code: 'dependency-cycle', cycleIssueIds: cycle })
  }

  return sortFindings(findings)
}

/**
 * Enumerate dependency cycles over member-to-member edges. Each back-edge a
 * deterministic depth-first search discovers yields one finding carrying the
 * exact cycle's issue IDs in traversal order; roots and neighbor lists are
 * sorted by issue ID so the result never depends on API display order.
 */
function findDependencyCycles(
  members: readonly RawMemberIssue[],
  membersById: ReadonlyMap<string, RawMemberIssue>,
): readonly (readonly string[])[] {
  // Edge blocker -> blocked, derived from each member's blockedBy set.
  const adjacency = new Map<string, string[]>()
  for (const member of members) {
    for (const blocker of member.blockers) {
      if (blocker.issueId === member.ref.issueId) continue // self-block: its own finding
      if (!membersById.has(blocker.issueId)) continue // external blocker: its own finding
      const edges = adjacency.get(blocker.issueId) ?? []
      edges.push(member.ref.issueId)
      adjacency.set(blocker.issueId, edges)
    }
  }
  for (const edges of adjacency.values()) edges.sort(compareUtf16CodeUnits)

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const path: string[] = []
  const cycles: (readonly string[])[] = []

  const visit = (node: string): void => {
    color.set(node, GRAY)
    path.push(node)
    for (const next of adjacency.get(node) ?? []) {
      const nextColor = color.get(next) ?? WHITE
      if (nextColor === GRAY) {
        const start = path.indexOf(next)
        cycles.push([...path.slice(start)])
      } else if (nextColor === WHITE) {
        visit(next)
      }
    }
    path.pop()
    color.set(node, BLACK)
  }

  for (const member of members) {
    if ((color.get(member.ref.issueId) ?? WHITE) === WHITE) {
      visit(member.ref.issueId)
    }
  }
  return cycles
}

/** Total deterministic finding order: by code, then by canonical JSON. */
function sortFindings(findings: readonly TopologyFinding[]): readonly TopologyFinding[] {
  return [...findings].sort(
    (a, b) =>
      compareUtf16CodeUnits(a.code, b.code) ||
      compareUtf16CodeUnits(canonicalJson(a as CanonicalJsonValue), canonicalJson(b as CanonicalJsonValue)),
  )
}

/** Result of evaluating one complete raw load (§7.2 → §7.3). */
export type SnapshotEvaluation =
  | { readonly valid: true; readonly snapshot: TaskMapSnapshot }
  | { readonly valid: false; readonly findings: readonly TopologyFinding[] }

/**
 * Evaluate one complete raw load: validate every §7.2 topology rule and, only
 * when the load is structurally valid, compute the Task Map snapshot with its
 * Ticket Revisions and Map Revision (§7.3). A structurally invalid load
 * produces typed findings and no revision.
 */
export function evaluateTaskMapLoad(load: RawTaskMapLoad): SnapshotEvaluation {
  const findings = validateTaskMapTopology(load)
  if (findings.length > 0) return { valid: false, findings }
  return { valid: true, snapshot: buildSnapshot(load) }
}

/**
 * Build the snapshot of a structurally valid load. Titles and bodies are the
 * §7.3 normalized values from the revision payloads, so agents never receive
 * a different raw representation under the same revision. Tickets are sorted
 * by issue ID and each `blockedBy` list is sorted by issue ID, making the
 * snapshot independent of API display order.
 */
function buildSnapshot(load: RawTaskMapLoad): TaskMapSnapshot {
  const map = load.map
  const mapRef: MapRef = toStableRef('map', map.ref)

  const members = [...load.members].sort(compareMembersByIssueId)
  const memberRefsById = new Map<string, TicketRef>()
  for (const member of members) memberRefsById.set(member.ref.issueId, toStableRef('ticket', member.ref))

  const tickets: MapTicketSnapshot[] = members.map((member) => {
    const ref = memberRefsById.get(member.ref.issueId)!
    const revision = computeTicketRevision({
      githubHost: ref.githubHost,
      repositoryId: ref.repositoryId,
      ticketIssueId: ref.issueId,
      title: member.title,
      body: member.body,
    })
    const blockedBy = member.blockers
      .map((blocker) => memberRefsById.get(blocker.issueId)!)
      .sort((a, b) => compareUtf16CodeUnits(a.issueId, b.issueId))
    return {
      ref,
      title: revision.payload.title,
      body: revision.payload.body,
      state: member.state,
      blockedBy,
      ticketRevision: revision.revision,
    }
  })

  const dependencies = tickets.flatMap((ticket) =>
    ticket.blockedBy.map((blocker) => ({
      blockerIssueId: blocker.issueId,
      blockedIssueId: ticket.ref.issueId,
    })),
  )
  const mapRevision = computeMapRevision({
    githubHost: mapRef.githubHost,
    repositoryId: mapRef.repositoryId,
    mapIssueId: mapRef.issueId,
    title: map.title,
    body: map.body,
    members: tickets.map((ticket) => ({
      ticketIssueId: ticket.ref.issueId,
      ticketRevision: ticket.ticketRevision,
    })),
    dependencies,
  })

  return {
    ref: mapRef,
    title: mapRevision.payload.title,
    body: mapRevision.payload.body,
    state: map.state,
    mapRevision: mapRevision.revision,
    tickets,
  }
}

function toStableRef<Role extends 'map' | 'ticket'>(role: Role, ref: RawIssueRef): StableIssueRef<Role> {
  return {
    role,
    githubHost: normalizeIssueHost(ref.githubHost),
    repositoryId: ref.repositoryId,
    issueId: ref.issueId,
    number: ref.number,
    url: ref.url,
  }
}

/**
 * The stable-state key of a snapshot: the facts two adjacent loads must agree
 * on beyond the revision itself — the map revision, the map state, and every
 * member's state keyed by immutable issue ID (§7.3).
 */
export function snapshotStableState(snapshot: TaskMapSnapshot): CanonicalJsonValue {
  return {
    mapRevision: snapshot.mapRevision,
    mapState: snapshot.state,
    ticketStates: snapshot.tickets.map((ticket) => [ticket.ref.issueId, ticket.state]),
  }
}
