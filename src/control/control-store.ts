/**
 * The Local control store seam (design.md §6, §8, §16).
 *
 * The store owns repository-home persistence: loading repository metadata and
 * the Run Config file, atomically writing the `/norn init` setup documents,
 * and answering whether any run in the repository is still `running` (the
 * `blocked(config-in-use)` fact). It is the only module that touches Norn-home
 * files; the runner holds no paths of its own.
 *
 * The built-in adapter is the filesystem implementation, constructed with a
 * Norn-home path. Tests run it against a temporary directory: no network, no
 * clock dependence. Later tickets extend this seam with locks, slot
 * accounting, and Run State persistence at the same interface.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs'

import { blocked, error, ok } from '../core/outcome.ts'
import type { Outcome } from '../core/outcome.ts'
import type {
  ModelFamilyResolver,
  RunConfigResolution,
} from '../config/run-config.ts'
import { resolveRunConfigText } from '../config/run-config.ts'
import {
  configFilePath,
  mapsDir,
  metadataFilePath,
  repositoryHomeDir,
  runStatePath,
} from '../config/paths.ts'
import type { RepositoryIdentity } from '../config/paths.ts'
import { writeDocumentAtomic } from '../runstate/atomic-write.ts'

export const REPOSITORY_METADATA_SCHEMA = 'norn-repository-metadata:v1' as const

/** Human-readable repository identity retained under repository home (§2.2). */
export type RepositoryMetadata = {
  readonly schema: typeof REPOSITORY_METADATA_SCHEMA
  readonly githubHost: string
  readonly repositoryId: string
  readonly owner: string
  readonly name: string
  readonly defaultBranch: string
}

export type ControlStoreErrorCode = 'control-store'

export type ActiveRuns = {
  /** Encoded map issue IDs whose Run State is (or may be) still running. */
  readonly activeRunMaps: readonly string[]
}

/**
 * The Local control store seam. Every method returns a typed outcome; a
 * `control-store` error means required local facts could not be established.
 */
export interface LocalControlStore {
  repositoryHome(identity: RepositoryIdentity): string
  readMetadataText(home: string): Promise<Outcome<string | undefined, never, ControlStoreErrorCode>>
  readConfigText(home: string): Promise<Outcome<string | undefined, never, ControlStoreErrorCode>>
  /**
   * Atomically write `metadata.json` and `config.json` under repository home.
   * Each file lands via the §13.1 protocol: temporary file, flush, atomic
   * rename, directory flush. Metadata is written first so `config.json` remains
   * the authoritative marker of a completed init.
   */
  writeRepositorySetup(
    home: string,
    files: { readonly metadataJson: string; readonly configJson: string },
  ): Promise<Outcome<void, never, ControlStoreErrorCode>>
  /**
   * Encoded map IDs whose Run State is `running`. A `run-state.json` that
   * exists but cannot be read or parsed counts as active: an unprovable state
   * must block configuration replacement rather than permit it.
   */
  findActiveRuns(home: string): Promise<Outcome<ActiveRuns, never, ControlStoreErrorCode>>
}

export type LoadRunConfigBlockCode = 'no-config' | 'invalid-config'
export type LoadRunConfigOutcome = Outcome<
  RunConfigResolution,
  LoadRunConfigBlockCode,
  ControlStoreErrorCode
>

/**
 * Load, validate, and expand `<repository-home>/config.json` (§8). This is the
 * only configuration input; an invalid or hand-edited file is
 * `blocked(invalid-config)` before any run-owned resource is created, and a
 * missing file is `blocked(no-config)`. When `resolveModelFamily` is supplied,
 * both agent models must resolve in the catalog to different provider
 * families.
 */
export async function loadRunConfig(
  store: LocalControlStore,
  home: string,
  resolveModelFamily?: ModelFamilyResolver,
): Promise<LoadRunConfigOutcome> {
  const text = await store.readConfigText(home)
  if (text.kind !== 'ok') {
    return error({ scope: 'operation', code: 'control-store', reason: text.reason })
  }
  if (text.value === undefined) {
    return blocked({
      scope: 'operation',
      code: 'no-config',
      reason: 'config.json does not exist under repository home; run /norn init first',
      sharedWrite: 'none',
    })
  }
  const resolved = resolveRunConfigText(text.value, resolveModelFamily)
  if (resolved.kind === 'ok') return resolved
  return blocked({
    scope: 'operation',
    code: 'invalid-config',
    reason: resolved.reason,
    sharedWrite: 'none',
    evidence: resolved.evidence,
  })
}

/** Parse `metadata.json` text; anything malformed yields `undefined`. */
export function parseRepositoryMetadata(text: string): RepositoryMetadata | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const candidate = parsed as Record<string, unknown>
  const fields = ['schema', 'githubHost', 'repositoryId', 'owner', 'name', 'defaultBranch'] as const
  if (candidate.schema !== REPOSITORY_METADATA_SCHEMA) return undefined
  for (const field of fields) {
    if (typeof candidate[field] !== 'string' || candidate[field] === '') return undefined
  }
  return {
    schema: REPOSITORY_METADATA_SCHEMA,
    githubHost: candidate.githubHost as string,
    repositoryId: candidate.repositoryId as string,
    owner: candidate.owner as string,
    name: candidate.name as string,
    defaultBranch: candidate.defaultBranch as string,
  }
}

/** The built-in filesystem Local control store over one Norn home. */
export function fsControlStore(nornHome: string): LocalControlStore {
  return {
    repositoryHome(identity: RepositoryIdentity): string {
      return repositoryHomeDir(nornHome, identity)
    },

    async readMetadataText(home) {
      return readTextFile(metadataFilePath(home))
    },

    async readConfigText(home) {
      return readTextFile(configFilePath(home))
    },

    async writeRepositorySetup(home, files) {
      try {
        mkdirSync(home, { recursive: true })
        writeDocumentAtomic(metadataFilePath(home), files.metadataJson)
        writeDocumentAtomic(configFilePath(home), files.configJson)
        return ok(undefined)
      } catch (cause) {
        return controlStoreError('writing repository setup', cause)
      }
    },

    async findActiveRuns(home) {
      let entries
      try {
        entries = readdirSync(mapsDir(home), { withFileTypes: true })
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ok({ activeRunMaps: [] })
        return controlStoreError('listing run states', cause)
      }
      const activeRunMaps: string[] = []
      try {
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const path = runStatePath(home, entry.name)
          let text: string
          try {
            text = readFileSync(path, 'utf8')
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue
            activeRunMaps.push(entry.name) // unreadable state cannot be proven inactive
            continue
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch {
            activeRunMaps.push(entry.name) // unparseable state cannot be proven inactive
            continue
          }
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            !Array.isArray(parsed) &&
            (parsed as Record<string, unknown>).status === 'running'
          ) {
            activeRunMaps.push(entry.name)
          }
        }
      } catch (cause) {
        return controlStoreError('reading run states', cause)
      }
      return ok({ activeRunMaps: activeRunMaps.sort() })
    },
  }
}

function readTextFile(path: string): Outcome<string | undefined, never, ControlStoreErrorCode> {
  try {
    return ok(readFileSync(path, 'utf8'))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ok(undefined)
    return controlStoreError(`reading ${path}`, cause)
  }
}

function controlStoreError(what: string, cause: unknown): Outcome<never, never, ControlStoreErrorCode> {
  return error({
    scope: 'operation',
    code: 'control-store',
    reason: `local control store failed while ${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
  })
}
