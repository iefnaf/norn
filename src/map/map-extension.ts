/**
 * The Compatible Map Extension classifier (design.md §7.4).
 *
 * A pure function over two structurally valid snapshots — the latest accepted
 * snapshot and a current snapshot — that decides whether the current state is
 * an identical continuation, a monotonic Compatible Map Extension, or an
 * incompatible change. Issue states are dynamic facts and never affect the
 * classification; identity, title, body, membership, ticket revisions, and
 * complete blocker ID sets do.
 */
import { compareUtf16CodeUnits } from '../core/canonical-json.ts'
import { sameIssueIdentity } from './snapshot.ts'
import type { TaskMapSnapshot } from './snapshot.ts'

/** One typed reason an extension is incompatible. All reasons are reported. */
export type MapIncompatibilityReason =
  | { readonly code: 'map-identity-changed' }
  | { readonly code: 'map-specification-changed' }
  | { readonly code: 'member-removed'; readonly ticketIssueId: string }
  | { readonly code: 'ticket-revision-changed'; readonly ticketIssueId: string }
  | { readonly code: 'ticket-blockers-changed'; readonly ticketIssueId: string }

export type MapChangeClassification =
  | { readonly kind: 'identical' }
  | {
      readonly kind: 'compatible-extension'
      /** Added member issue IDs, sorted. A new revision lineage entry. */
      readonly addedTicketIssueIds: readonly string[]
    }
  | { readonly kind: 'incompatible'; readonly reasons: readonly MapIncompatibilityReason[] }

/**
 * Classify `current` against `accepted` per §7.4. Both inputs must be
 * structurally valid snapshots of the same map — rule 5 ("the current
 * complete snapshot still satisfies §7.2") holds by construction for
 * snapshots produced through `evaluateTaskMapLoad`; a current load that is
 * structurally invalid can never reach this classifier.
 *
 * Every §7.4 rule is checked independently and every violation is reported:
 *
 * 1. map identity, title, and body are unchanged;
 * 2. every previously accepted member is still a direct member;
 * 3. every previously accepted member has the same `ticketRevision`;
 * 4. every previously accepted member has exactly the same complete
 *    `blockedBy` ID set.
 *
 * Rules 1–4 holding while the map revision differs means the difference is
 * exactly a set of newly added member Tickets, which is the Compatible Map
 * Extension. Every added dependency edge therefore has a newly added Ticket
 * as its blocked endpoint; a new Ticket may depend on existing or other new
 * Tickets but can never become a new blocker of an existing one.
 */
export function classifyMapChange(
  accepted: TaskMapSnapshot,
  current: TaskMapSnapshot,
): MapChangeClassification {
  if (accepted.mapRevision === current.mapRevision) return { kind: 'identical' }

  const reasons: MapIncompatibilityReason[] = []
  if (!sameIssueIdentity(accepted.ref, current.ref)) {
    reasons.push({ code: 'map-identity-changed' })
  }
  if (accepted.title !== current.title || accepted.body !== current.body) {
    reasons.push({ code: 'map-specification-changed' })
  }

  const currentById = new Map(current.tickets.map((ticket) => [ticket.ref.issueId, ticket]))
  const acceptedIds = new Set(accepted.tickets.map((ticket) => ticket.ref.issueId))
  for (const ticket of accepted.tickets) {
    const issueId = ticket.ref.issueId
    const now = currentById.get(issueId)
    if (now === undefined) {
      reasons.push({ code: 'member-removed', ticketIssueId: issueId })
      continue
    }
    if (now.ticketRevision !== ticket.ticketRevision) {
      reasons.push({ code: 'ticket-revision-changed', ticketIssueId: issueId })
    }
    if (!sameBlockerIds(ticket.blockedBy, now.blockedBy)) {
      reasons.push({ code: 'ticket-blockers-changed', ticketIssueId: issueId })
    }
  }
  if (reasons.length > 0) return { kind: 'incompatible', reasons }

  const addedTicketIssueIds = current.tickets
    .map((ticket) => ticket.ref.issueId)
    .filter((issueId) => !acceptedIds.has(issueId))
    .sort(compareUtf16CodeUnits)
  if (addedTicketIssueIds.length === 0) {
    // Unreachable for honestly computed revisions — the payloads would be
    // identical and the revisions equal — but a zero-addition "extension"
    // must never be adopted.
    return { kind: 'incompatible', reasons: [{ code: 'map-specification-changed' }] }
  }
  return { kind: 'compatible-extension', addedTicketIssueIds }
}

/** Compare two blocker lists as complete ID sets (§7.4 rule 4). */
function sameBlockerIds(
  accepted: readonly { readonly issueId: string }[],
  current: readonly { readonly issueId: string }[],
): boolean {
  if (accepted.length !== current.length) return false
  const acceptedIds = new Set(accepted.map((ref) => ref.issueId))
  if (acceptedIds.size !== accepted.length) return false
  return current.every((ref) => acceptedIds.has(ref.issueId))
}
