import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isBlocked, isError, isOk } from '../src/core/outcome.ts'
import { ghCliGateway } from '../src/adapters/github-gateway.ts'
import type { GhCommandResult } from '../src/adapters/github-gateway.ts'

const REPOSITORY_RESPONSE = JSON.stringify({
  node_id: 'R_kgDOLnorn',
  name: 'norn',
  owner: { login: 'iefnaf' },
  default_branch: 'main',
})

const USER_RESPONSE = JSON.stringify({ node_id: 'MDQ6VXNlcjIxMzY3', login: 'operator' })

function gatewayWith(result: (args: readonly string[]) => Promise<GhCommandResult>) {
  return ghCliGateway(async (args) => result(args))
}

describe('ghCliGateway.resolveRepository with an injected runner', () => {
  it('resolves the stable repository identity from gh api repos/{owner}/{repo}', async () => {
    const gateway = gatewayWith(async () => ({ ok: true, stdout: REPOSITORY_RESPONSE }))
    const outcome = await gateway.resolveRepository({
      githubHost: 'github.com',
      owner: 'iefnaf',
      name: 'norn',
    })
    assert.ok(isOk(outcome))
    if (outcome.kind === 'ok') {
      assert.deepEqual(outcome.value, {
        githubHost: 'github.com',
        repositoryId: 'R_kgDOLnorn',
        owner: 'iefnaf',
        name: 'norn',
        defaultBranch: 'main',
      })
    }
  })

  it('queries the configured host', async () => {
    const seen: string[][] = []
    const gateway = gatewayWith(async (args) => {
      seen.push([...args])
      return { ok: true, stdout: REPOSITORY_RESPONSE }
    })
    await gateway.resolveRepository({ githubHost: 'ghe.example.com', owner: 'o', name: 'r' })
    assert.deepEqual(seen[0]?.slice(0, 3), ['api', '--hostname', 'ghe.example.com'])
    assert.match(seen[0]?.[3] ?? '', /^repos\/o\/r$/)
  })

  it('keeps the current human-readable identity from the response', async () => {
    const renamed = JSON.stringify({
      node_id: 'R_kgDOLnorn',
      name: 'norn-renamed',
      owner: { login: 'iefnaf-renamed' },
      default_branch: 'trunk',
    })
    const gateway = gatewayWith(async () => ({ ok: true, stdout: renamed }))
    const outcome = await gateway.resolveRepository({
      githubHost: 'github.com',
      owner: 'old-owner',
      name: 'old-name',
    })
    if (outcome.kind === 'ok') {
      assert.equal(outcome.value.repositoryId, 'R_kgDOLnorn')
      assert.equal(outcome.value.owner, 'iefnaf-renamed')
      assert.equal(outcome.value.name, 'norn-renamed')
      assert.equal(outcome.value.defaultBranch, 'trunk')
    }
  })

  it('classifies HTTP 404 as a trustworthy repository-not-found block', async () => {
    const gateway = gatewayWith(async () => ({
      ok: false,
      message: 'gh: Not Found (HTTP 404)',
    }))
    const outcome = await gateway.resolveRepository({ githubHost: 'github.com', owner: 'o', name: 'gone' })
    assert.ok(isBlocked(outcome))
    if (outcome.kind === 'blocked') {
      assert.equal(outcome.code, 'repository-not-found')
      assert.equal(outcome.sharedWrite, 'none')
    }
  })

  it('classifies missing authentication as a block requiring operator action', async () => {
    const gateway = gatewayWith(async () => ({
      ok: false,
      message: 'gh: To get started with GitHub CLI, please run: gh auth login',
    }))
    const outcome = await gateway.resolveRepository({ githubHost: 'github.com', owner: 'o', name: 'r' })
    assert.ok(isBlocked(outcome))
    if (outcome.kind === 'blocked') assert.equal(outcome.code, 'github-unauthenticated')
  })

  it('surfaces every other failure as a github-unavailable error', async () => {
    const gateway = gatewayWith(async () => ({ ok: false, message: 'dial tcp: i/o timeout' }))
    const outcome = await gateway.resolveRepository({ githubHost: 'github.com', owner: 'o', name: 'r' })
    assert.ok(isError(outcome))
    if (outcome.kind === 'error') assert.equal(outcome.code, 'github-unavailable')
  })

  it('rejects response payloads missing identity fields', async () => {
    const gateway = gatewayWith(async () => ({ ok: true, stdout: JSON.stringify({ name: 'x' }) }))
    const outcome = await gateway.resolveRepository({ githubHost: 'github.com', owner: 'o', name: 'r' })
    assert.ok(isError(outcome))
    if (outcome.kind === 'error') assert.equal(outcome.code, 'github-unavailable')
  })

  it('rejects non-JSON responses', async () => {
    const gateway = gatewayWith(async () => ({ ok: true, stdout: '<html>login page</html>' }))
    const outcome = await gateway.resolveRepository({ githubHost: 'github.com', owner: 'o', name: 'r' })
    assert.ok(isError(outcome))
  })
})

describe('ghCliGateway.authenticatedActor with an injected runner', () => {
  it('returns the authenticated actor node ID and login', async () => {
    const gateway = gatewayWith(async (args) => {
      assert.deepEqual(args, ['api', '--hostname', 'github.com', 'user'])
      return { ok: true, stdout: USER_RESPONSE }
    })
    const outcome = await gateway.authenticatedActor('github.com')
    assert.ok(isOk(outcome))
    if (outcome.kind === 'ok') {
      assert.deepEqual(outcome.value, { id: 'MDQ6VXNlcjIxMzY3', login: 'operator' })
    }
  })

  it('errors on failure — it is never a block: the actor either resolves or the facts are missing', async () => {
    const gateway = gatewayWith(async () => ({ ok: false, message: 'gh: Not Found (HTTP 404)' }))
    const outcome = await gateway.authenticatedActor('github.com')
    assert.ok(isError(outcome))
    if (outcome.kind === 'error') assert.equal(outcome.code, 'github-unavailable')
  })
})
