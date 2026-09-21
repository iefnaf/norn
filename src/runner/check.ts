/**
 * `/norn check` (design.md §2.3, §14): the complete preflight shared with
 * `run`, reporting every independently discoverable finding rather than
 * stopping at the first one.
 *
 * Check validates the local repository, repository-home configuration and
 * its two configured models against the authenticated catalog, GitHub
 * identity, the Task Map contract, existing Delivery Records for every
 * member (integrity-blocking on invalid), resumability of this map's
 * existing Run State, member disjointness against other active runs, and
 * `configRevision`/Norn-version compatibility with those runs.
 *
 * Check is read-only: it creates no Run State, launches no agents, creates
 * no run branches, pushes nothing, writes no GitHub comments, and closes no
 * issues. The one fetch it may perform reads current remote target truth
 * without modifying it. The adapters it touches expose no write operations
 * on this path — the Local control store is only read here — so no run-owned
 * resource and no shared write can occur.
 */
import type { Outcome } from '../core/outcome.ts'
import { blocked, error, ok } from '../core/outcome.ts'
import type { GitRepositoryAdapter } from '../adapters/git-repository.ts'
import type { GitDeliveryFactsAdapter } from '../adapters/git-repository.ts'
import type {
  GitHubGatewayAdapter,
  ResolvedGitHubRepository,
} from '../adapters/github-gateway.ts'
import type { ModelCatalogAdapter } from '../adapters/model-catalog.ts'
import type { TaskMapLoader } from '../map/loader.ts'
import type { MapIssueLocator } from '../map/issue-url.ts'
import { parseIssueUrl } from '../map/issue-url.ts'
import type { TaskMapSnapshot, TicketRef, TopologyFinding } from '../map/snapshot.ts'
import { stableReadTaskMap } from '../map/stable-read.ts'
import type { RunConfigResolution } from '../config/run-config.ts'
import type { LocalControlStore } from '../control/control-store.ts'
import { loadRunConfig } from '../control/control-store.ts'
import {
  deliveryRemedies,
  evaluateDeliveryEvidence,
} from '../evidence/delivery.ts'
import type {
  DeliveryEvidenceFinding,
  DeliveryRemedy,
  DeliveryTargetFacts,
} from '../evidence/delivery.ts'
import type { IssueEvidenceReader } from '../evidence/read.ts'
import { loadAllRunStates } from '../runstate/run-state-store.ts'
import type { RunState } from '../runstate/types.ts'
import { NORN_VERSION } from '../version.ts'
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
  | {
      readonly kind: 'model-unavailable'
      readonly role: 'worker' | 'reviewer'
      readonly model: string
    }
  | {
      readonly kind: 'model-family-conflict'
      readonly family: string
      readonly workerModel: string
      readonly reviewerModel: string
    }
  | {
      readonly kind: 'delivery-evidence'
      readonly ticket: TicketRef
      readonly ticketState: 'OPEN' | 'CLOSED'
      readonly findings: readonly DeliveryEvidenceFinding[]
      readonly remedies: readonly DeliveryRemedy[]
    }
  | {
      readonly kind: 'state-not-resumable'
      readonly runId: string
      readonly mismatches: readonly RunCompatibilityMismatch[]
    }
  | {
      readonly kind: 'ticket-claimed-by-active-run'
      readonly ticketIssueIds: readonly string[]
      readonly runId: string
      readonly mapNumber: number
    }
  | {
      readonly kind: 'incompatible-active-run'
      readonly runId: string
      readonly mapNumber: number
      readonly mismatches: readonly RunCompatibilityMismatch[]
    }

/** Which executor identity an active run disagrees on with this invocation. */
export type RunCompatibilityMismatch = 'configRevision' | 'nornVersion'

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
  | 'model-catalog-unavailable'
  | 'control-store'
  | 'state-integrity'

export type CheckMapOutcome = Outcome<CheckMapReport, CheckMapBlockCode, CheckMapErrorCode>

