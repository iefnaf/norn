/**
 * Run Config validation, default expansion, and revision identity
 * (design.md §8).
 *
 * `<repository-home>/config.json` is the only configuration input. It holds
 * the operator's explicit `/norn init` choices; every load recomputes one
 * resolved Run Config document from it by validating structure and expanding
 * the fixed schema defaults. The resolved document is never persisted.
 *
 * Expansion is deterministic: identical `config.json` content always produces
 * the same resolved document and the same `configRevision`, independent of
 * checkout, environment, or invocation time, because this module is pure — no
 * I/O, no clock, no environment reads. `configRevision` is SHA-256 over the
 * RFC 8785 canonical JSON encoding of the resolved document, written
 * `sha256:<lowercase-hex>` like every other Norn revision.
 */
import { compareUtf16CodeUnits } from '../core/canonical-json.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'
import { canonicalJsonDigest } from '../core/digest.ts'
import type { Sha256Digest } from '../core/digest.ts'
import { blocked, ok } from '../core/outcome.ts'
import type { Outcome } from '../core/outcome.ts'
import { isDeniedEnvironmentName } from '../work/environment.ts'

export const RUN_CONFIG_SCHEMA = 'norn-run:v1' as const

/** A configured command: an argument array plus a wall-clock budget. */
export type RunConfigCommand = {
  readonly argv: readonly string[]
  readonly timeoutMs: number
}

/** A configured agent role: an exact model plus its invocation budget. */
export type RunConfigAgentRole = {
  readonly model: string
  readonly thinking: string
  readonly timeoutMs: number
}

/** Explicit extra environment entries applied to every child agent pane. */
export type RunConfigAgentEnvironment = Readonly<Record<string, string>>

/** The one resolved Run Config document every invocation recomputes (§8). */
export type ResolvedRunConfig = {
  readonly schema: typeof RUN_CONFIG_SCHEMA
  readonly targetBranch: string
  readonly setup: readonly RunConfigCommand[]
  readonly tests: readonly RunConfigCommand[]
  readonly maxWorkRounds: number
  readonly maxPushRetries: number
  readonly concurrency: number
  readonly agentEnv: RunConfigAgentEnvironment
  readonly worker: RunConfigAgentRole
  readonly reviewer: RunConfigAgentRole
  readonly trustedEvidenceAuthorIds: readonly string[]
}

export type RunConfigResolution = {
  readonly config: ResolvedRunConfig
  readonly configRevision: Sha256Digest
}

/**
 * Resolves one `provider/model` ID to its provider family against the
 * authenticated model catalog. `undefined` means the model is not in the
 * catalog. Callers supply the catalog; this module stays pure.
 */
export type ModelFamilyResolver = (modelId: string) => { readonly family: string } | undefined

export type RunConfigResolveBlockCode = 'invalid-config'

export type RunConfigResolveOutcome = Outcome<RunConfigResolution, RunConfigResolveBlockCode, never>

/**
 * Every default of the schema, as a fixed constant (§8). No default is ever
 * derived from repository, remote, or environment state; such facts are
 * captured explicitly by `/norn init` instead. `setup` and `agentEnv` default
 * to empty collections, so they have no scalar constants here.
 */
export const RUN_CONFIG_DEFAULTS = Object.freeze({
  maxWorkRounds: 3,
  maxPushRetries: 2,
  concurrency: 4,
} as const)

/**
 * Fixed suggested values `/norn init` offers for choices the schema itself
 * gives no default. These are suggestions only: the operator's recorded answer
 * is always explicit, and resolution never consults these constants.
 */
export const SUGGESTED_COMMAND_TIMEOUT_MS = 120_000
export const SUGGESTED_WORKER_TIMEOUT_MS = 3_600_000
export const SUGGESTED_REVIEWER_TIMEOUT_MS = 1_800_000

const TOP_LEVEL_KEYS = [
  'schema',
  'targetBranch',
  'setup',
  'tests',
  'maxWorkRounds',
  'maxPushRetries',
  'concurrency',
  'agentEnv',
  'worker',
  'reviewer',
  'trustedEvidenceAuthorIds',
] as const

const COMMAND_KEYS = ['argv', 'timeoutMs'] as const
const AGENT_ROLE_KEYS = ['model', 'thinking', 'timeoutMs'] as const
/**
 * Names `agentEnv` may never set: the coordinator-owned launch context, and
 * `__proto__`, which JSON parsing exposes as an own property but a plain-object
 * environment merge would silently drop.
 */
const RESERVED_AGENT_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  'NORN_AGENT_CONTEXT',
  '__proto__',
])
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  violations: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) violations.push(`${where} has unknown field "${key}"`)
  }
}

/** Sanity subset of git branch-name rules; existence is preflight's concern. */
function checkTargetBranch(value: unknown, violations: string[]): string | undefined {
  if (typeof value !== 'string') {
    violations.push('targetBranch must be a string')
    return undefined
  }
  if (value === '') {
    violations.push('targetBranch must not be empty')
    return undefined
  }
  if (/\s/.test(value) || /[\x00-\x1f\x7f]/.test(value)) {
    violations.push('targetBranch must not contain whitespace or control characters')
    return undefined
  }
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.lock')) {
    violations.push('targetBranch is not a plausible branch name')
    return undefined
  }
  if (value.includes('..') || value.includes('\\')) {
    violations.push('targetBranch is not a plausible branch name')
    return undefined
  }
  return value
}

