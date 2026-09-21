/**
 * Norn home and repository-home layout (design.md §2.2, §13.1).
 *
 * Norn stores operator configuration and runtime state under Norn home,
 * `<pi-agent-dir>/norn`, where `<pi-agent-dir>` is `PI_CODING_AGENT_DIR` when
 * set and otherwise defaults to `~/.pi/agent`. Repository state is keyed by
 * the stable GitHub repository identity under
 * `repositories/<encoded-github-host>/<encoded-repository-id>/` — never by
 * owner/name pair or local checkout path, and never inside the target
 * repository's working tree.
 *
 * The environment read is a pure input: callers pass `env` and the home
 * directory as data so tests stay deterministic.
 */
import { join } from 'node:path'

/** The stable identity a repository home is keyed by (design.md §2.2). */
export type RepositoryIdentity = {
  /** Lowercase ASCII host with the default HTTPS port omitted (§7.3). */
  readonly githubHost: string
  /** Opaque GitHub repository node ID, preserved exactly. */
  readonly repositoryId: string
}

/**
 * Resolve Norn home. `PI_CODING_AGENT_DIR` is honored when set to a non-empty
 * value; otherwise the default `<homeDir>/.pi/agent` applies.
 */
export function resolveNornHome(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): string {
  const agentDir = env.PI_CODING_AGENT_DIR
  const configured = agentDir === undefined ? '' : agentDir.trim()
  return configured === '' ? join(homeDir, '.pi', 'agent', 'norn') : join(configured, 'norn')
}

const UNRESERVED = /[A-Za-z0-9._-]/

/**
 * Encode one path segment injectively: every byte outside `[A-Za-z0-9._-]`
 * becomes uppercase percent-encoded UTF-8, so distinct hosts, repository IDs,
 * and issue IDs always map to distinct directory names.
 */
export function encodePathSegment(raw: string): string {
  let encoded = ''
  for (const byte of Buffer.from(raw, 'utf8')) {
    const character = String.fromCharCode(byte)
    encoded += UNRESERVED.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return encoded
}

/** Repository home: the per-repository directory under Norn home (§2.2). */
export function repositoryHomeDir(nornHome: string, identity: RepositoryIdentity): string {
  return join(
    nornHome,
    'repositories',
    encodePathSegment(identity.githubHost),
    encodePathSegment(identity.repositoryId),
  )
}

/** Directory holding one Run State document per Task Map (§13.1). */
export function mapsDir(repositoryHome: string): string {
  return join(repositoryHome, 'maps')
}

/** Run State document path for one encoded issue ID (§13.1). */
export function runStatePath(repositoryHome: string, encodedIssueId: string): string {
  return join(mapsDir(repositoryHome), encodedIssueId, 'run-state.json')
}

/** Directory holding every lock and the Work-slot registry (§16). */
export function locksDir(repositoryHome: string): string {
  return join(repositoryHome, 'locks')
}

/** OS-backed map lock file: one live coordinator per Task Map (§16). */
export function mapLockPath(repositoryHome: string, encodedIssueId: string): string {
  return join(locksDir(repositoryHome), `map-${encodePathSegment(encodedIssueId)}.lock`)
}

/** Short-held repository control lock file (§16). */
export function controlLockPath(repositoryHome: string): string {
  return join(locksDir(repositoryHome), 'control.lock')
}

/** OS-backed target lock file: Ship serialized per repository and branch (§16). */
export function targetLockPath(repositoryHome: string, branch: string): string {
  return join(locksDir(repositoryHome), `target-${encodePathSegment(branch)}.lock`)
}

/** The repository-wide Work-slot registry document (§8, §16). */
export function workSlotRegistryPath(repositoryHome: string): string {
  return join(locksDir(repositoryHome), 'work-slots.json')
}

export const METADATA_FILE_NAME = 'metadata.json'
export const CONFIG_FILE_NAME = 'config.json'

export function metadataFilePath(repositoryHome: string): string {
  return join(repositoryHome, METADATA_FILE_NAME)
}

export function configFilePath(repositoryHome: string): string {
  return join(repositoryHome, CONFIG_FILE_NAME)
}
