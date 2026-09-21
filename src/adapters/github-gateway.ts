/**
 * The GitHub gateway seam (design.md §6, §2.2): resolve stable GitHub
 * identities from local facts, and load complete Task Map issue graphs
 * (§7.2) with every pagination cursor followed.
 *
 * `/norn init` uses the identity half to turn a chosen remote into the stable
 * repository identity (node IDs, not owner/name) and to learn the
 * authenticated actor. `/norn check` and `run` use the map-loading half —
 * `ghApiTaskMapLoader` — to read the map issue, its complete direct
 * sub-issue set, and every member's native `blockedBy`, parent, and
 * sub-issue relationships.
 *
 * The built-in production adapters shell out to the `gh` CLI, inheriting the
 * operator's authenticated GitHub sessions. Tests inject a runner with canned
 * responses — no network, no clock.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { blocked, error, ok } from '../core/outcome.ts'
import type { Outcome } from '../core/outcome.ts'
import type {
  IssueEvidenceComment,
  IssueEvidenceRead,
  IssueEvidenceReadOutcome,
  IssueEvidenceReader,
  IssueTimelineEvent,
} from '../evidence/read.ts'
import type { MapIssueLocator } from '../map/issue-url.ts'
import { parseIssueUrl } from '../map/issue-url.ts'
import type {
  RawIssueRef,
  RawIssueState,
  RawMapIssue,
  RawMemberIssue,
  RawTaskMapLoad,
  TaskMapLoadBlockCode,
  TaskMapLoadErrorCode,
  TaskMapLoadOutcome,
  TaskMapLoader,
} from '../map/loader.ts'

const execFileAsync = promisify(execFile)

/** Wall-clock budget for one `gh` invocation. */
const GH_TIMEOUT_MS = 30_000

export type GitHubGatewayErrorCode = 'github-unavailable'

export type GitHubRepositoryBlockCode = 'repository-not-found' | 'github-unauthenticated'

export type GitHubActor = {
  /** Opaque GitHub node ID of the authenticated actor. */
  readonly id: string
  readonly login: string
}

/** Stable repository identity plus current human-readable name (§2.2). */
export type ResolvedGitHubRepository = {
  readonly githubHost: string
  readonly repositoryId: string
  readonly owner: string
  readonly name: string
  readonly defaultBranch: string
}

export type GitHubGatewayAdapter = {
  resolveRepository(ref: {
    readonly githubHost: string
    readonly owner: string
    readonly name: string
  }): Promise<Outcome<ResolvedGitHubRepository, GitHubRepositoryBlockCode, GitHubGatewayErrorCode>>
  authenticatedActor(
    githubHost: string,
  ): Promise<Outcome<GitHubActor, never, GitHubGatewayErrorCode>>
}

/** A single `gh api` invocation, injectable for deterministic tests. */
export type GhCommandResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly message: string }

export type GhCommandRunner = (args: readonly string[]) => Promise<GhCommandResult>

async function runGh(args: readonly string[]): Promise<GhCommandResult> {
  try {
    const { stdout } = await execFileAsync('gh', args, { timeout: GH_TIMEOUT_MS })
    return { ok: true, stdout }
  } catch (cause) {
    return { ok: false, message: describeGhFailure(cause) }
  }
}

function describeGhFailure(cause: unknown): string {
  if (cause !== null && typeof cause === 'object') {
    const candidate = cause as { code?: string; stderr?: string; message?: string }
    if (candidate.code === 'ENOENT') return 'the gh CLI is not installed or not on PATH'
    const stderr = typeof candidate.stderr === 'string' ? candidate.stderr : ''
    if (stderr !== '') return stderr.trim()
    if (typeof candidate.message === 'string') return candidate.message
  }
  return String(cause)
}

/**
 * Classify a failed `gh api` call from its stderr. `gh` reports missing
 * repositories as HTTP 404 and missing authentication with an explicit login
 * hint; both are trustworthy facts, while everything else means the facts
 * could not be established.
 */
function ghBlockCode(stderr: string): GitHubRepositoryBlockCode | undefined {
  if (/HTTP 40[04]/.test(stderr) || /not found/i.test(stderr)) return 'repository-not-found'
  if (/auth/i.test(stderr) && /login|token|credential/i.test(stderr)) {
    return 'github-unauthenticated'
  }
  return undefined
}

