/**
 * The Git repository seam (design.md §6): identify the local repository and
 * its remotes without touching the working tree. The built-in production
 * adapter shells out to the `git` CLI; tests inject a runner with canned
 * output, or use a temporary repository for the real adapter.
 *
 * Everything here is read-only: Norn creates nothing inside the target
 * repository's working tree during init.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { error, ok } from '../core/outcome.ts'
import type { Outcome } from '../core/outcome.ts'
import type { DeliveryCommitFacts, DeliveryFactsErrorCode } from '../evidence/delivery.ts'

const execFileAsync = promisify(execFile)

/** Wall-clock budget for one `git` invocation. */
const GIT_TIMEOUT_MS = 15_000

export type GitRepositoryErrorCode = 'git-unavailable' | 'not-a-repository' | 'git-failed'

/** One named remote of the local repository, as `git remote -v` reports. */
export type GitRemote = {
  readonly name: string
  readonly url: string
}

export type GitRepositoryAdapter = {
  /** Absolute path of the repository root containing `cwd`. */
  resolveRoot(cwd: string): Promise<Outcome<string, never, GitRepositoryErrorCode>>
  /** Every remote with its fetch URL, in `git remote -v` order. */
  listRemotes(root: string): Promise<Outcome<readonly GitRemote[], never, GitRepositoryErrorCode>>
}

/** A single git CLI invocation, injectable for deterministic tests. */
export type GitCommandResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly failure: GitRepositoryErrorCode; readonly message: string }

export type GitCommandRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<GitCommandResult>

/** The built-in `git` CLI invocation the production adapter defaults to. */
export async function runGit(args: readonly string[], cwd: string): Promise<GitCommandResult> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS })
    return { ok: true, stdout }
  } catch (cause) {
    return { ok: false, failure: classifyGitFailure(cause), message: describe(cause) }
  }
}

function classifyGitFailure(cause: unknown): GitRepositoryErrorCode {
  if (cause !== null && typeof cause === 'object' && (cause as { code?: string }).code === 'ENOENT') {
    return 'git-unavailable'
  }
  const message = failureMessage(cause)
  if (/not a git repository/i.test(message)) return 'not-a-repository'
  return 'git-failed'
}

function failureMessage(cause: unknown): string {
  if (cause !== null && typeof cause === 'object') {
    const candidate = cause as { stderr?: string; message?: string }
    const stderr = typeof candidate.stderr === 'string' ? candidate.stderr : ''
    if (stderr !== '') return stderr
    if (typeof candidate.message === 'string') return candidate.message
  }
  return String(cause)
}

function describe(cause: unknown): string {
  return failureMessage(cause).trim()
}

/** The built-in production adapter over the `git` CLI. */
export function gitCliRepository(run: GitCommandRunner = runGit): GitRepositoryAdapter {
  return {
    async resolveRoot(cwd) {
      const result = await run(['rev-parse', '--show-toplevel'], cwd)
      if (!result.ok) {
        return error({ scope: 'operation', code: result.failure, reason: result.message })
      }
      const root = result.stdout.trim()
      if (root === '') {
        return error({
          scope: 'operation',
          code: 'git-failed',
          reason: 'git rev-parse --show-toplevel produced no output',
        })
      }
      return ok(root)
    },

    async listRemotes(root) {
      const result = await run(['remote', '-v'], root)
      if (!result.ok) {
        return error({ scope: 'operation', code: result.failure, reason: result.message })
      }
      const remotes: GitRemote[] = []
      const seen = new Set<string>()
      for (const line of result.stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.endsWith('(fetch)')) continue
        const [name, url] = trimmed.slice(0, -' (fetch)'.length).split('\t')
        if (name === undefined || url === undefined) continue
        const key = `${name}\u0000${url}`
        if (seen.has(key)) continue
        seen.add(key)
        remotes.push({ name, url })
      }
      return ok(remotes)
    },
  }
}

/** One parseable git remote URL: host plus repository owner/name path. */
export type ParsedRemoteUrl = {
  readonly host: string
  readonly owner: string
  readonly name: string
}