function checkCommandEntry(value: unknown, where: string, violations: string[]): RunConfigCommand | undefined {
  if (!isPlainObject(value)) {
    violations.push(`${where} must be an object`)
    return undefined
  }
  checkKeys(value, COMMAND_KEYS, where, violations)
  const { argv, timeoutMs } = value

  let validArgv: readonly string[] | undefined
  if (!Array.isArray(argv) || argv.length === 0) {
    violations.push(`${where}.argv must be a non-empty array`)
  } else if (!argv.every((element) => typeof element === 'string')) {
    violations.push(`${where}.argv must contain only strings`)
  } else {
    validArgv = argv
  }

  let validTimeout: number | undefined
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    violations.push(`${where}.timeoutMs must be a number greater than 0`)
  } else {
    validTimeout = timeoutMs
  }

  if (validArgv === undefined || validTimeout === undefined) return undefined
  return { argv: validArgv, timeoutMs: validTimeout }
}

function checkCommandList(
  value: unknown,
  field: 'setup' | 'tests',
  violations: string[],
): readonly RunConfigCommand[] | undefined {
  if (!Array.isArray(value)) {
    violations.push(`${field} must be an array of command entries`)
    return undefined
  }
  if (field === 'tests' && value.length === 0) {
    violations.push('tests must contain at least one command entry')
  }
  const entries: RunConfigCommand[] = []
  let allValid = true
  value.forEach((entry, index) => {
    const checked = checkCommandEntry(entry, `${field}[${index}]`, violations)
    if (checked === undefined) allValid = false
    else entries.push(checked)
  })
  return allValid ? entries : undefined
}

function checkOptionalInteger(
  value: unknown,
  field: 'maxWorkRounds' | 'maxPushRetries' | 'concurrency',
  minimum: number,
  violations: string[],
): number | undefined {
  if (value === undefined) return RUN_CONFIG_DEFAULTS[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    violations.push(`${field} must be an integer >= ${minimum}`)
    return undefined
  }
  return value
}

function checkAgentEnvironment(
  value: unknown,
  violations: string[],
): RunConfigAgentEnvironment | undefined {
  if (value === undefined) return {}
  if (!isPlainObject(value)) {
    violations.push('agentEnv must be an object mapping environment names to string values')
    return undefined
  }

  let allValid = true
  const entries: Array<readonly [string, string]> = []
  for (const name of Object.keys(value).sort(compareUtf16CodeUnits)) {
    const environmentValue = value[name]
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
      violations.push(`agentEnv has invalid environment name "${name}"`)
      allValid = false
    }
    if (RESERVED_AGENT_ENVIRONMENT_NAMES.has(name)) {
      violations.push(`agentEnv cannot set reserved environment name "${name}"`)
      allValid = false
    }
    if (isDeniedEnvironmentName(name)) {
      violations.push(`agentEnv cannot set denied credential environment name "${name}"`)
      allValid = false
    }
    if (typeof environmentValue !== 'string') {
      violations.push(`agentEnv.${name} must be a string`)
      allValid = false
    } else if (environmentValue.includes('\0')) {
      violations.push(`agentEnv.${name} must not contain a NUL character`)
      allValid = false
    } else {
      entries.push([name, environmentValue])
    }
  }
  return allValid ? Object.fromEntries(entries) : undefined
}

function checkAgentRole(
  value: unknown,
  field: 'worker' | 'reviewer',
  violations: string[],
): RunConfigAgentRole | undefined {
  if (!isPlainObject(value)) {
    violations.push(`${field} must be an agent role object`)
    return undefined
  }
  checkKeys(value, AGENT_ROLE_KEYS, field, violations)
  const { model, thinking, timeoutMs } = value

  let validModel: string | undefined
  if (typeof model !== 'string' || model === '') {
    violations.push(`${field}.model must be a non-empty string`)
  } else {
    validModel = model
  }

  let validThinking: string | undefined
  if (typeof thinking !== 'string' || thinking === '') {
    violations.push(`${field}.thinking must be a non-empty string`)
  } else {
    validThinking = thinking
  }

  let validTimeout: number | undefined
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    violations.push(`${field}.timeoutMs must be a number greater than 0`)
  } else {
    validTimeout = timeoutMs
  }

  if (validModel === undefined || validThinking === undefined || validTimeout === undefined) {
    return undefined
  }
  return { model: validModel, thinking: validThinking, timeoutMs: validTimeout }
}

