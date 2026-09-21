/**
 * The GitHub gateway seam (design.md §6, §2.2): resolve stable GitHub
 * identities from local facts. `/norn init` uses it to turn a chosen remote
 * into the stable repository identity (node IDs, not owner/name) and to learn
 * the authenticated actor.
 *
 * The built-in production adapter shells out to the `gh` CLI, inheriting the
 * operator's authenticated GitHub sessions. Tests inject a runner with canned
 * responses — no network, no clock.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { blocked, error, ok } from '../core/outcome.ts'
import type { Outcome } from '../core/outcome.ts'

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