export type CheckMapDeps = {
  /** Working directory the operator invoked `/norn check` from. */
  readonly cwd: string
  readonly git: GitRepositoryAdapter
  readonly gateway: GitHubGatewayAdapter
  readonly loader: TaskMapLoader
  readonly store: LocalControlStore
  /** The authenticated model catalog both configured models resolve against. */
  readonly catalog: ModelCatalogAdapter
  /** Complete comment and timeline reads for delivery-evidence validation. */
  readonly evidence: IssueEvidenceReader
  /** Read-only Git facts about the fetched target branch. */
  readonly gitFacts: GitDeliveryFactsAdapter
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

/** Whether a persisted state document belongs to the map being checked. */
function isThisMapsState(state: RunState, snapshot: TaskMapSnapshot): boolean {
  return (
    state.map.githubHost === snapshot.ref.githubHost &&
    state.map.repositoryId === snapshot.ref.repositoryId &&
    state.map.issueId === snapshot.ref.issueId
  )
}

/** The member ticket IDs a run currently claims: its latest accepted revision. */
function acceptedMembers(state: RunState): readonly string[] {
  const latest = state.acceptedMapRevisions.at(-1)
  return latest === undefined ? [] : latest.payload.members.map((member) => member.ticketIssueId)
}

/** How a running state's executor identity disagrees with this invocation. */
function runCompatibilityMismatches(
  state: RunState,
  configRevision: string,
): readonly RunCompatibilityMismatch[] {
  const mismatches: RunCompatibilityMismatch[] = []
  if (state.configRevision !== configRevision) mismatches.push('configRevision')
  if (state.nornVersion !== NORN_VERSION) mismatches.push('nornVersion')
  return mismatches
}

/**
 * Run the complete preflight for the map addressed by `mapUrl`. Independent
 * checks accumulate findings; a failed infrastructure read is an `error`,
 * while every domain finding is collected into one `blocked(check-findings)`
 * carrying the complete typed report.
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
      let matchingRemoteName: string | undefined
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
        const match = plausible.find(
          (candidate) =>
            candidate.githubHost === locator.githubHost &&
            candidate.owner === locator.owner &&
            candidate.name === locator.name,
        )
        if (match === undefined) {
          findings.push({
            kind: 'map-repository-mismatch',
            mapIdentity: `${locator.owner}/${locator.name} @ ${locator.githubHost}`,
            localIdentities: plausible.map(
              (candidate) => `${candidate.owner}/${candidate.name} @ ${candidate.githubHost}`,
            ),
          })
        } else {
          matchingRemoteName = match.remoteNames[0]
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

      // Model availability (§2.3, §8): both configured models must resolve
      // in the authenticated catalog, to different provider families.
      if (report.config !== undefined) {
        const models = await deps.catalog.listModels()
        if (models.kind !== 'ok') {
          return error({ scope: 'operation', code: models.code, reason: models.reason })
        }
        const catalog = new Map(models.value.map((model) => [model.id, model]))
        const workerModel = catalog.get(report.config.config.worker.model)
        const reviewerModel = catalog.get(report.config.config.reviewer.model)
        if (workerModel === undefined) {
          findings.push({
            kind: 'model-unavailable',
            role: 'worker',
            model: report.config.config.worker.model,
          })
        }
        if (reviewerModel === undefined) {
          findings.push({
            kind: 'model-unavailable',
            role: 'reviewer',
            model: report.config.config.reviewer.model,
          })
        }
        if (workerModel !== undefined && reviewerModel !== undefined) {
          if (workerModel.family === reviewerModel.family) {
            findings.push({
              kind: 'model-family-conflict',
              family: workerModel.family,
              workerModel: workerModel.id,
              reviewerModel: reviewerModel.id,
            })
          }
        }
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

      // Existing run states (§2.3, §13.2, §16): resumability of this map's
      // state, member disjointness against other active runs, and executor
      // compatibility with every active run.
      let ownMidFlight: Set<string> | undefined
      if (report.repositoryHome !== undefined && report.config !== undefined && report.snapshot !== undefined) {
        const states = await loadAllRunStates(report.repositoryHome)
        if (states.kind !== 'ok') {
          return error({ scope: 'operation', code: states.code, reason: states.reason })
        }
        for (const state of states.value.values()) {
          if (state.status !== 'running') continue // terminal/aborted runs never block
          if (isThisMapsState(state, report.snapshot)) {
            const mismatches = runCompatibilityMismatches(state, report.config.configRevision)
            if (mismatches.length > 0) {
              findings.push({ kind: 'state-not-resumable', runId: state.runId, mismatches })
            }
            // Members mid-flight in this map's own running state are owned
            // by its persisted checkpoints: their Delivery Record state is
            // judged by the §13.3 recovery of `run`, not by preflight's
            // fresh-Work decision (§13.2, §13.3 steps 3–5, §14).
            ownMidFlight = new Set(
              Object.entries(state.tickets)
                .filter(([, ticket]) =>
                  ticket.phase === 'working' || ticket.phase === 'shippable' || ticket.phase === 'shipping')
                .map(([issueId]) => issueId),
            )
            continue
          }
          const claimed = new Set(acceptedMembers(state))
          const overlap = report.snapshot.tickets
            .map((ticket) => ticket.ref.issueId)
            .filter((issueId) => claimed.has(issueId))
          if (overlap.length > 0) {
            findings.push({
              kind: 'ticket-claimed-by-active-run',
              ticketIssueIds: overlap,
              runId: state.runId,
              mapNumber: state.map.number,
            })
          }
          const mismatches = runCompatibilityMismatches(state, report.config.configRevision)
          if (mismatches.length > 0) {
            findings.push({
              kind: 'incompatible-active-run',
              runId: state.runId,
              mapNumber: state.map.number,
              mismatches,
            })
          }
        }

        // Delivery evidence (§14): every closed member must carry one valid
        // Completed Ticket predicate; an open member with otherwise-valid
        // delivery evidence is blocked, never silently re-worked. The target
        // is fetched once, lazily, only when a record needs Git facts.
        if (repositoryRoot !== undefined && matchingRemoteName !== undefined) {
          const targetBranch = report.config.config.targetBranch
          let targetFetched = false
          // Records store object-format-prefixed Git OIDs (§10.3) while the
          // adapter speaks raw hex: strip inputs and re-prefix outputs so the
          // §14 comparisons bind exactly.
          const stripOid = (oid: string): string => {
            const separator = oid.indexOf(':')
            return separator === -1 ? oid : oid.slice(separator + 1)
          }
          const reprefix = (sample: string, value: string): string =>
            /:/.test(value) ? value : `${sample.slice(0, sample.indexOf(':'))}:${value}`
          const facts: DeliveryTargetFacts = {
            async targetSha(branch) {
              if (!targetFetched) {
                const fetched = await deps.gitFacts.fetchTarget(repositoryRoot, matchingRemoteName, branch)
                if (fetched.kind !== 'ok') return fetched
                targetFetched = true
              }
              return deps.gitFacts.targetSha(repositoryRoot, matchingRemoteName, branch)
            },
            commitFacts: async (sha) => {
              const read = await deps.gitFacts.commitFacts(repositoryRoot, stripOid(sha))
              if (read.kind !== 'ok' || read.value === undefined) return read
              return ok({
                treeOid: reprefix(sha, read.value.treeOid),
                parents: read.value.parents.map((parent) => reprefix(sha, parent)),
              })
            },
            isAncestorOfTarget: (sha, branch) =>
              deps.gitFacts.isAncestorOfTarget(repositoryRoot, matchingRemoteName, branch, stripOid(sha)),
          }

          for (const ticket of report.snapshot.tickets) {
            if (ownMidFlight?.has(ticket.ref.issueId)) continue
            const read = await deps.evidence.loadIssueEvidence({
              githubHost: ticket.ref.githubHost,
              number: ticket.ref.number,
              url: ticket.ref.url,
            })
            if (read.kind === 'error') {
              return error({ scope: 'operation', code: 'github-unavailable', reason: read.reason })
            }
            if (read.kind === 'blocked') {
              findings.push(
                read.code === 'issue-not-found'
                  ? { kind: 'issue-not-found' }
                  : read.code === 'repository-not-found'
                    ? { kind: 'repository-not-found' }
                    : { kind: 'github-unauthenticated' },
              )
              continue
            }
            const evaluation = await evaluateDeliveryEvidence({
              map: {
                issueId: report.snapshot.ref.issueId,
                repositoryId: report.snapshot.ref.repositoryId,
              },
              ticket: {
                issueId: ticket.ref.issueId,
                state: ticket.state,
                ticketRevision: ticket.ticketRevision,
              },
              targetBranch,
              trustedEvidenceAuthorIds: report.config.config.trustedEvidenceAuthorIds,
              evidence: read.value,
              facts,
            })
            if (evaluation.status === 'error') {
              return error({ scope: 'operation', code: evaluation.code, reason: evaluation.reason })
            }
            const evidenceFindings: readonly DeliveryEvidenceFinding[] =
              evaluation.status === 'completed'
                ? []
                : evaluation.status === 'no-record'
                  ? ticket.state === 'CLOSED'
                    ? [{ code: 'no-valid-record' }]
                    : []
                  : evaluation.findings
            if (evidenceFindings.length > 0) {
              findings.push({
                kind: 'delivery-evidence',
                ticket: ticket.ref,
                ticketState: ticket.state,
                findings: evidenceFindings,
                remedies: deliveryRemedies(ticket.state, evidenceFindings),
              })
            }
          }
        }
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
