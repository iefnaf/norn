/**
 * `/norn status <map-url>` (design.md §2.3, §13.1, §16): read the local Run
 * State and ownership information for the addressed Task Map.
 *
 * Status is a pure read of local truth. It resolves the map URL against the
 * repository homes recorded under Norn home (their `metadata.json` retains
 * the human-readable identity), loads the persisted Run State for the map,
 * and probes the OS-backed map lock for ownership. It neither resumes nor
 * mutates the run, performs no remote reads, and never presents cached local
 * state as current remote truth — the report carries only persisted facts
 * and the lock probe, and rendering labels them as local.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { blocked, error, ok } from '../core/outcome.ts'
import type { Outcome } from '../core/outcome.ts'
import { parseIssueUrl } from '../map/issue-url.ts'
import type { MapIssueLocator } from '../map/issue-url.ts'
import { parseRepositoryMetadata } from '../control/control-store.ts'
import { mapsDir } from '../config/paths.ts'
import { isMapLockHeld } from '../runstate/locks.ts'
import { loadRunState } from '../runstate/run-state-store.ts'
import type { RunState } from '../runstate/types.ts'

export type StatusBlockCode = 'invalid-map-url' | 'no-repository-home' | 'ambiguous-repository-home'

export type StatusErrorCode = 'control-store' | 'state-integrity' | 'lock-failed'

/**
 * The persisted facts `/norn status` reports. Everything here is local
 * truth; current remote state (issues, target branch) is deliberately absent.
 */
export type MapStatusReport = {
  /** The locator as parsed from the operator's URL. */
  readonly requested: MapIssueLocator
  readonly repositoryHome: string
  /** The persisted Run State document, when one exists for this map. */
  readonly runState: RunState | undefined
  /** Whether a live coordinator currently holds the OS-backed map lock. */
  readonly mapLockHeldByLiveCoordinator: boolean
}

export type StatusOutcome = Outcome<MapStatusReport, StatusBlockCode, StatusErrorCode>

export type StatusDeps = {
  /** Norn home (`<pi-agent-dir>/norn`), where repository homes live. */
  readonly nornHome: string
}

/**
 * Read the local status for the Task Map addressed by `mapUrl`. The URL is
 * routed through Norn home's recorded repository metadata, so no network
 * access is needed and nothing outside Norn home is read or written.
 */
export async function readStatus(deps: StatusDeps, mapUrl: string): Promise<StatusOutcome> {
  const requested = parseIssueUrl(mapUrl)
  if (requested === undefined) {
    return blocked({
      scope: 'operation',
      code: 'invalid-map-url',
      reason: `"${mapUrl.trim()}" is not a full GitHub issue URL of the form https://<host>/<owner>/<repository>/issues/<number>`,
      sharedWrite: 'none',
    })
  }

  const home = findRepositoryHome(deps.nornHome, requested)
  if (home.kind !== 'ok') return home

  const runState = await findRunStateForMap(home.value, requested)
  if (runState.kind !== 'ok') return runState
  const found = runState.value

  // The map lock is keyed by the encoded map issue ID, which local truth
  // provides only through the persisted Run State; without a state there is
  // no lock file for this map either, so nothing is held.
  const mapLockHeld = found.state === undefined ? false : await isMapLockHeld(home.value, found.encodedIssueId)

  return ok({
    requested,
    repositoryHome: home.value,
    runState: found.state,
    mapLockHeldByLiveCoordinator: mapLockHeld,
  })
}

/** Locate the repository home whose metadata matches the URL's repository. */
export function findRepositoryHome(
  nornHome: string,
  requested: MapIssueLocator,
): Outcome<string, StatusBlockCode, StatusErrorCode> {
  const repositoriesRoot = join(nornHome, 'repositories')
  let hosts: string[]
  try {
    hosts = readdirSync(repositoriesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return noRepositoryHome(requested)
    }
    return error({
      scope: 'operation',
      code: 'control-store',
      reason: `failed to list repository homes: ${cause instanceof Error ? cause.message : String(cause)}`,
    })
  }

  const matches: string[] = []
  for (const hostDir of hosts) {
    let repositories: string[]
    try {
      repositories = readdirSync(join(repositoriesRoot, hostDir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch (cause) {
      return error({
        scope: 'operation',
        code: 'control-store',
        reason: `failed to list repository homes: ${cause instanceof Error ? cause.message : String(cause)}`,
      })
    }
    for (const repositoryDir of repositories) {
      const home = join(repositoriesRoot, hostDir, repositoryDir)
      let text: string
      try {
        text = readFileSync(join(home, 'metadata.json'), 'utf8')
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue
        return error({
          scope: 'operation',
          code: 'control-store',
          reason: `failed to read repository metadata: ${cause instanceof Error ? cause.message : String(cause)}`,
        })
      }
      const metadata = parseRepositoryMetadata(text)
      if (metadata === undefined) continue
      if (
        metadata.githubHost.toLowerCase() === requested.githubHost &&
        metadata.owner.toLowerCase() === requested.owner.toLowerCase() &&
        metadata.name.toLowerCase() === requested.name.toLowerCase()
      ) {
        matches.push(home)
      }
    }
  }

  if (matches.length === 0) return noRepositoryHome(requested)
  if (matches.length > 1) {
    return blocked({
      scope: 'operation',
      code: 'ambiguous-repository-home',
      reason: `multiple repository homes match ${requested.owner}/${requested.name}: ${matches.join(', ')}`,
      sharedWrite: 'none',
      evidence: [{ repositoryHomes: matches }],
    })
  }
  return ok(matches[0]!)
}

function noRepositoryHome(requested: MapIssueLocator): Outcome<never, StatusBlockCode, StatusErrorCode> {
  return blocked({
    scope: 'operation',
    code: 'no-repository-home',
    reason: `no Norn repository home is initialized for ${requested.githubHost}/${requested.owner}/${requested.name}; run /norn init inside that repository first`,
    sharedWrite: 'none',
  })
}

export type FoundRunState = { readonly encodedIssueId: string; readonly state: RunState | undefined }

/**
 * Find the persisted Run State whose map matches the requested locator.
 * Run-state directories are keyed by opaque encoded issue IDs, so each
 * document's own `map` reference decides the match; documents that cannot be
 * attributed (absent or unparseable) cannot be reported as this map's state.
 */
export function findRunStateForMap(
  repositoryHome: string,
  requested: MapIssueLocator,
): Outcome<FoundRunState, StatusBlockCode, StatusErrorCode> {
  let entries
  try {
    entries = readdirSync(mapsDir(repositoryHome), { withFileTypes: true })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok({ encodedIssueId: '', state: undefined })
    }
    return error({
      scope: 'operation',
      code: 'control-store',
      reason: `failed to list run states: ${cause instanceof Error ? cause.message : String(cause)}`,
    })
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const loaded = loadRunState(repositoryHome, entry.name)
    if (loaded.kind !== 'ok') {
      // Unattributable state (unreadable or failing integrity) cannot be
      // claimed by this map; it is not silently reported either.
      continue
    }
    if (loaded.value === undefined) continue
    const map = loaded.value.map
    if (
      map.githubHost.toLowerCase() === requested.githubHost &&
      map.number === requested.number
    ) {
      return ok({ encodedIssueId: entry.name, state: loaded.value })
    }
  }
  return ok({ encodedIssueId: '', state: undefined })
}