/** The built-in production adapter over the authenticated `gh` CLI. */
export function ghCliGateway(run: GhCommandRunner = runGh): GitHubGatewayAdapter {
  return {
    async resolveRepository(ref) {
      const result = await run([
        'api',
        '--hostname',
        ref.githubHost,
        `repos/${ref.owner}/${ref.name}`,
      ])
      if (!result.ok) {
        const blockCode = ghBlockCode(result.message)
        if (blockCode !== undefined) {
          return blocked({
            scope: 'operation',
            code: blockCode,
            reason: result.message,
            sharedWrite: 'none',
          })
        }
        return error({ scope: 'operation', code: 'github-unavailable', reason: result.message })
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(result.stdout)
      } catch {
        return error({
          scope: 'operation',
          code: 'github-unavailable',
          reason: 'gh api returned a non-JSON repository response',
        })
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return error({
          scope: 'operation',
          code: 'github-unavailable',
          reason: 'gh api returned an unexpected repository response shape',
        })
      }
      const repository = parsed as Record<string, unknown>
      const nodeOwner = repository.owner
      const repositoryId = repository.node_id
      const owner = typeof nodeOwner === 'object' && nodeOwner !== null
        ? (nodeOwner as Record<string, unknown>).login
        : undefined
      const name = repository.name
      const defaultBranch = repository.default_branch
      if (
        typeof repositoryId !== 'string' ||
        repositoryId === '' ||
        typeof owner !== 'string' ||
        owner === '' ||
        typeof name !== 'string' ||
        name === '' ||
        typeof defaultBranch !== 'string' ||
        defaultBranch === ''
      ) {
        return error({
          scope: 'operation',
          code: 'github-unavailable',
          reason: 'gh api repository response lacks the required identity fields',
        })
      }
      return ok({
        githubHost: ref.githubHost,
        repositoryId,
        owner,
        name,
        defaultBranch,
      })
    },

    async authenticatedActor(githubHost) {
      const result = await run(['api', '--hostname', githubHost, 'user'])
      if (!result.ok) {
        return error({ scope: 'operation', code: 'github-unavailable', reason: result.message })
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(result.stdout)
      } catch {
        return error({
          scope: 'operation',
          code: 'github-unavailable',
          reason: 'gh api returned a non-JSON user response',
        })
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return error({
          scope: 'operation',
          code: 'github-unavailable',
          reason: 'gh api returned an unexpected user response shape',
        })
      }
      const user = parsed as Record<string, unknown>
      if (typeof user.node_id !== 'string' || user.node_id === '' ||
          typeof user.login !== 'string' || user.login === '') {
        return error({
          scope: 'operation',
          code: 'github-unavailable',
          reason: 'gh api user response lacks node_id or login',
        })
      }
      return ok({ id: user.node_id, login: user.login })
    },
  }
}

// ---------------------------------------------------------------------------
// Task Map loading (design.md §7.2): one complete graph read per call.
// ---------------------------------------------------------------------------

/** Page size for every paginated connection. */
const MAP_PAGE_SIZE = 100

/**
 * The identity fields every connection node carries. `repository.id` makes
 * cross-repository members detectable without a second lookup.
 */
const REF_FIELDS = 'id number url repository { id }'

const MAP_CORE_QUERY = `
query NornMapCore($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    id
    issue(number: $number) {
      id number url title body state
      parent { ${REF_FIELDS} }
    }
  }
}`

const MAP_BLOCKED_BY_QUERY = `
query NornMapBlockedBy($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      blockedBy(first: ${MAP_PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${REF_FIELDS} }
      }
    }
  }
}`

const MAP_SUB_ISSUES_QUERY = `
query NornMapSubIssues($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      subIssues(first: ${MAP_PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${REF_FIELDS} }
      }
    }
  }
}`

const MEMBER_CORE_QUERY = `
query NornMemberCore($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    id
    issue(number: $number) {
      id number url title body state
      parent { ${REF_FIELDS} }
    }
  }
}`

const MEMBER_SUB_ISSUES_QUERY = `
query NornMemberSubIssues($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      subIssues(first: ${MAP_PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${REF_FIELDS} }
      }
    }
  }
}`

const MEMBER_BLOCKED_BY_QUERY = `
query NornMemberBlockedBy($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      blockedBy(first: ${MAP_PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${REF_FIELDS} }
      }
    }
  }
}`

type GraphQLVariables = Readonly<Record<string, string | number>>

type LoadStepOutcome<T> = Outcome<T, TaskMapLoadBlockCode, TaskMapLoadErrorCode>

