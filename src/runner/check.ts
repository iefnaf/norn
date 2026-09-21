/**
 * `/norn check` (design.md §2.3): the repository/config identity and Task Map
 * contract portions of the preflight shared with `run`, reporting every
 * independently discoverable finding rather than stopping at the first.
 *
 * Check is read-only: it creates no Run State, launches no agents, creates no
 * run branches, pushes nothing, writes no GitHub comments, and closes no
 * issues. The adapters it touches expose no write operations on this path —
 * the Local control store is only read here — so no run-owned resource and no
 * shared write can occur.
 *
 * Later tickets extend this same preflight with model availability, target
 * branch, delivery evidence, and active-run ownership; the checks below are
 * the repository/config identity and map-contract halves.
 */
import type { Outcome } from '../core/outcome.ts'
import { blocked, error, ok } from '../core/outcome.ts'
import type { GitRepositoryAdapter } from '../adapters/git-repository.ts'
import type {
  GitHubGatewayAdapter,
  ResolvedGitHubRepository,
} from '../adapters/github-gateway.ts'
import type { TaskMapLoader } from '../map/loader.ts'
import type { MapIssueLocator } from '../map/issue-url.ts'
import { parseIssueUrl } from '../map/issue-url.ts'
import type { TaskMapSnapshot, TopologyFinding } from '../map/snapshot.ts'
import { stableReadTaskMap } from '../map/stable-read.ts'
import type { RunConfigResolution } from '../config/run-config.ts'
import type { LocalControlStore } from '../control/control-store.ts'
import { loadRunConfig } from '../control/control-store.ts'
import { plausibleRemoteIdentities } from './init.ts'

/** Every finding kind check can report; all are typed, renderable data. */
export type CheckMapFinding =
  | { readonly kind: 'not-a-repository'; readonly cwd: string }
  | { readonly kind: 'invalid-map-url'; readonly input: string }
  | { readonly kind: 'repository-not-found' }
  | { readonly kind: 'github-unauthenticated' }
  | { readonly kind: 'issue-not-found' }
  | {
      readonly kind: 'map-repository-mismatch'
      readonly mapIdentity: string
      readonly localIdentities: readonly string[]
    }
  | { readonly kind: 'no-config'; readonly repositoryHome: string }
  | { readonly kind: 'invalid-config'; readonly violations: readonly string[] }
  | { readonly kind: 'invalid-map'; readonly findings: readonly TopologyFinding[] }
  | { readonly kind: 'changed-input' }

export type CheckMapReport = {
  /** The raw `<map-url>` argument exactly as invoked. */
  readonly mapUrl: string
  readonly locator?: MapIssueLocator
  readonly repository?: ResolvedGitHubRepository
  readonly repositoryHome?: string
  readonly config?: RunConfigResolution
  readonly snapshot?: TaskMapSnapshot
  /** Empty exactly when preflight passed. */
  readonly findings: readonly CheckMapFinding[]
}

export type CheckMapBlockCode = 'check-findings'

export type CheckMapErrorCode =
  | 'git-unavailable'
  | 'git-failed'
  | 'github-unavailable'
  | 'control-store'

export type CheckMapOutcome = Outcome<CheckMapReport, CheckMapBlockCode, CheckMapErrorCode>

export type CheckMapDeps = {
  /** Working directory the operator invoked `/norn check` from. */
  readonly cwd: string
  readonly git: GitRepositoryAdapter
  readonly gateway: GitHubGatewayAdapter
  readonly loader: TaskMapLoader
  readonly store: LocalControlStore
}

function configViolations(evidence: readonly unknown[]): readonly string[] {
  for (const entry of evidence) {
    if (typeof entry === 'object' && entry !== null && Array.isArray((entry as { violations?: unknown }).violations)) {
      const violations = (entry as { violations: unknown[] }).violations
      if (violations.every((item) => typeof item === 'string')) return violations as string[]
    }
  }
  return []
}

/**
 * Run the repository/config identity and Task Map contract preflight for the
 * map addressed by `mapUrl`. Independent checks accumulate findings; a failed
 * infrastructure read is an `error`, while every domain finding is collected
 * into one `blocked(check-findings)` carrying the complete typed report.
 */