function checkTrustedEvidenceAuthorIds(
  value: unknown,
  violations: string[],
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    violations.push('trustedEvidenceAuthorIds must be an array with at least one ID')
    return undefined
  }
  const ids: string[] = []
  let allValid = true
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry === '') {
      violations.push(`trustedEvidenceAuthorIds[${index}] must be a non-empty string`)
      allValid = false
    } else {
      ids.push(entry)
    }
  })
  if (!allValid) return undefined
  const sorted = [...ids].sort(compareUtf16CodeUnits)
  if (sorted.some((id, index) => index > 0 && sorted[index - 1] === id)) {
    violations.push('trustedEvidenceAuthorIds must not contain duplicates')
    return undefined
  }
  // Authorship is a set: identity hashing and file writes use one canonical
  // order so equivalent choices cannot produce different revisions.
  return sorted
}

/**
 * Validate and expand one parsed `config.json` value into the resolved Run
 * Config document and its `configRevision`. All independently discoverable
 * violations are reported together. When `resolveModelFamily` is supplied,
 * both agent models must exist in the catalog and resolve to different
 * provider families (§8); violations are `blocked(invalid-config)`.
 */
export function resolveRunConfig(
  input: unknown,
  resolveModelFamily?: ModelFamilyResolver,
): RunConfigResolveOutcome {
  const violations: string[] = []

  if (!isPlainObject(input)) {
    return invalidConfig(['config.json must contain a JSON object'])
  }
  checkKeys(input, TOP_LEVEL_KEYS, 'config', violations)

  if (input.schema !== RUN_CONFIG_SCHEMA) {
    violations.push(`schema must be "${RUN_CONFIG_SCHEMA}"`)
  }

  const targetBranch = checkTargetBranch(input.targetBranch, violations)
  const setup = input.setup === undefined ? [] : checkCommandList(input.setup, 'setup', violations)
  const tests = checkCommandList(input.tests, 'tests', violations)
  const maxWorkRounds = checkOptionalInteger(input.maxWorkRounds, 'maxWorkRounds', 1, violations)
  const maxPushRetries = checkOptionalInteger(input.maxPushRetries, 'maxPushRetries', 0, violations)
  const concurrency = checkOptionalInteger(input.concurrency, 'concurrency', 1, violations)
  const agentEnv = checkAgentEnvironment(input.agentEnv, violations)
  const worker = checkAgentRole(input.worker, 'worker', violations)
  const reviewer = checkAgentRole(input.reviewer, 'reviewer', violations)
  const trustedEvidenceAuthorIds = checkTrustedEvidenceAuthorIds(
    input.trustedEvidenceAuthorIds,
    violations,
  )

  if (resolveModelFamily !== undefined && worker !== undefined && reviewer !== undefined) {
    const workerFamily = resolveModelFamily(worker.model)
    if (workerFamily === undefined) {
      violations.push(`worker model "${worker.model}" is not in the authenticated model catalog`)
    }
    const reviewerFamily = resolveModelFamily(reviewer.model)
    if (reviewerFamily === undefined) {
      violations.push(`reviewer model "${reviewer.model}" is not in the authenticated model catalog`)
    } else if (workerFamily !== undefined && workerFamily.family === reviewerFamily.family) {
      violations.push(
        `worker and reviewer must resolve to different provider families (both are "${workerFamily.family}")`,
      )
    }
  }

  if (
    targetBranch === undefined ||
    setup === undefined ||
    tests === undefined ||
    maxWorkRounds === undefined ||
    maxPushRetries === undefined ||
    concurrency === undefined ||
    agentEnv === undefined ||
    worker === undefined ||
    reviewer === undefined ||
    trustedEvidenceAuthorIds === undefined ||
    violations.length > 0
  ) {
    return invalidConfig(violations)
  }

  const config: ResolvedRunConfig = {
    schema: RUN_CONFIG_SCHEMA,
    targetBranch,
    setup,
    tests,
    maxWorkRounds,
    maxPushRetries,
    concurrency,
    agentEnv,
    worker,
    reviewer,
    trustedEvidenceAuthorIds,
  }
  return ok({ config, configRevision: runConfigRevision(config) })
}

/** Parse `config.json` text and resolve it; malformed JSON is invalid-config. */
export function resolveRunConfigText(
  text: string,
  resolveModelFamily?: ModelFamilyResolver,
): RunConfigResolveOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    return invalidConfig([
      `config.json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    ])
  }
  return resolveRunConfig(parsed, resolveModelFamily)
}

/** `configRevision` of a resolved document: SHA-256 over its canonical JSON. */
export function runConfigRevision(config: ResolvedRunConfig): Sha256Digest {
  return canonicalJsonDigest(config as CanonicalJsonValue)
}

/**
 * Serialize a resolved Run Config document for `config.json` or display, with
 * fields in the §8 document order. Storage is human-editable JSON; identity
 * comes from the canonical encoding used for the revision, not this text.
 */
export function runConfigToJson(config: ResolvedRunConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

function invalidConfig(violations: readonly string[]): RunConfigResolveOutcome {
  return blocked({
    scope: 'operation',
    code: 'invalid-config',
    reason:
      violations.length === 0
        ? 'run config is invalid'
        : `run config is invalid: ${violations.join('; ')}`,
    sharedWrite: 'none',
    evidence: [{ violations: [...violations] }],
  })
}
