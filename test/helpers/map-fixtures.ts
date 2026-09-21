/**
 * Deterministic Task Map fixtures for map, stable-read, and check tests:
 * raw loads shaped exactly like the GitHub adapter's output. No network, no
 * clock — every value is inline data.
 */
import type {
  RawIssueRef,
  RawMapIssue,
  RawMemberIssue,
  RawTaskMapLoad,
} from '../../src/map/loader.ts'

export const HOST = 'github.com'
export const REPO = 'R_kgDOMAP'
export const OWNER = 'acme'
export const NAME = 'widget'

export const MAP_ISSUE_ID = 'I_map'
export const MAP_NUMBER = 6
export const MAP_URL = `https://${HOST}/${OWNER}/${NAME}/issues/${MAP_NUMBER}`

export const MAP_REF: RawIssueRef = {
  githubHost: HOST,
  repositoryId: REPO,
  issueId: MAP_ISSUE_ID,
  number: MAP_NUMBER,
  url: MAP_URL,
}

export function rawRef(
  issueId: string,
  number: number,
  overrides: Partial<RawIssueRef> = {},
): RawIssueRef {
  return {
    githubHost: HOST,
    repositoryId: REPO,
    issueId,
    number,
    url: `https://${HOST}/${OWNER}/${NAME}/issues/${number}`,
    ...overrides,
  }
}

export type MemberOverrides = Partial<Omit<RawMemberIssue, 'ref'>> & {
  ref?: Partial<RawIssueRef>
}

/**
 * One member with the §7.2-valid defaults: exactly the map as parent, no
 * sub-issues, no blockers, OPEN state.
 */
export function member(issueId: string, number: number, overrides: MemberOverrides = {}): RawMemberIssue {
  const { ref: refOverrides, ...rest } = overrides
  return {
    ref: rawRef(issueId, number, refOverrides),
    title: `Ticket ${issueId}`,
    body: `Body of ${issueId}`,
    state: 'OPEN',
    parents: [MAP_REF],
    subIssues: [],
    blockers: [],
    ...rest,
  }
}

export type MapOverrides = Partial<Omit<RawMapIssue, 'ref' | 'parents' | 'blockers'>> & {
  parents?: readonly RawIssueRef[]
  blockers?: readonly RawIssueRef[]
}

/** The map issue with §7.2-valid defaults: no parents, no blockers. */
export function mapIssue(overrides: MapOverrides = {}): RawMapIssue {
  return {
    ref: MAP_REF,
    title: 'Ship widget v2',
    body: 'Shared intent of the map.',
    state: 'OPEN',
    parents: [],
    blockers: [],
    ...overrides,
  }
}

/** One complete valid load of the given members (any display order). */
export function rawLoad(members: readonly RawMemberIssue[], mapOverrides: MapOverrides = {}): RawTaskMapLoad {
  return { map: mapIssue(mapOverrides), members: [...members] }
}

/** Members A (no blockers) and B (blocked by A): the canonical two-ticket map. */
export function memberA(): RawMemberIssue {
  return member('I_A', 1)
}

export function memberB(): RawMemberIssue {
  return member('I_B', 2, { blockers: [rawRef('I_A', 1)] })
}
