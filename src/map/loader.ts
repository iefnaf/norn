/**
 * The Task Map loading seam (design.md §6, §7.2): one complete read of the
 * map issue graph as raw GitHub facts.
 *
 * A loader returns the candidate Map root together with its complete direct
 * sub-issue set and every member's native `blockedBy`, parent, and sub-issue
 * relationships, following every pagination cursor before answering. A
 * returned load is complete: callers never fetch more pages. The built-in
 * production adapter lives in `src/adapters/github-gateway.ts`; tests inject
 * deterministic fakes — no network, no clock.
 *
 * Membership, dependencies, and identity come exclusively from these native
 * relationships (§7.2): Markdown lists, tables, checkboxes, and prose never
 * define topology, so they never enter this shape.
 */
import type { Outcome } from '../core/outcome.ts'
import type { MapIssueLocator } from './issue-url.ts'

/** Raw issue identity as GitHub returns it: node IDs plus display locators. */
export type RawIssueRef = {
  /** Issue URL's host, already normalized per §7.3 by the adapter. */
  readonly githubHost: string
  /** Opaque GitHub repository node ID of the issue's repository. */
  readonly repositoryId: string
  /** Opaque GitHub issue node ID — the immutable identity (§7.2). */
  readonly issueId: string
  /** Display locator only; never identity (§7.2). */
  readonly number: number
  readonly url: string
}

export type RawIssueState = 'OPEN' | 'CLOSED'

/** The candidate Map root issue with its own native relationships. */
export type RawMapIssue = {
  readonly ref: RawIssueRef
  readonly title: string
  /** A `null` GitHub issue body is accepted and normalizes to `''` (§7.3). */
  readonly body: string | null
  readonly state: RawIssueState
  /** Every issue the map is a direct sub-issue of (§7.2 rule 2). */
  readonly parents: readonly RawIssueRef[]
  /** The map's own native blockers (§7.2 rule 3). */
  readonly blockers: readonly RawIssueRef[]
}

/** One direct member of the map with its complete native relationships. */
export type RawMemberIssue = {
  readonly ref: RawIssueRef
  readonly title: string
  readonly body: string | null
  readonly state: RawIssueState
  /** Every issue this member is a direct sub-issue of (§7.2 rule 6). */
  readonly parents: readonly RawIssueRef[]
  /** The member's complete direct sub-issue set (§7.2 rule 5). */
  readonly subIssues: readonly RawIssueRef[]
  /** The member's complete native blockedBy set (§7.2 rules 7–8). */
  readonly blockers: readonly RawIssueRef[]
}

/** One complete read of the map issue graph: the map plus its member set. */
export type RawTaskMapLoad = {
  readonly map: RawMapIssue
  /** The map's complete direct sub-issue set, in any display order (§7.2). */
  readonly members: readonly RawMemberIssue[]
}

export type TaskMapLoadBlockCode = 'repository-not-found' | 'issue-not-found' | 'github-unauthenticated'

export type TaskMapLoadErrorCode = 'github-unavailable'

export type TaskMapLoadOutcome = Outcome<RawTaskMapLoad, TaskMapLoadBlockCode, TaskMapLoadErrorCode>

/** The injectable map-loading seam. */
export type TaskMapLoader = {
  /**
   * Perform exactly one complete load of the map issue graph addressed by
   * `locator`, following every pagination cursor, or fail with a typed
   * outcome. Loader calls are read-only: no shared writes.
   */
  loadTaskMap(locator: MapIssueLocator): Promise<TaskMapLoadOutcome>
}
