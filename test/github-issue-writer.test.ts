/**
 * The GitHub issue-write adapter (design.md §11.3): the record comment
 * `POST` and the close/reopen `PATCH`es over the authenticated `gh` CLI,
 * with an injectable runner — no network, deterministic.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isError, isOk } from '../src/core/outcome.ts'
import { ghApiIssueWriter } from '../src/adapters/github-gateway.ts'
import type { GhCommandResult } from '../src/adapters/github-gateway.ts'

const LOCATOR = {
  githubHost: 'github.com',
  number: 7,
  url: 'https://github.com/acme/widget/issues/7',
}

const BODY = '<!-- norn:record -->\n```json\n{"schema":"norn-delivery:v1"}\n```\n'

function writerWith(result: (args: readonly string[]) => Promise<GhCommandResult>) {
  const seen: string[][] = []
  const run = async (args: readonly string[]): Promise<GhCommandResult> => {
    seen.push([...args])
    return result(args)
  }
  return { writer: ghApiIssueWriter(run), seen }
}

describe('ghApiIssueWriter.writeIssueComment', () => {
  it('posts the exact body bytes and returns the comment node ID', async () => {
    const { writer, seen } = writerWith(async () => ({
      ok: true,
      stdout: JSON.stringify({ id: 42, node_id: 'IC_comment1' }),
    }))
    const outcome = await writer.writeIssueComment(LOCATOR, BODY)
    assert.ok(isOk(outcome))
    if (outcome.kind === 'ok') assert.equal(outcome.value.commentId, 'IC_comment1')
    assert.deepEqual(seen[0]?.slice(0, 5), [
      'api',
      '--hostname',
      'github.com',
      '--method',
      'POST',
    ])
    assert.equal(seen[0]?.[5], 'repos/acme/widget/issues/7/comments')
    assert.equal(seen[0]?.[7], `body=${BODY}`)
  })

  it('fails as unavailable when the response lacks node_id', async () => {
    const { writer } = writerWith(async () => ({ ok: true, stdout: '{"id": 42}' }))
    const outcome = await writer.writeIssueComment(LOCATOR, BODY)
    assert.ok(isError(outcome))
    if (outcome.kind === 'error') assert.equal(outcome.code, 'github-unavailable')
  })

  it('fails as unavailable when gh itself fails', async () => {
    const { writer } = writerWith(async () => ({ ok: false, message: 'gh: HTTP 500' }))
    const outcome = await writer.writeIssueComment(LOCATOR, BODY)
    assert.ok(isError(outcome))
    if (outcome.kind === 'error') assert.equal(outcome.code, 'github-unavailable')
  })

  it('rejects a locator whose URL is not a full issue URL', async () => {
    const { writer, seen } = writerWith(async () => ({ ok: true, stdout: '{}' }))
    const outcome = await writer.writeIssueComment(
      { githubHost: 'github.com', number: 7, url: 'not-a-url' },
      BODY,
    )
    assert.ok(isError(outcome))
    assert.equal(seen.length, 0)
  })
})

describe('ghApiIssueWriter.closeIssue and reopenIssue', () => {
  it('PATCHes state=closed and confirms the response state', async () => {
    const { writer, seen } = writerWith(async () => ({
      ok: true,
      stdout: JSON.stringify({ number: 7, state: 'closed' }),
    }))
    const outcome = await writer.closeIssue(LOCATOR)
    assert.ok(isOk(outcome))
    assert.equal(seen[0]?.[3], '--method')
    assert.equal(seen[0]?.[4], 'PATCH')
    assert.equal(seen[0]?.[5], 'repos/acme/widget/issues/7')
    assert.equal(seen[0]?.[7], 'state=closed')
  })

  it('PATCHes state=open for reopen', async () => {
    const { writer, seen } = writerWith(async () => ({
      ok: true,
      stdout: JSON.stringify({ number: 7, state: 'open' }),
    }))
    const outcome = await writer.reopenIssue(LOCATOR)
    assert.ok(isOk(outcome))
    assert.equal(seen[0]?.[7], 'state=open')
  })

  it('fails as unavailable when the response state contradicts the request', async () => {
    const { writer } = writerWith(async () => ({
      ok: true,
      stdout: JSON.stringify({ number: 7, state: 'open' }),
    }))
    const outcome = await writer.closeIssue(LOCATOR)
    assert.ok(isError(outcome))
    if (outcome.kind === 'error') {
      assert.match(outcome.reason, /reports state "open"/)
    }
  })

  it('fails as unavailable when gh itself fails', async () => {
    const { writer } = writerWith(async () => ({ ok: false, message: 'network unreachable' }))
    const outcome = await writer.reopenIssue(LOCATOR)
    assert.ok(isError(outcome))
    if (outcome.kind === 'error') assert.equal(outcome.reason, 'network unreachable')
  })
})
