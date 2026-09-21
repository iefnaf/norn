import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isBlocked, isError, isOk } from '../src/core/outcome.ts'
import { ghApiEvidenceReader } from '../src/adapters/github-gateway.ts'
import type { GhCommandResult } from '../src/adapters/github-gateway.ts'

const HOST = 'github.com'
const ISSUE_URL = 'https://github.com/acme/widget/issues/7'

function commentsPage(nodes: unknown[], hasNextPage = false, endCursor: string | null = null): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          comments: {
            pageInfo: { hasNextPage, endCursor },
            nodes,
          },
        },
      },
    },
  })
}

function timelinePage(nodes: unknown[], hasNextPage = false, endCursor: string | null = null): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage, endCursor },
            nodes,
          },
        },
      },
    },
  })
}

const COMMENT_NODE = (id: string, author: string | null = 'I_actor') => ({
  id,
  body: `body of ${id}`,
  author: author === null ? null : { id: author },
})

describe('ghApiEvidenceReader with an injected runner', () => {
  it('reads comments and timeline in one call, mapping events and authors', async () => {
    const calls: string[] = []
    const reader = ghApiEvidenceReader(async (args) => {
      calls.push(args.join(' '))
      const query = args.find((part) => part.startsWith('query=')) ?? ''
      if (query.includes('NornIssueComments')) {
        return {
          ok: true as const,
          stdout: commentsPage([COMMENT_NODE('C1'), COMMENT_NODE('C2', null)]),
        }
      }
      return {
        ok: true as const,
        stdout: timelinePage([
          { __typename: 'IssueComment', id: 'C1' },
          { __typename: 'ClosedEvent', id: 'E_close', actor: { id: 'I_actor' } },
          { __typename: 'ReopenedEvent', id: 'E_re', actor: null },
          { __typename: 'AssignedEvent', id: 'E_other' },
        ]),
      }
    })
    const outcome = await reader.loadIssueEvidence({ githubHost: HOST, number: 7, url: ISSUE_URL })
    assert.ok(isOk(outcome))
    if (outcome.kind === 'ok') {
      assert.deepEqual(outcome.value.comments, [
        { commentId: 'C1', authorId: 'I_actor', body: 'body of C1' },
        { commentId: 'C2', authorId: null, body: 'body of C2' },
      ])
      assert.deepEqual(outcome.value.timeline, [
        { kind: 'commented', eventId: 'C1', commentId: 'C1' },
        { kind: 'closed', eventId: 'E_close', actorId: 'I_actor' },
        { kind: 'reopened', eventId: 'E_re', actorId: null },
        { kind: 'other', eventId: 'E_other' },
      ])
    }
    assert.equal(calls.length, 2)
    assert.match(calls[0]!, /NornIssueComments/)
    assert.match(calls[1]!, /NornIssueTimeline/)
  })

  it('follows every comments and timeline pagination cursor before answering', async () => {
    const seenCursors: string[] = []
    const reader = ghApiEvidenceReader(async (args) => {
      const flattened = args.join('\u0000')
      const query = args.find((part) => part.startsWith('query=')) ?? ''
      if (query.includes('NornIssueComments')) {
        if (!flattened.includes('after=')) {
          return { ok: true as const, stdout: commentsPage([COMMENT_NODE('C1')], true, 'cursor-1') }
        }
        seenCursors.push(flattened.split('after=\u0000')[1] ?? '')
        return { ok: true as const, stdout: commentsPage([COMMENT_NODE('C2')]) }
      }
      if (!flattened.includes('after=')) {
        return { ok: true as const, stdout: timelinePage([{ __typename: 'IssueComment', id: 'C1' }], true, 'cursor-t1') }
      }
      seenCursors.push(flattened.split('after=\u0000')[1] ?? '')
      return { ok: true as const, stdout: timelinePage([{ __typename: 'ClosedEvent', id: 'E_close', actor: { id: 'I_actor' } }]) }
    })
    const outcome = await reader.loadIssueEvidence({ githubHost: HOST, number: 7, url: ISSUE_URL })
    assert.ok(isOk(outcome))
    if (outcome.kind === 'ok') {
      assert.equal(outcome.value.comments.length, 2)
      assert.equal(outcome.value.timeline.length, 2)
    }
    assert.equal(seenCursors.length, 2) // one page-2 request per connection
  })

  it('classifies trustworthy resolution failures as blocks', async () => {
    const reader = ghApiEvidenceReader(async () => ({
      ok: false as const,
      message: 'gh: Could not resolve to an Issue with the number of 7.',
    }))
    const outcome = await reader.loadIssueEvidence({ githubHost: HOST, number: 7, url: ISSUE_URL })
    assert.ok(isBlocked(outcome))
    if (outcome.kind === 'blocked') assert.equal(outcome.code, 'issue-not-found')
  })

  it('surfaces infrastructure failures as errors', async () => {
    const reader = ghApiEvidenceReader(async () => ({ ok: false as const, message: 'dial tcp: timeout' }))
    const outcome = await reader.loadIssueEvidence({ githubHost: HOST, number: 7, url: ISSUE_URL })
    assert.ok(isError(outcome))
    if (outcome.kind === 'error') assert.equal(outcome.code, 'github-unavailable')
  })

  it('rejects an issue URL that is not a full GitHub issue URL', async () => {
    const reader = ghApiEvidenceReader(async () => {
      throw new Error('must not be reached')
    })
    const outcome = await reader.loadIssueEvidence({ githubHost: HOST, number: 7, url: '#7' })
    assert.ok(isError(outcome))
    if (outcome.kind === 'error') assert.match(outcome.reason, /not a full GitHub issue URL/)
  })

  it('rejects malformed connection nodes as errors', async () => {
    const reader = ghApiEvidenceReader(async (args) => {
      const query = args.find((part) => part.startsWith('query=')) ?? ''
      if (query.includes('NornIssueComments')) {
        return { ok: true as const, stdout: commentsPage([{ id: 'C1' /* body missing */ }]) }
      }
      return { ok: true as const, stdout: timelinePage([]) }
    })
    const outcome = await reader.loadIssueEvidence({ githubHost: HOST, number: 7, url: ISSUE_URL })
    assert.ok(isError(outcome))
  })
})
