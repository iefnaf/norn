import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isBlocked, isError, isOk } from '../src/core/outcome.ts'
import { ghApiTaskMapLoader } from '../src/adapters/github-gateway.ts'
import type { GhCommandResult } from '../src/adapters/github-gateway.ts'
import { HOST, MAP_NUMBER, MAP_URL, REPO } from './helpers/map-fixtures.ts'

const OWNER = 'acme'
const NAME = 'widget'
const LOCATOR = { githubHost: HOST, owner: OWNER, name: NAME, number: MAP_NUMBER }

type Variables = Record<string, string | number>

type RecordedCall = { readonly operation: string; readonly variables: Variables }

/**
 * A scripted `gh` runner: every GraphQL operation name routes to a handler
 * that answers from the recorded variables. Every call is captured.
 */
function fakeGh(
  handlers: Readonly<Record<string, (variables: Variables) => GhCommandResult>>,
): { run: Parameters<typeof ghApiTaskMapLoader>[0]; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const run = async (args: readonly string[]): Promise<GhCommandResult> => {
    assert.equal(args[0], 'api')
    assert.equal(args[1], '--hostname')
    assert.equal(args[2], HOST)
    assert.equal(args[3], 'graphql')
    const variables: Variables = {}
    let operation = ''
    for (let i = 4; i < args.length; i += 2) {
      assert.ok(args[i] === '-f' || args[i] === '-F', `unexpected flag ${args[i]}`)
      const [name, ...rest] = (args[i + 1] ?? '').split('=')
      const value = rest.join('=')
      if (name === 'query') {
        const match = /query\s+(\w+)/.exec(value)
        operation = match?.[1] ?? ''
      } else if (name !== undefined) {
        // `-F` fields are typed like gh types them: integers become numbers.
        variables[name] = args[i] === '-F' && /^\d+$/.test(value) ? Number(value) : value
      }
    }
    calls.push({ operation, variables })
    const handler = handlers[operation]
    if (handler === undefined) throw new Error(`no handler for GraphQL operation "${operation}"`)
    return handler(variables)
  }
  return { run, calls }
}

function gql(data: unknown, errors?: unknown[]): GhCommandResult {
  return { ok: true, stdout: JSON.stringify(errors === undefined ? { data } : { data, errors }) }
}

const issueNode = (issue: {
  id: string
  number: number
  title: string
  body: string | null
  state?: 'OPEN' | 'CLOSED'
  parent?: unknown
  url?: string
  repositoryId?: string
}) => ({
  id: issue.id,
  number: issue.number,
  url: issue.url ?? `https://${HOST}/${OWNER}/${NAME}/issues/${issue.number}`,
  title: issue.title,
  body: issue.body,
  state: issue.state ?? 'OPEN',
  parent: issue.parent ?? null,
})

const mapParentNode = {
  id: 'I_map',
  number: MAP_NUMBER,
  url: MAP_URL,
  repository: { id: REPO },
}

const refNode = (id: string, number: number, repositoryId = REPO) => ({
  id,
  number,
  url: `https://${HOST}/${OWNER}/${NAME}/issues/${number}`,
  repository: { id: repositoryId },
})

const emptyPage = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
const page = (nodes: readonly unknown[], endCursor: string | null = null) => ({
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
  nodes,
})

const MAP_CORE = {
  repository: {
    id: REPO,
    issue: issueNode({ id: 'I_map', number: MAP_NUMBER, title: 'Ship widget v2', body: 'Map body.' }),
  },
}

function memberCore(id: string, number: number, title: string) {
  return {
    repository: {
      id: REPO,
      issue: issueNode({ id, number, title, body: `Body of ${id}.`, parent: mapParentNode }),
    },
  }
}

/** The happy-path map: member A (#1) and member B (#2), blocked by A. */
function happyHandlers(options: {
  subIssuePages?: readonly { nodes: readonly unknown[]; endCursor: string | null }[]
  bBlockedByPages?: readonly { nodes: readonly unknown[]; endCursor: string | null }[]
  memberSubIssues?: readonly unknown[]
} = {}) {
  const subIssuePages = options.subIssuePages ?? [
    { nodes: [refNode('I_A', 1)], endCursor: 'sub-cursor-1' },
    { nodes: [refNode('I_B', 2)], endCursor: null },
  ]
  const bBlockedByPages = options.bBlockedByPages ?? [
    { nodes: [refNode('I_A', 1)], endCursor: null },
  ]
  let subIssuePage = 0
  let bBlockedByPage = 0
  return {
    NornMapCore: () => gql(MAP_CORE),
    NornMapBlockedBy: () => gql({ repository: { issue: { blockedBy: emptyPage } } }),
    NornMapSubIssues: () => {
      const current = subIssuePages[subIssuePage++]!
      return gql({
        repository: { issue: { subIssues: page(current.nodes, current.endCursor) } },
      })
    },
    NornMemberCore: (variables: Variables) => {
      if (variables.number === 1) return gql(memberCore('I_A', 1, 'Ticket A'))
      if (variables.number === 2) return gql(memberCore('I_B', 2, 'Ticket B'))
      throw new Error(`unexpected member number ${String(variables.number)}`)
    },
    NornMemberSubIssues: () =>
      gql({
        repository: {
          issue: {
            subIssues: options.memberSubIssues
              ? page(options.memberSubIssues, null)
              : emptyPage,
          },
        },
      }),
    NornMemberBlockedBy: (variables: Variables) => {
      if (variables.number !== 2) return gql({ repository: { issue: { blockedBy: emptyPage } } })
      const current = bBlockedByPages[bBlockedByPage++]!
      return gql({
        repository: { issue: { blockedBy: page(current.nodes, current.endCursor) } },
      })
    },
  }
}