/**
 * Parse an https or ssh git remote URL into host, owner, and repository name.
 * Accepts `https://host/owner/name[.git]`, `ssh://[user@]host[:port]/owner/name[.git]`,
 * and scp-style `user@host:owner/name[.git]` with an optional trailing slash.
 * Returns `undefined` for anything else; the host is lowercase with the
 * default HTTPS (443) or SSH (22) port omitted, mirroring §7.3 host identity.
 */
export function parseGitRemoteUrl(url: string): ParsedRemoteUrl | undefined {
  const trimmed = url.trim()
  if (trimmed === '') return undefined

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(trimmed)
  if (schemeMatch !== null) {
    const scheme = schemeMatch[1]!.toLowerCase()
    if (scheme !== 'https' && scheme !== 'http' && scheme !== 'ssh') return undefined
    return parseUrlWithAuthority(scheme, schemeMatch[2]!)
  }
  return parseScpStyleUrl(trimmed)
}

function parseUrlWithAuthority(scheme: string, rest: string): ParsedRemoteUrl | undefined {
  const pathStart = rest.indexOf('/')
  if (pathStart === -1) return undefined
  const authority = rest.slice(0, pathStart)
  const path = rest.slice(pathStart + 1)
  if (authority === '' || authority.includes('[')) return undefined // no IPv6 authorities

  const hostPort = authority.split('@').pop() ?? ''
  if (hostPort === '') return undefined
  const [rawHost, rawPort] = hostPort.split(':')
  if (rawHost === undefined || rawHost === '') return undefined
  const defaultPort = scheme === 'ssh' ? '22' : '443'
  const port = rawPort === undefined || rawPort === '' ? defaultPort : rawPort
  if (!/^\d+$/.test(port)) return undefined
  const host = port === defaultPort ? normalizeHost(rawHost) : `${normalizeHost(rawHost)}:${port}`

  const repository = parseOwnerName(path)
  return repository === undefined ? undefined : { host, ...repository }
}

function parseScpStyleUrl(url: string): ParsedRemoteUrl | undefined {
  const colon = url.indexOf(':')
  if (colon === -1) return undefined
  const authority = url.slice(0, colon)
  const path = url.slice(colon + 1)
  if (!authority.includes('@')) return undefined
  const host = authority.split('@').pop() ?? ''
  if (host === '' || host.includes('/') || host.includes(':')) return undefined
  const parsed = parseOwnerName(path)
  return parsed === undefined ? undefined : { host: normalizeHost(host), ...parsed }
}

function parseOwnerName(path: string): { owner: string; name: string } | undefined {
  const withoutGit = path.endsWith('.git') ? path.slice(0, -'.git'.length) : path
  const segments = withoutGit.split('/').filter((segment) => segment !== '')
  if (segments.length !== 2) return undefined
  const [owner, name] = segments as [string, string]
  if (owner === '' || name === '') return undefined
  return { owner, name }
}

/** Lowercase host with the default HTTPS port omitted (§7.3). */
export function normalizeHost(host: string): string {
  const lowercase = host.toLowerCase()
  return lowercase.endsWith(':443') ? lowercase.slice(0, -':443'.length) : lowercase
}

// ---------------------------------------------------------------------------
// Delivery target facts (design.md §14 predicate 9)
// ---------------------------------------------------------------------------

/**
 * A single git CLI invocation that also reports the process exit status, so
 * `commitFacts` and `isAncestorOfTarget` can distinguish a proved absence
 * (exit 1) from an infrastructure failure.
 */
export type GitFactsCommandResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly exitCode: number | undefined; readonly message: string }

export type GitFactsCommandRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<GitFactsCommandResult>

async function runGitDetailed(args: readonly string[], cwd: string): Promise<GitFactsCommandResult> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS })
    return { ok: true, stdout }
  } catch (cause) {
    if (cause !== null && typeof cause === 'object' && (cause as { code?: unknown }).code === 'ENOENT') {
      return { ok: false, exitCode: undefined, message: 'the git CLI is not installed or not on PATH' }
    }
    const exitCode = (cause as { code?: unknown }).code
    return {
      ok: false,
      exitCode: typeof exitCode === 'number' ? exitCode : undefined,
      message: describe(cause),
    }
  }
}

