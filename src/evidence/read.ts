/**
 * The issue-evidence read seam (design.md §14): one complete read of an
 * issue's comments and timeline for delivery-evidence validation.
 *
 * A reader must follow every comment and timeline pagination cursor before
 * answering — uniqueness and chronology decisions are made only over complete
 * reads. The built-in production adapter lives in
 * `src/adapters/github-gateway.ts`; tests inject deterministic fakes — no
 * network, no clock.
 */
import type { Outcome } from '../core/outcome.ts'

/** The locator slice a reader needs to address one issue. */
export type EvidenceIssueLocator = {
  readonly githubHost: string
  readonly number: number
  readonly url: string
}

/** One issue comment as evidence validation sees it. */
export type IssueEvidenceComment = {
  /** Immutable comment node ID. */
  readonly commentId: string
  /** Author's opaque node ID, or `null` when GitHub reports no author. */
  readonly authorId: string | null
  readonly body: string
}

/**
 * One timeline item. `commented` carries the comment node ID it introduced;
 * `closed` and `reopened` carry their event IDs and actors. Events arrive in
 * timeline order and every other item kind collapses into `other`.
 */
export type IssueTimelineEvent =
  | { readonly kind: 'commented'; readonly eventId: string; readonly commentId: string }
  | { readonly kind: 'closed'; readonly eventId: string; readonly actorId: string | null }
  | { readonly kind: 'reopened'; readonly eventId: string; readonly actorId: string | null }
  | { readonly kind: 'other'; readonly eventId: string }

/** One complete read: fully paginated comments plus fully paginated timeline. */
export type IssueEvidenceRead = {
  readonly comments: readonly IssueEvidenceComment[]
  readonly timeline: readonly IssueTimelineEvent[]
}

export type IssueEvidenceBlockCode =
  | 'repository-not-found'
  | 'issue-not-found'
  | 'github-unauthenticated'

export type IssueEvidenceErrorCode = 'github-unavailable'

export type IssueEvidenceReadOutcome = Outcome<
  IssueEvidenceRead,
  IssueEvidenceBlockCode,
  IssueEvidenceErrorCode
>

/** The injectable evidence-reading seam. Read-only: no shared writes. */
export type IssueEvidenceReader = {
  /**
   * Perform exactly one complete read of the addressed issue's comments and
   * timeline, following every pagination cursor, or fail with a typed
   * outcome.
   */
  loadIssueEvidence(
    locator: EvidenceIssueLocator,
  ): Promise<IssueEvidenceReadOutcome>
}