/**
 * Classify one failed `gh api graphql` invocation. Resolution failures are
 * trustworthy facts about the addressed repository or issue; everything else
 * means the facts could not be established.
 */
function classifyGraphQLFailure(
  message: string,
): Outcome<never, TaskMapLoadBlockCode, TaskMapLoadErrorCode> {
  if (/could not resolve to an? issue/i.test(message)) {
    return blocked({
      scope: 'operation',
      code: 'issue-not-found',
      reason: message,
      sharedWrite: 'none',
    })
  }
  if (/could not resolve to an? repositor/i.test(message) || /HTTP 40[04]/.test(message)) {
    return blocked({
      scope: 'operation',
      code: 'repository-not-found',
      reason: message,
      sharedWrite: 'none',
    })
  }
  if (/auth/i.test(message) && /login|token|credential/i.test(message)) {
    return blocked({
      scope: 'operation',
      code: 'github-unauthenticated',
      reason: message,
      sharedWrite: 'none',
    })
  }
  return error({ scope: 'operation', code: 'github-unavailable', reason: message })
}

function unavailable(reason: string): Outcome<never, never, TaskMapLoadErrorCode> {
  return error({ scope: 'operation', code: 'github-unavailable', reason })
}

type GraphQLData = { readonly data?: unknown }

async function runGraphQL(
  run: GhCommandRunner,
  host: string,
  query: string,
  variables: GraphQLVariables,
): Promise<LoadStepOutcome<unknown>> {
  const args = ['api', '--hostname', host, 'graphql', '-f', `query=${query.trim()}`]
  for (const [name, value] of Object.entries(variables)) {
    if (typeof value === 'number') args.push('-F', `${name}=${String(value)}`)
    else args.push('-f', `${name}=${value}`)
  }
  const result = await run(args)
  if (!result.ok) return classifyGraphQLFailure(result.message.trim())
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return unavailable('gh api graphql returned a non-JSON response')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return unavailable('gh api graphql returned an unexpected response shape')
  }
  const envelope = parsed as { data?: unknown; errors?: unknown }
  if (envelope.errors !== undefined) {
    const message = describeGraphQLErrors(envelope.errors)
    const issueMissing = Array.isArray(envelope.errors) && envelope.errors.length > 0 &&
      envelope.errors.every((entry) => {
        if (typeof entry !== 'object' || entry === null) return false
        const path = (entry as { path?: unknown }).path
        return Array.isArray(path) && path[path.length - 1] === 'issue'
      })
    if (issueMissing) {
      return blocked({
        scope: 'operation',
        code: 'issue-not-found',
        reason: message,
        sharedWrite: 'none',
      })
    }
    return unavailable(`gh api graphql reported errors: ${message}`)
  }
  return ok(envelope.data)
}