describe('ghApiTaskMapLoader — one complete load, every cursor followed', () => {
  it('loads the map, both members, and the dependency across paginated pages', async () => {
    const bBlockedByPages = [
      { nodes: [refNode('I_A', 1)], endCursor: 'dep-cursor-1' },
      { nodes: [refNode('I_A2', 12)], endCursor: null },
    ]
    const { run, calls } = fakeGh(happyHandlers({ bBlockedByPages }))
    const outcome = await ghApiTaskMapLoader(run).loadTaskMap(LOCATOR)
    assert.ok(isOk(outcome))
    if (outcome.kind !== 'ok') return

    assert.deepEqual(outcome.value.map, {
      ref: {
        githubHost: HOST,
        repositoryId: REPO,
        issueId: 'I_map',
        number: MAP_NUMBER,
        url: MAP_URL,
      },
      title: 'Ship widget v2',
      body: 'Map body.',
      state: 'OPEN',
      parents: [],
      blockers: [],
    })
    assert.deepEqual(
      outcome.value.members.map((entry) => entry.ref.issueId),
      ['I_A', 'I_B'],
    )
    const a = outcome.value.members[0]!
    const b = outcome.value.members[1]!
    assert.deepEqual(a.parents.map((parent) => parent.issueId), ['I_map'])
    assert.deepEqual(a.blockers, [])
    assert.deepEqual(
      b.blockers.map((blocker) => blocker.issueId),
      ['I_A', 'I_A2'],
    )
    assert.equal(b.title, 'Ticket B')

    // Sub-issue pagination passed the cursor from page one to page two.
    const subIssueCalls = calls.filter((call) => call.operation === 'NornMapSubIssues')
    assert.equal(subIssueCalls.length, 2)
    assert.equal(subIssueCalls[0]?.variables.after, undefined)
    assert.equal(subIssueCalls[1]?.variables.after, 'sub-cursor-1')
    // Member blockedBy pagination likewise.
    const blockedByCalls = calls.filter(
      (call) => call.operation === 'NornMemberBlockedBy' && call.variables.number === 2,
    )
    assert.equal(blockedByCalls.length, 2)
    assert.equal(blockedByByAfter(blockedByCalls), 'dep-cursor-1')
  })

  it('collects the map issue own parent and blockers', async () => {
    const handlers = {
      ...happyHandlers(),
      NornMapCore: () =>
        gql({
          repository: {
            id: REPO,
            issue: issueNode({
              id: 'I_map',
              number: MAP_NUMBER,
              title: 'Ship widget v2',
              body: null,
              parent: { id: 'I_grandparent', number: 30, url: `https://${HOST}/${OWNER}/${NAME}/issues/30`, repository: { id: REPO } },
            }),
          },
        }),
      NornMapBlockedBy: () =>
        gql({ repository: { issue: { blockedBy: page([refNode('I_mapblocker', 31)], null) } } }),
    }
    const { run } = fakeGh(handlers)
    const outcome = await ghApiTaskMapLoader(run).loadTaskMap(LOCATOR)
    assert.ok(isOk(outcome))
    if (outcome.kind === 'ok') {
      assert.deepEqual(outcome.value.map.parents.map((p) => p.issueId), ['I_grandparent'])
      assert.deepEqual(outcome.value.map.blockers.map((b) => b.issueId), ['I_mapblocker'])
      assert.equal(outcome.value.map.body, null)
    }
  })

  it('collects a nested member sub-issue page for flatness validation', async () => {
    const child = refNode('I_child', 10)
    const { run } = fakeGh(happyHandlers({ memberSubIssues: [child] }))
    const outcome = await ghApiTaskMapLoader(run).loadTaskMap(LOCATOR)
    assert.ok(isOk(outcome))
    if (outcome.kind === 'ok') {
      assert.deepEqual(
        outcome.value.members[0]?.subIssues.map((sub) => sub.issueId),
        ['I_child'],
      )
    }
  })

  it('queries a cross-repository member through its own owner/name from its URL', async () => {
    const crossRepoNode = {
      id: 'I_cross',
      number: 9,
      url: `https://${HOST}/${OWNER}/other/issues/9`,
      repository: { id: 'R_kgDOOTHER' },
    }
    const handlers = {
      ...happyHandlers(),
      NornMapSubIssues: () => gql({ repository: { issue: { subIssues: page([crossRepoNode], null) } } }),
      NornMemberCore: (variables: Variables) => {
        assert.equal(variables.owner, OWNER)
        assert.equal(variables.name, 'other')
        return gql({
          repository: {
            id: 'R_kgDOOTHER',
            issue: issueNode({
              id: 'I_cross',
              number: 9,
              title: 'Cross',
              body: null,
              parent: { ...mapParentNode, repository: { id: 'R_kgDOOTHER' } },
              url: `https://${HOST}/${OWNER}/other/issues/9`,
            }),
          },
        })
      },
    }
    const { run, calls } = fakeGh(handlers)
    const outcome = await ghApiTaskMapLoader(run).loadTaskMap(LOCATOR)
    assert.ok(isOk(outcome))
    if (outcome.kind === 'ok') {
      assert.equal(outcome.value.members[0]?.ref.repositoryId, 'R_kgDOOTHER')
      assert.equal(outcome.value.members[0]?.ref.url, `https://${HOST}/${OWNER}/other/issues/9`)
    }
    const memberCore = calls.find((call) => call.operation === 'NornMemberCore')
    assert.equal(memberCore?.variables.name, 'other')
  })
})

