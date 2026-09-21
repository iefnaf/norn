/**
 * Ticket Revision and Map Revision computation (design.md §7.3).
 *
 * A revision is the content identity of a specification snapshot: SHA-256
 * over the UTF-8 bytes of the RFC 8785 canonical JSON encoding of the payload
 * below, written `sha256:<lowercase-hex>`. Issue state, issue number, URL,
 * owner/name, labels, comments, assignees, reactions, timestamps, completion
 * percentage, and relationship display order never enter either payload.
 *
 * Hashing is pure and unconditional: whether a snapshot satisfies the Task Map
 * topology rules of design.md §7.2 is a separate validation concern.
 */
import { compareUtf16CodeUnits } from './canonical-json.ts'
import { canonicalJsonDigest } from './digest.ts'
import type { Sha256Digest } from './digest.ts'
import { normalizeRevisionText } from './revision-text.ts'

export const TICKET_REVISION_SCHEMA = 'norn-ticket-revision:v1' as const
export const MAP_REVISION_SCHEMA = 'norn-map-revision:v1' as const

/** Logical payload hashed into a Ticket Revision (design.md §7.3). */
export type TicketRevisionPayload = {
  readonly schema: typeof TICKET_REVISION_SCHEMA
  readonly githubHost: string
  readonly repositoryId: string
  readonly ticketIssueId: string
  readonly title: string
  readonly body: string
}

/** One member of a Task Map, identified by immutable issue ID. */
export type MapRevisionMember = {
  readonly ticketIssueId: string
  readonly ticketRevision: string
}

/** One native dependency edge `blockerIssueId → blockedIssueId`. */
export type MapRevisionDependency = {
  readonly blockerIssueId: string
  readonly blockedIssueId: string
}

/** Logical payload hashed into a Map Revision (design.md §7.3). */
export type MapRevisionPayload = {
  readonly schema: typeof MAP_REVISION_SCHEMA
  readonly githubHost: string
  readonly repositoryId: string
  readonly mapIssueId: string
  readonly title: string
  readonly body: string
  readonly members: readonly MapRevisionMember[]
  readonly dependencies: readonly MapRevisionDependency[]
}

/** A computed revision together with the exact payload that produced it. */
export type TicketRevisionResult = {
  readonly revision: Sha256Digest
  readonly payload: TicketRevisionPayload
}

export type MapRevisionResult = {
  readonly revision: Sha256Digest
  readonly payload: MapRevisionPayload
}

/** Raw inputs of a Ticket Revision: stable identity plus unnormalized text. */
export type TicketRevisionInput = {
  readonly githubHost: string
  readonly repositoryId: string
  readonly ticketIssueId: string
  readonly title: string
  /** A `null` GitHub issue body is accepted and hashes as the empty string. */
  readonly body: string | null
}

/**
 * Compute one Ticket Revision. Title and body are normalized per design.md
 * §7.3 before hashing, and the returned payload carries those same normalized
 * values so agents never receive a different raw representation under the
 * same revision.
 */
export function computeTicketRevision(input: TicketRevisionInput): TicketRevisionResult {
  const payload: TicketRevisionPayload = {
    schema: TICKET_REVISION_SCHEMA,
    githubHost: input.githubHost,
    repositoryId: input.repositoryId,
    ticketIssueId: input.ticketIssueId,
    title: normalizeRevisionText(input.title),
    body: normalizeRevisionText(input.body),
  }
  return { revision: canonicalJsonDigest(payload), payload }
}

/** Raw inputs of a Map Revision: identity, unnormalized map text, and topology. */
export type MapRevisionInput = {
  readonly githubHost: string
  readonly repositoryId: string
  readonly mapIssueId: string
  readonly title: string
  /** A `null` GitHub issue body is accepted and hashes as the empty string. */
  readonly body: string | null
  /** Members may arrive in any display order; they hash in `ticketIssueId` order. */
  readonly members: readonly MapRevisionMember[]
  /** Dependencies may arrive in any API order; they hash in sorted edge order. */
  readonly dependencies: readonly MapRevisionDependency[]
}

function compareMembers(a: MapRevisionMember, b: MapRevisionMember): number {
  return compareUtf16CodeUnits(a.ticketIssueId, b.ticketIssueId)
}

function compareDependencies(a: MapRevisionDependency, b: MapRevisionDependency): number {
  return (
    compareUtf16CodeUnits(a.blockerIssueId, b.blockerIssueId) ||
    compareUtf16CodeUnits(a.blockedIssueId, b.blockedIssueId)
  )
}

/**
 * Compute one Map Revision. Map title and body are normalized per design.md
 * §7.3, members are sorted by `ticketIssueId`, and dependencies are sorted by
 * `blockerIssueId` and then `blockedIssueId`, so the revision is stable under
 * member, dependency, and display reordering while changing any map or member
 * specification, membership, or topology edge produces a new revision.
 */
export function computeMapRevision(input: MapRevisionInput): MapRevisionResult {
  const payload: MapRevisionPayload = {
    schema: MAP_REVISION_SCHEMA,
    githubHost: input.githubHost,
    repositoryId: input.repositoryId,
    mapIssueId: input.mapIssueId,
    title: normalizeRevisionText(input.title),
    body: normalizeRevisionText(input.body),
    members: [...input.members].sort(compareMembers),
    dependencies: [...input.dependencies].sort(compareDependencies),
  }
  return { revision: canonicalJsonDigest(payload), payload }
}