function factsUnavailable(cause: string): Outcome<never, never, DeliveryFactsErrorCode> {
  return error({ scope: 'operation', code: 'git-unavailable', reason: cause })
}

function factsFailed(reason: string): Outcome<never, never, DeliveryFactsErrorCode> {
  return error({ scope: 'operation', code: 'git-failed', reason })
}

/** Read-only Git facts about the fetched remote target branch (§14). */
export type GitDeliveryFactsAdapter = {
  /** Fetch the remote target branch so later reads see current remote truth. */
  fetchTarget(
    root: string,
    remote: string,
    branch: string,
  ): Promise<Outcome<void, never, DeliveryFactsErrorCode>>
  /** The fetched tip SHA of `refs/remotes/<remote>/<branch>`. */
  targetSha(
    root: string,
    remote: string,
    branch: string,
  ): Promise<Outcome<string, never, DeliveryFactsErrorCode>>
  /** Commit tree and parents, or `undefined` when the object is absent. */
  commitFacts(
    root: string,
    sha: string,
  ): Promise<Outcome<DeliveryCommitFacts | undefined, never, DeliveryFactsErrorCode>>
  /** Whether `sha` is an ancestor of the fetched target branch tip. */
  isAncestorOfTarget(
    root: string,
    remote: string,
    branch: string,
    sha: string,
  ): Promise<Outcome<boolean, never, DeliveryFactsErrorCode>>
}

/**
 * The built-in production adapter over the `git` CLI. Each method is a
 * read-only query; `fetchTarget` performs the one fetch that makes the
 * object database current before shape and ancestry decisions (§13.3, §14).
 */
export function gitCliDeliveryFacts(
  run: GitFactsCommandRunner = runGitDetailed,
): GitDeliveryFactsAdapter {
  return {
    async fetchTarget(root, remote, branch) {
      const result = await run(['fetch', remote, branch], root)
      if (!result.ok) {
        if (result.exitCode === undefined) return factsUnavailable(result.message)
        return factsFailed(`git fetch ${remote} ${branch} failed: ${result.message}`)
      }
      return ok(undefined)
    },

    async targetSha(root, remote, branch) {
      const ref = `refs/remotes/${remote}/${branch}`
      const result = await run(['rev-parse', ref], root)
      if (!result.ok) {
        if (result.exitCode === undefined) return factsUnavailable(result.message)
        return factsFailed(`git rev-parse ${ref} failed: ${result.message}`)
      }
      const sha = result.stdout.trim()
      if (sha === '') return factsFailed(`git rev-parse ${ref} produced no output`)
      return ok(sha)
    },

    async commitFacts(root, sha) {
      const probe = await run(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], root)
      if (!probe.ok) {
        if (probe.exitCode === undefined) return factsUnavailable(probe.message)
        if (probe.exitCode === 1) return ok(undefined) // proved absence, quiet flag
        return factsFailed(`resolving ${sha} failed: ${probe.message}`)
      }
      const show = await run(['show', '-s', '--format=%T%n%P', sha], root)
      if (!show.ok) {
        if (show.exitCode === undefined) return factsUnavailable(show.message)
        return factsFailed(`reading commit facts of ${sha} failed: ${show.message}`)
      }
      const [treeLine = '', parentLine = ''] = show.stdout.trimEnd().split('\n')
      const treeOid = treeLine.trim()
      if (treeOid === '') return factsFailed(`commit facts of ${sha} lack a tree`)
      const parents = parentLine.split(' ').filter((parent) => parent !== '')
      return ok({ treeOid, parents })
    },

    async isAncestorOfTarget(root, remote, branch, sha) {
      const ref = `refs/remotes/${remote}/${branch}`
      const result = await run(['merge-base', '--is-ancestor', sha, ref], root)
      if (!result.ok) {
        if (result.exitCode === undefined) return factsUnavailable(result.message)
        if (result.exitCode === 1) return ok(false) // proved non-ancestry
        return factsFailed(`git merge-base --is-ancestor ${sha} ${ref} failed: ${result.message}`)
      }
      return ok(true)
    },
  }
}