describe('ghApiTaskMapLoader — trustworthy blocks and errors', () => {
  it('classifies a GraphQL NOT_FOUND on the issue path as issue-not-found', async () => {
    const handlers = {
      ...happyHandlers(),
      NornMapCore: () =>
        gql({ repository: { issue: null } }, [
          { type: 'NOT_FOUND', path: ['repository', 'issue'], message: 'Could not resolve to an Issue with the number of 6.' },
        ]),
    }
    const { run } = fakeGh(handlers)
    const outcome = await ghApiTaskMapLoader(run).loadTaskMap(LOCATOR)
    assert.ok(isBlocked(outcome))
    if (outcome.kind === 'blocked') assert.equal(outcome.code, 'issue-not-found')
  })

  it('classifies the gh failure message for a missing issue as issue-not-found', async () => {
    const { run } = fakeGh({
      NornMapCore: () => ({ ok: false, message: 'gh: Could not resolve to an Issue with the number of 6.' }),
    })
    const outcome = await ghApiTaskMapLoader(run).loadTaskMap(LOCATOR)
    assert.ok(isBlocked(outcome))
    if (outcome.kind === 'blocked') assert.equal(outcome.code, 'issue-not-found')
  })

  it('classifies a null repository node as repository-not-found', async () => {
    const { run } = fakeGh({
      NornMapCore: () => gql({ repository: null }),
    })
    const outcome = await ghApiTaskMapLoader(run).loadTaskMap(LOCATOR)
    assert.ok(isBlocked(outcome))
    if (outcome.kind === 'blocked') assert.equal(outcome.code, 'repository-not-found')
  })

  it('classifies the gh failure message for a missing repository as repository-not-found', async () => {
    const { run } = fakeGh({
      NornMapCore: () => ({ ok: false, message: 'gh: Could not resolve to a repository with the owner/acme' }),
    })
    const outcome = await ghApiTaskMapLoader(run).loadTaskMap(LOCATOR)
    assert.ok(isBlocked(outcome))
    if (outcome.kind === 'blocked') assert.equal(outcome.code, 'repository-not-found')
  })

  it('classifies missing authentication as a block requiring operator action', async () => {
    const { run } = fakeGh({
      NornMapCore: () => ({ ok: false, message: 'gh: To get started with GitHub CLI, please run: gh auth login' }),
    })
    const outcome = await ghApiTaskMapLoader(run).loadTaskMap(LOCATOR)
    assert.ok(isBlocked(outcome))
    if (outcome.kind === 'blocked') assert.equal(outcome.code, 'github-unauthenticated')
  })

  it('surfaces every other failure as a github-unavailable error', async () => {
    const { run } = fakeGh({
      NornMapCore: () => ({ ok: false, message: 'dial tcp: i/o timeout' }),
    })
    const outcome = await ghApiTaskMapLoader(run).loadTaskMap(LOCATOR)
    assert.ok(isError(outcome))
    if (outcome.kind === 'error') assert.equal(outcome.code, 'github-unavailable')
  })

  it('errors on a sub-issue node missing its repository identity', async () => {
    const brokenNode = { id: 'I_A', number: 1, url: `https://${HOST}/${OWNER}/${NAME}/issues/1` }
    const { run } = fakeGh({
      ...happyHandlers(),
      NornMapSubIssues: () => gql({ repository: { issue: { subIssues: page([brokenNode], null) } } }),
    })
    const outcome = await ghApiTaskMapLoader(run).loadTaskMap(LOCATOR)
    assert.ok(isError(outcome))
  })

  it('errors on a non-JSON response', async () => {
    const { run } = fakeGh({
      NornMapCore: () => ({ ok: true, stdout: '<html>gateway error</html>' }),
    })
    const outcome = await ghApiTaskMapLoader(run).loadTaskMap(LOCATOR)
    assert.ok(isError(outcome))
  })
})

function blockedByByAfter(calls: readonly RecordedCall[]): string | undefined {
  const withAfter = calls.filter((call) => call.variables.after !== undefined)
  return withAfter[0]?.variables.after as string | undefined
}