function describeGraphQLErrors(errors: unknown): string {
  if (!Array.isArray(errors)) return String(errors)
  return errors
    .map((entry) => {
      if (typeof entry === 'object' && entry !== null && typeof (entry as { message?: unknown }).message === 'string') {
        return (entry as { message: string }).message
      }
      return String(entry)
    })
    .join('; ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The repository node of a response, classified as a block when absent. */
function repositoryNode(data: unknown): LoadStepOutcome<Record<string, unknown>> {
  if (!isRecord(data)) return unavailable('graphql data is not an object')
  const repository = data.repository
  if (repository === null) {
    return blocked({
      scope: 'operation',
      code: 'repository-not-found',
      reason: 'GitHub could not resolve the repository',
      sharedWrite: 'none',
    })
  }
  if (!isRecord(repository)) return unavailable('graphql repository node is malformed')
  return ok(repository)
}

/** The issue node under a repository node, classified as a block when absent. */
function issueNode(repository: Record<string, unknown>): LoadStepOutcome<Record<string, unknown>> {
  const issue = repository.issue
  if (issue === null) {
    return blocked({
      scope: 'operation',
      code: 'issue-not-found',
      reason: 'GitHub could not resolve the issue',
      sharedWrite: 'none',
    })
  }
  if (!isRecord(issue)) return unavailable('graphql issue node is malformed')
  return ok(issue)
}

function issueState(value: unknown): RawIssueState | undefined {
  return value === 'OPEN' || value === 'CLOSED' ? value : undefined
}

/** Validate one `{ id number url repository { id } }` node into a raw ref. */
function rawRef(host: string, node: unknown): RawIssueRef | undefined {
  if (!isRecord(node)) return undefined
  const repository = node.repository
  if (
    typeof node.id !== 'string' || node.id === '' ||
    typeof node.number !== 'number' || !Number.isInteger(node.number) ||
    typeof node.url !== 'string' || node.url === '' ||
    !isRecord(repository) || typeof repository.id !== 'string' || repository.id === ''
  ) {
    return undefined
  }
  return {
    githubHost: host,
    repositoryId: repository.id,
    issueId: node.id,
    number: node.number,
    url: node.url,
  }
}

type ConnectionPage = {
  readonly nodes: readonly unknown[]
  readonly hasNextPage: boolean
  readonly endCursor: string | null
}

/** Read one paginated connection off an issue node. */
function connectionOf(issue: Record<string, unknown>, field: 'subIssues' | 'blockedBy'): ConnectionPage | undefined {
  const connection = issue[field]
  if (!isRecord(connection)) return undefined
  const pageInfo = connection.pageInfo
  const nodes = connection.nodes
  if (!isRecord(pageInfo) || !Array.isArray(nodes)) return undefined
  const hasNextPage = pageInfo.hasNextPage === true
  const endCursor =
    typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null
  return { nodes, hasNextPage, endCursor }
}

/** The issue node reached by `data.repository.issue` for field `field`. */
function connectionIssue(data: unknown, field: 'subIssues' | 'blockedBy'):
  LoadStepOutcome<{ readonly issue: Record<string, unknown>; readonly field: 'subIssues' | 'blockedBy' }> {
  const repository = repositoryNode(data)
  if (repository.kind !== 'ok') return repository
  const issue = issueNode(repository.value)
  if (issue.kind !== 'ok') return issue
  if (connectionOf(issue.value, field) === undefined) {
    return unavailable(`graphql ${field} connection is malformed`)
  }
  return ok({ issue: issue.value, field })
}

/**
 * Collect every node of one paginated issue connection, following the
 * `endCursor` until `hasNextPage` is false. One GraphQL request per page.
 */
async function collectConnectionRefs(
  run: GhCommandRunner,
  host: string,
  query: string,
  variables: GraphQLVariables,
  field: 'subIssues' | 'blockedBy',
): Promise<LoadStepOutcome<readonly RawIssueRef[]>> {
  const refs: RawIssueRef[] = []
  let after: string | undefined
  for (;;) {
    const pageVariables: Record<string, string | number> = { ...variables }
    if (after !== undefined) pageVariables.after = after
    const outcome = await runGraphQL(run, host, query, pageVariables)
    if (outcome.kind !== 'ok') return outcome
    const reached = connectionIssue(outcome.value, field)
    if (reached.kind !== 'ok') return reached
    const page = connectionOf(reached.value.issue, field)!
    for (const node of page.nodes) {
      const ref = rawRef(host, node)
      if (ref === undefined) return unavailable(`graphql ${field} node is malformed`)
      refs.push(ref)
    }
    if (!page.hasNextPage || page.endCursor === null) return ok(refs)
    after = page.endCursor
  }
}

/** The `repository.id` + issue core fields of one issue. */
type IssueCore = {
  readonly ref: RawIssueRef
  readonly title: string
  readonly body: string | null
  readonly state: RawIssueState
  readonly parent: RawIssueRef | undefined
}

async function loadIssueCore(
  run: GhCommandRunner,
  host: string,
  query: string,
  variables: GraphQLVariables,
): Promise<LoadStepOutcome<IssueCore>> {
  const outcome = await runGraphQL(run, host, query, variables)
  if (outcome.kind !== 'ok') return outcome
  const repository = repositoryNode(outcome.value)
  if (repository.kind !== 'ok') return repository
  const issue = issueNode(repository.value)
  if (issue.kind !== 'ok') return issue
  const node = issue.value
  const state = issueState(node.state)
  const parentRef = node.parent === null ? undefined : rawRef(host, node.parent)
  if (
    typeof repository.value.id !== 'string' || repository.value.id === '' ||
    typeof node.id !== 'string' || node.id === '' ||
    typeof node.number !== 'number' || !Number.isInteger(node.number) ||
    typeof node.url !== 'string' || node.url === '' ||
    typeof node.title !== 'string' ||
    (node.body !== null && typeof node.body !== 'string') ||
    state === undefined ||
    (node.parent !== null && parentRef === undefined)
  ) {
    return unavailable('graphql issue node lacks the required fields')
  }
  return ok({
    ref: {
      githubHost: host,
      repositoryId: repository.value.id,
      issueId: node.id,
      number: node.number,
      url: node.url,
    },
    title: node.title,
    body: node.body,
    state,
    parent: parentRef,
  })
}

/**
 * The built-in production Task Map loader over the authenticated `gh` CLI.
 * Each call performs one complete graph read: the map issue core and parent,
 * the map's own blockers, its complete direct sub-issue set, and every
 * member's core, parent, sub-issues, and blockers — every connection followed
 * page by page until its cursor is exhausted (§7.2). Reads only.
 */
export function ghApiTaskMapLoader(run: GhCommandRunner = runGh): TaskMapLoader {
  return {
    async loadTaskMap(locator: MapIssueLocator): Promise<TaskMapLoadOutcome> {
      const host = locator.githubHost
      const base = { owner: locator.owner, name: locator.name, number: locator.number }

      const mapCore = await loadIssueCore(run, host, MAP_CORE_QUERY, base)
      if (mapCore.kind !== 'ok') return mapCore

      const mapBlockers = await collectConnectionRefs(
        run,
        host,
        MAP_BLOCKED_BY_QUERY,
        base,
        'blockedBy',
      )
      if (mapBlockers.kind !== 'ok') return mapBlockers

      const memberRefs = await collectConnectionRefs(
        run,
        host,
        MAP_SUB_ISSUES_QUERY,
        base,
        'subIssues',
      )
      if (memberRefs.kind !== 'ok') return memberRefs

      const members: RawMemberIssue[] = []
      for (const memberRef of memberRefs.value) {
        // The member URL carries its own repository locator: cross-repository
        // members are queried through their own owner/name, not the map's.
        const memberLocator = parseIssueUrl(memberRef.url)
        if (memberLocator === undefined) {
          return unavailable(`member issue URL "${memberRef.url}" is not a full GitHub issue URL`)
        }
        const memberBase = {
          owner: memberLocator.owner,
          name: memberLocator.name,
          number: memberLocator.number,
        }
        const core = await loadIssueCore(run, host, MEMBER_CORE_QUERY, memberBase)
        if (core.kind !== 'ok') return core
        const subIssues = await collectConnectionRefs(
          run,
          host,
          MEMBER_SUB_ISSUES_QUERY,
          memberBase,
          'subIssues',
        )
        if (subIssues.kind !== 'ok') return subIssues
        const blockers = await collectConnectionRefs(
          run,
          host,
          MEMBER_BLOCKED_BY_QUERY,
          memberBase,
          'blockedBy',
        )
        if (blockers.kind !== 'ok') return blockers
        members.push({
          ref: core.value.ref,
          title: core.value.title,
          body: core.value.body,
          state: core.value.state,
          parents: core.value.parent === undefined ? [] : [core.value.parent],
          subIssues: subIssues.value,
          blockers: blockers.value,
        })
      }

      const map: RawMapIssue = {
        ref: mapCore.value.ref,
        title: mapCore.value.title,
        body: mapCore.value.body,
        state: mapCore.value.state,
        parents: mapCore.value.parent === undefined ? [] : [mapCore.value.parent],
        blockers: mapBlockers.value,
      }
      return ok({ map, members })
    },
  }
}

// ---------------------------------------------------------------------------
// Issue evidence reads (design.md §14): complete comments plus timeline.
// ---------------------------------------------------------------------------

const ACTOR_ID_FIELDS = '... on User { id } ... on Bot { id } ... on Organization { id }'

const ISSUE_COMMENTS_QUERY = `
query NornIssueComments($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(first: ${MAP_PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id body author { ${ACTOR_ID_FIELDS} } }
      }
    }
  }
}`

const ISSUE_TIMELINE_QUERY = `
query NornIssueTimeline($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      timelineItems(first: ${MAP_PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on IssueComment { id }
          ... on ClosedEvent { id actor { ${ACTOR_ID_FIELDS} } }
          ... on ReopenedEvent { id actor { ${ACTOR_ID_FIELDS} } }
        }
      }
    }
  }
}`

/** The node ID of an `author`/`actor` selection, or `null` when absent. */
function actorNodeId(node: unknown): string | null {
  if (!isRecord(node)) return null
  return typeof node.id === 'string' && node.id !== '' ? node.id : null
}

/** One `{ id body author { id } }` comment node into an evidence comment. */
function evidenceComment(node: unknown): IssueEvidenceComment | undefined {
  if (!isRecord(node)) return undefined
  if (typeof node.id !== 'string' || node.id === '' || typeof node.body !== 'string') {
    return undefined
  }
  return { commentId: node.id, authorId: actorNodeId(node.author), body: node.body }
}

/** One timeline node into the evidence event vocabulary. */
function evidenceTimelineEvent(node: unknown): IssueTimelineEvent | undefined {
  if (!isRecord(node)) return undefined
  const eventId = typeof node.id === 'string' ? node.id : ''
  switch (node.__typename) {
    case 'IssueComment':
      return typeof node.id === 'string' && node.id !== ''
        ? { kind: 'commented', eventId: node.id, commentId: node.id }
        : undefined
    case 'ClosedEvent':
      return { kind: 'closed', eventId, actorId: actorNodeId(node.actor) }
    case 'ReopenedEvent':
      return { kind: 'reopened', eventId, actorId: actorNodeId(node.actor) }
    default:
      return { kind: 'other', eventId }
  }
}

type EvidenceLoadStep<T> = Outcome<T, 'repository-not-found' | 'issue-not-found' | 'github-unauthenticated', 'github-unavailable'>

/**
 * Collect every node of the issue's `comments` or `timelineItems`
 * connection, following the `endCursor` until `hasNextPage` is false. One
 * GraphQL request per page; uniqueness and chronology are decided by the
 * caller only over the complete result (§14).
 */
async function collectEvidenceNodes(
  run: GhCommandRunner,
  host: string,
  query: string,
  base: { owner: string; name: string; number: number },
  field: 'comments' | 'timelineItems',
): Promise<EvidenceLoadStep<readonly unknown[]>> {
  const nodes: unknown[] = []
  let after: string | undefined
  for (;;) {
    const variables: Record<string, string | number> = { ...base }
    if (after !== undefined) variables.after = after
    const outcome = await runGraphQL(run, host, query, variables)
    if (outcome.kind !== 'ok') return outcome
    const repository = repositoryNode(outcome.value)
    if (repository.kind !== 'ok') return repository
    const issue = issueNode(repository.value)
    if (issue.kind !== 'ok') return issue
    const connection = issue.value[field]
    if (!isRecord(connection) || !isRecord(connection.pageInfo) || !Array.isArray(connection.nodes)) {
      return unavailable(`graphql ${field} connection is malformed`)
    }
    nodes.push(...connection.nodes)
    const hasNextPage = connection.pageInfo.hasNextPage === true
    const endCursor = typeof connection.pageInfo.endCursor === 'string' ? connection.pageInfo.endCursor : null
    if (!hasNextPage || endCursor === null) return ok(nodes)
    after = endCursor
  }
}

/**
 * The built-in production evidence reader over the authenticated `gh` CLI:
 * one complete comments read plus one complete timeline read per call, every
 * pagination cursor followed. Reads only — no shared writes.
 */
export function ghApiEvidenceReader(run: GhCommandRunner = runGh): IssueEvidenceReader {
  return {
    async loadIssueEvidence(locator): Promise<IssueEvidenceReadOutcome> {
      const url = parseIssueUrl(locator.url)
      if (url === undefined || url.number !== locator.number) {
        return unavailable(`issue URL "${locator.url}" is not a full GitHub issue URL`)
      }
      const base = { owner: url.owner, name: url.name, number: url.number }

      const commentNodes = await collectEvidenceNodes(
        run,
        locator.githubHost,
        ISSUE_COMMENTS_QUERY,
        base,
        'comments',
      )
      if (commentNodes.kind !== 'ok') return commentNodes
      const comments: IssueEvidenceComment[] = []
      for (const node of commentNodes.value) {
        const comment = evidenceComment(node)
        if (comment === undefined) return unavailable('graphql comment node is malformed')
        comments.push(comment)
      }

      const timelineNodes = await collectEvidenceNodes(
        run,
        locator.githubHost,
        ISSUE_TIMELINE_QUERY,
        base,
        'timelineItems',
      )
      if (timelineNodes.kind !== 'ok') return timelineNodes
      const timeline: IssueTimelineEvent[] = []
      for (const node of timelineNodes.value) {
        const event = evidenceTimelineEvent(node)
        if (event === undefined) return unavailable('graphql timeline node is malformed')
        timeline.push(event)
      }

      return ok({ comments, timeline })
    },
  }
}