export async function checkMap(deps: CheckMapDeps, mapUrl: string): Promise<CheckMapOutcome> {
  const findings: CheckMapFinding[] = []
  const report: {
    mapUrl: string
    locator?: MapIssueLocator
    repository?: ResolvedGitHubRepository
    repositoryHome?: string
    config?: RunConfigResolution
    snapshot?: TaskMapSnapshot
    findings: readonly CheckMapFinding[]
  } = { mapUrl, findings }

  // Local repository identity — independent of the map URL.
  const root = await deps.git.resolveRoot(deps.cwd)
  let repositoryRoot: string | undefined
  if (root.kind === 'ok') {
    repositoryRoot = root.value
  } else if (root.code === 'not-a-repository') {
    findings.push({ kind: 'not-a-repository', cwd: deps.cwd })
  } else {
    return error({ scope: 'operation', code: root.code, reason: root.reason })
  }

  // Map URL syntax — independent of the local repository. The full-issue-URL
  // requirement (§2.2) rejects #123 shorthand here.
  const locator = parseIssueUrl(mapUrl)
  if (locator === undefined) findings.push({ kind: 'invalid-map-url', input: mapUrl })
  if (locator !== undefined) report.locator = locator

  if (locator !== undefined) {
    // Stable repository identity of the URL (§2.2): node IDs, not owner/name.
    const resolved = await deps.gateway.resolveRepository({
      githubHost: locator.githubHost,
      owner: locator.owner,
      name: locator.name,
    })
    if (resolved.kind === 'ok') {
      report.repository = resolved.value
    } else if (resolved.kind === 'blocked') {
      findings.push(
        resolved.code === 'github-unauthenticated'
          ? { kind: 'github-unauthenticated' }
          : { kind: 'repository-not-found' },
      )
    } else {
      return error({ scope: 'operation', code: 'github-unavailable', reason: resolved.reason })
    }

    if (report.repository !== undefined) {
      // The URL's repository must be this checkout's repository (§2.2).
      if (repositoryRoot !== undefined) {
        const remotes = await deps.git.listRemotes(repositoryRoot)
        if (remotes.kind !== 'ok') {
          // `listRemotes` cannot genuinely report not-a-repository after the
          // root resolved; if git claims so anyway, that is a git failure.
          return error({
            scope: 'operation',
            code: remotes.code === 'not-a-repository' ? 'git-failed' : remotes.code,
            reason: remotes.reason,
          })
        }
        const plausible = plausibleRemoteIdentities(remotes.value)
        const matches = plausible.some(
          (candidate) =>
            candidate.githubHost === locator.githubHost &&
            candidate.owner === locator.owner &&
            candidate.name === locator.name,
        )
        if (!matches) {
          findings.push({
            kind: 'map-repository-mismatch',
            mapIdentity: `${locator.owner}/${locator.name} @ ${locator.githubHost}`,
            localIdentities: plausible.map(
              (candidate) => `${candidate.owner}/${candidate.name} @ ${candidate.githubHost}`,
            ),
          })
        }
      }

      // Repository-home configuration (§8): load, validate, and expand.
      const home = deps.store.repositoryHome({
        githubHost: report.repository.githubHost,
        repositoryId: report.repository.repositoryId,
      })
      report.repositoryHome = home
      const config = await loadRunConfig(deps.store, home)
      if (config.kind === 'ok') {
        report.config = config.value
      } else if (config.kind === 'blocked') {
        findings.push(
          config.code === 'no-config'
            ? { kind: 'no-config', repositoryHome: home }
            : { kind: 'invalid-config', violations: configViolations(config.evidence) },
        )
      } else {
        return error({ scope: 'operation', code: 'control-store', reason: config.reason })
      }

      // Task Map contract (§7): stable-read the complete map graph and validate
      // identity and topology. Independent of the configuration findings above.
      // Skipped when the repository itself did not resolve: the loader could
      // only rediscover the same trustworthy failure.
      const snapshot = await stableReadTaskMap(() => deps.loader.loadTaskMap(locator))
      if (snapshot.kind === 'ok') {
        report.snapshot = snapshot.value
      } else if (snapshot.kind === 'blocked') {
        if (snapshot.code === 'invalid-map') {
          const first = snapshot.evidence[0] as { findings?: TopologyFinding[] } | undefined
          findings.push({ kind: 'invalid-map', findings: first?.findings ?? [] })
        } else if (snapshot.code === 'changed-input') {
          findings.push({ kind: 'changed-input' })
        } else if (snapshot.code === 'issue-not-found') {
          findings.push({ kind: 'issue-not-found' })
        } else if (snapshot.code === 'repository-not-found') {
          findings.push({ kind: 'repository-not-found' })
        } else {
          findings.push({ kind: 'github-unauthenticated' })
        }
      } else {
        return error({ scope: 'operation', code: snapshot.code, reason: snapshot.reason })
      }
    }
  }

  if (findings.length > 0) {
    return blocked({
      scope: 'operation',
      code: 'check-findings',
      reason: `preflight found ${findings.length} finding(s): ${[...new Set(findings.map((f) => f.kind))].join(', ')}`,
      sharedWrite: 'none',
      evidence: [report],
    })
  }
  return ok(report)
}
