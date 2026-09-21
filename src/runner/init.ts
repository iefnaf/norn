/**
 * `/norn init` (design.md §2.3, §8): deterministic repository setup.
 *
 * The operation resolves the repository root and the stable GitHub repository
 * identity — requiring explicit operator selection when multiple remotes are
 * plausible — then collects typed operator choices for the Run Config,
 * validates them against the authenticated model catalog, and writes
 * `metadata.json` and `config.json` under repository home in Norn home. No LLM
 * is asked to invent configuration, and nothing is written inside the target
 * repository's working tree.
 *
 * All policy lives here. The typed interaction contract below crosses the
 * extension boundary: the extension renders each question with its dialogs and
 * returns the operator's answer as data (or `undefined` for cancellation), so
 * this logic is fully testable headlessly with scripted answers.
 */
import { compareUtf16CodeUnits } from '../core/canonical-json.ts'
import { blocked, error, ok } from '../core/outcome.ts'
import type { Outcome } from '../core/outcome.ts'
import type { GitRemote, GitRepositoryAdapter } from '../adapters/git-repository.ts'
import { parseGitRemoteUrl } from '../adapters/git-repository.ts'
import type {
  GitHubGatewayAdapter,
  GitHubActor,
  ResolvedGitHubRepository,
} from '../adapters/github-gateway.ts'
import type { CatalogModel, ModelCatalogAdapter, ThinkingLevel } from '../adapters/model-catalog.ts'
import { modelFamilyResolver } from '../adapters/model-catalog.ts'
import type { LocalControlStore, RepositoryMetadata } from '../control/control-store.ts'
import { REPOSITORY_METADATA_SCHEMA } from '../control/control-store.ts'
import type {
  ResolvedRunConfig,
  RunConfigResolution,
} from '../config/run-config.ts'
import {
  RUN_CONFIG_DEFAULTS,
  RUN_CONFIG_SCHEMA,
  SUGGESTED_REVIEWER_TIMEOUT_MS,
  SUGGESTED_WORKER_TIMEOUT_MS,
  resolveRunConfig,
  resolveRunConfigText,
  runConfigToJson,
} from '../config/run-config.ts'
import type { Sha256Digest } from '../core/digest.ts'

/** One plausible GitHub repository identity reachable from local remotes. */
export type PlausibleRepositoryRemote = {
  readonly githubHost: string
  readonly owner: string
  readonly name: string
  /** Local remote names pointing at this identity, sorted. */
  readonly remoteNames: readonly string[]
}

/** A typed operator answer for one configured command. */
export type CommandSpecInput = {
  readonly argv: readonly string[]
  readonly timeoutMs: number
}

/** A typed operator answer for one agent role. */
export type AgentRoleInput = {
  readonly model: string
  readonly thinking: string
  readonly timeoutMs: number
}

/**
 * The typed choice contract crossing the extension boundary (§6). Every method
 * receives complete question data and returns the operator's answer as data;
 * `undefined` means the operator cancelled the dialog. The extension owns no
 * policy: it renders the question and parses operator input into these
 * shapes, while validation of every answer happens in this module.
 */
export type InitInteraction = {
  /** Explicit selection among plausible GitHub remotes (§2.3). */
  selectRepositoryIdentity(
    options: readonly PlausibleRepositoryRemote[],
  ): Promise<PlausibleRepositoryRemote | undefined>
  /** Target branch; the remote default branch is offered as the suggestion. */
  chooseTargetBranch(suggested: string): Promise<string | undefined>
  /** Zero or more setup commands (`setup`) or one or more test commands (`tests`). */
  chooseCommandList(kind: 'setup' | 'tests'): Promise<readonly CommandSpecInput[] | undefined>
  /** Exact model, thinking level, and invocation budget for one agent role. */
  chooseAgentRole(
    role: 'worker' | 'reviewer',
    models: readonly CatalogModel[],
    suggestedTimeoutMs: number,
  ): Promise<AgentRoleInput | undefined>
  /** One attempt limit or the concurrency value, with its fixed suggestion. */
  chooseInteger(
    field: 'maxWorkRounds' | 'maxPushRetries' | 'concurrency',
    suggested: number,
    minimum: number,
  ): Promise<number | undefined>
  /** Additional trusted evidence author IDs beyond the authenticated actor. */
  chooseTrustedEvidenceAuthors(actor: GitHubActor): Promise<readonly string[] | undefined>
  /** Show existing configuration and the proposed replacement; confirm. */
  confirmReplaceConfig(
    existing: { readonly configJson: string; readonly metadataJson: string | undefined },
    proposed: { readonly configJson: string; readonly metadataJson: string },
  ): Promise<boolean>
}

export type InitBlockCode =
  | 'not-a-repository'
  | 'no-github-remote'
  | 'repository-not-found'
  | 'github-unauthenticated'
  | 'config-in-use'
  | 'invalid-choice'
  | 'operator-cancelled'

export type InitErrorCode =
  | 'git-unavailable'
  | 'git-failed'
  | 'github-unavailable'
  | 'model-catalog-unavailable'
  | 'control-store'

export type InitReport = {
  readonly repositoryHome: string
  readonly repository: ResolvedGitHubRepository
  readonly metadata: RepositoryMetadata
  readonly config: ResolvedRunConfig
  readonly configRevision: Sha256Digest
  readonly replacedExistingConfig: boolean
}

export type InitOutcome = Outcome<InitReport, InitBlockCode, InitErrorCode>

export type InitDeps = {
  /** Working directory the operator invoked `/norn init` from. */
  readonly cwd: string
  readonly git: GitRepositoryAdapter
  readonly gateway: GitHubGatewayAdapter
  readonly catalog: ModelCatalogAdapter
  readonly store: LocalControlStore
  readonly interaction: InitInteraction
}

/**
 * Group local remotes into plausible GitHub repository identities: every
 * parseable remote URL contributes, duplicates that resolve to the same
 * host/owner/name merge, and the result is deterministically ordered. The
 * gateway later proves each identity against GitHub.
 */
export function plausibleRemoteIdentities(
  remotes: readonly GitRemote[],
): readonly PlausibleRepositoryRemote[] {
  const groups = new Map<string, PlausibleRepositoryRemote>()
  for (const remote of remotes) {
    const parsed = parseGitRemoteUrl(remote.url)
    if (parsed === undefined) continue
    const key = `${parsed.host}\u0000${parsed.owner}/${parsed.name}`
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        githubHost: parsed.host,
        owner: parsed.owner,
        name: parsed.name,
        remoteNames: [remote.name],
      })
    } else if (!existing.remoteNames.includes(remote.name)) {
      groups.set(key, {
        ...existing,
        remoteNames: [...existing.remoteNames, remote.name].sort(compareUtf16CodeUnits),
      })
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      compareUtf16CodeUnits(a.githubHost, b.githubHost) ||
      compareUtf16CodeUnits(a.owner, b.owner) ||
      compareUtf16CodeUnits(a.name, b.name),
  )
}

/** Everything `/norn init` asked for, as typed data. */
type InitAnswers = {
  readonly targetBranch: string
  readonly setup: readonly CommandSpecInput[]
  readonly tests: readonly CommandSpecInput[]
  readonly worker: AgentRoleInput
  readonly reviewer: AgentRoleInput
  readonly maxWorkRounds: number
  readonly maxPushRetries: number
  readonly concurrency: number
  readonly trustedEvidenceAuthorIds: readonly string[]
}

/** Run the whole `/norn init` flow; every step returns a typed outcome. */
export async function initRepository(deps: InitDeps): Promise<InitOutcome> {
  const root = await deps.git.resolveRoot(deps.cwd)
  if (root.kind !== 'ok') {
    const { code, reason } = root
    if (code === 'not-a-repository') {
      return blocked({
        scope: 'operation',
        code: 'not-a-repository',
        reason: `${deps.cwd} is not inside a Git repository`,
      })
    }
    return error({ scope: 'operation', code, reason })
  }

  const remotes = await deps.git.listRemotes(root.value)
  if (remotes.kind !== 'ok') {
    const { code, reason } = remotes
    // `listRemotes` cannot genuinely report not-a-repository after the root
    // resolved; if git claims so anyway, that is a git failure.
    return error({
      scope: 'operation',
      code: code === 'not-a-repository' ? 'git-failed' : code,
      reason,
    })
  }

  const plausible = plausibleRemoteIdentities(remotes.value)
  if (plausible.length === 0) {
    return blocked({
      scope: 'operation',
      code: 'no-github-remote',
      reason: 'the repository has no parseable GitHub remotes',
    })
  }

  const selectedRemote =
    plausible.length === 1
      ? plausible[0]
      : await deps.interaction.selectRepositoryIdentity(plausible)
  if (selectedRemote === undefined) {
    return blocked({
      scope: 'operation',
      code: 'operator-cancelled',
      reason: 'operator cancelled remote selection',
    })
  }

  const repository = await deps.gateway.resolveRepository({
    githubHost: selectedRemote.githubHost,
    owner: selectedRemote.owner,
    name: selectedRemote.name,
  })
  if (repository.kind !== 'ok') {
    return repository.kind === 'blocked'
      ? blocked({
          scope: 'operation',
          code: repository.code,
          reason: repository.reason,
          sharedWrite: repository.sharedWrite,
          evidence: repository.evidence,
        })
      : error({ scope: 'operation', code: repository.code, reason: repository.reason })
  }

  const actor = await deps.gateway.authenticatedActor(repository.value.githubHost)
  if (actor.kind !== 'ok') {
    return error({ scope: 'operation', code: actor.code, reason: actor.reason })
  }

  const models = await deps.catalog.listModels()
  if (models.kind !== 'ok') {
    return error({ scope: 'operation', code: models.code, reason: models.reason })
  }

  const home = deps.store.repositoryHome(repository.value)

  const existingConfigText = await deps.store.readConfigText(home)
  if (existingConfigText.kind !== 'ok') {
    return error({ scope: 'operation', code: 'control-store', reason: existingConfigText.reason })
  }

  // Refuse before any prompt: configuration shared by local checkouts and
  // active runs must not change under a running executor (§8).
  const activeRuns = await deps.store.findActiveRuns(home)
  if (activeRuns.kind !== 'ok') {
    return error({ scope: 'operation', code: 'control-store', reason: activeRuns.reason })
  }
  if (activeRuns.value.activeRunMaps.length > 0) {
    return blocked({
      scope: 'operation',
      code: 'config-in-use',
      reason: `a run is still active for ${activeRuns.value.activeRunMaps.join(', ')}`,
      evidence: [{ activeRunMaps: [...activeRuns.value.activeRunMaps] }],
    })
  }

  const answers = await askInitChoices(deps.interaction, repository.value, actor.value, models.value)
  if (answers.kind !== 'ok') return answers

  const validated = validateAnswersAndBuildConfig(answers.value, actor.value, models.value)
  if (validated.kind !== 'ok') return validated

  const metadata: RepositoryMetadata = {
    schema: REPOSITORY_METADATA_SCHEMA,
    githubHost: repository.value.githubHost,
    repositoryId: repository.value.repositoryId,
    owner: repository.value.owner,
    name: repository.value.name,
    defaultBranch: repository.value.defaultBranch,
  }

  const proposedConfigJson = runConfigToJson(validated.value.config)
  const proposedMetadataJson = `${JSON.stringify(metadata, null, 2)}\n`
  const replacedExistingConfig = existingConfigText.value !== undefined

  if (replacedExistingConfig) {
    const existingMetadataText = await deps.store.readMetadataText(home)
    if (existingMetadataText.kind !== 'ok') {
      return error({ scope: 'operation', code: 'control-store', reason: existingMetadataText.reason })
    }
    const confirmed = await deps.interaction.confirmReplaceConfig(
      { configJson: existingConfigText.value!, metadataJson: existingMetadataText.value },
      { configJson: proposedConfigJson, metadataJson: proposedMetadataJson },
    )
    if (!confirmed) {
      return blocked({
        scope: 'operation',
        code: 'operator-cancelled',
        reason: 'operator declined to replace the existing configuration',
      })
    }
  }

  const written = await deps.store.writeRepositorySetup(home, {
    metadataJson: proposedMetadataJson,
    configJson: proposedConfigJson,
  })
  if (written.kind !== 'ok') {
    return error({ scope: 'operation', code: 'control-store', reason: written.reason })
  }

  // Prove what is on disk: reload and re-resolve the written configuration.
  const reload = await deps.store.readConfigText(home)
  if (reload.kind !== 'ok') {
    return error({ scope: 'operation', code: 'control-store', reason: reload.reason })
  }
  const reloaded = resolveRunConfigText(reload.value ?? '')
  if (
    reloaded.kind !== 'ok' ||
    reloaded.value.configRevision !== validated.value.configRevision
  ) {
    return error({
      scope: 'operation',
      code: 'control-store',
      reason: 'the written config.json did not re-resolve to the validated document',
    })
  }

  return ok({
    repositoryHome: home,
    repository: repository.value,
    metadata,
    config: validated.value.config,
    configRevision: validated.value.configRevision,
    replacedExistingConfig,
  })
}

async function askInitChoices(
  interaction: InitInteraction,
  repository: ResolvedGitHubRepository,
  actor: GitHubActor,
  models: readonly CatalogModel[],
): Promise<Outcome<InitAnswers, 'operator-cancelled', never>> {
  const targetBranch = await interaction.chooseTargetBranch(repository.defaultBranch)
  if (targetBranch === undefined) return cancelled('target branch')

  const setup = await interaction.chooseCommandList('setup')
  if (setup === undefined) return cancelled('setup commands')

  const tests = await interaction.chooseCommandList('tests')
  if (tests === undefined) return cancelled('test commands')

  const worker = await interaction.chooseAgentRole('worker', models, SUGGESTED_WORKER_TIMEOUT_MS)
  if (worker === undefined) return cancelled('worker role')

  const reviewer = await interaction.chooseAgentRole('reviewer', models, SUGGESTED_REVIEWER_TIMEOUT_MS)
  if (reviewer === undefined) return cancelled('reviewer role')

  const maxWorkRounds = await interaction.chooseInteger(
    'maxWorkRounds',
    RUN_CONFIG_DEFAULTS.maxWorkRounds,
    1,
  )
  if (maxWorkRounds === undefined) return cancelled('maxWorkRounds')

  const maxPushRetries = await interaction.chooseInteger(
    'maxPushRetries',
    RUN_CONFIG_DEFAULTS.maxPushRetries,
    0,
  )
  if (maxPushRetries === undefined) return cancelled('maxPushRetries')

  const concurrency = await interaction.chooseInteger(
    'concurrency',
    RUN_CONFIG_DEFAULTS.concurrency,
    1,
  )
  if (concurrency === undefined) return cancelled('concurrency')

  const additionalTrustedAuthors = await interaction.chooseTrustedEvidenceAuthors(actor)
  if (additionalTrustedAuthors === undefined) return cancelled('trusted evidence authors')

  return ok({
    targetBranch,
    setup,
    tests,
    worker,
    reviewer,
    maxWorkRounds,
    maxPushRetries,
    concurrency,
    trustedEvidenceAuthorIds: additionalTrustedAuthors,
  })
}

function cancelled(what: string): Outcome<never, 'operator-cancelled', never> {
  return blocked({
    scope: 'operation',
    code: 'operator-cancelled',
    reason: `operator cancelled choosing the ${what}`,
  })
}

type ValidatedConfig = RunConfigResolution

/**
 * Validate every typed answer and build the Run Config document. Catalog
 * membership and supported thinking levels are checked against the model
 * snapshot; the assembled document then goes through the same resolver used
 * on every load, so an init-written config is valid by construction under the
 * identical rules (§8), including Worker/Reviewer family divergence.
 */
function validateAnswersAndBuildConfig(
  answers: InitAnswers,
  actor: GitHubActor,
  models: readonly CatalogModel[],
): Outcome<ValidatedConfig, 'invalid-choice', never> {
  const violations: string[] = []

  const workerModel = checkRoleChoice('worker', answers.worker, models, violations)
  const reviewerModel = checkRoleChoice('reviewer', answers.reviewer, models, violations)
  if (workerModel !== undefined && reviewerModel !== undefined) {
    if (workerModel.family === reviewerModel.family) {
      violations.push(
        `worker and reviewer must use different provider families (both selected "${workerModel.family}")`,
      )
    }
  }

  const additionalAuthors = new Set<string>()
  for (const id of answers.trustedEvidenceAuthorIds) {
    if (typeof id !== 'string' || id.trim() === '') {
      violations.push('trusted evidence author IDs must be non-empty')
    } else if (additionalAuthors.has(id)) {
      violations.push(`trusted evidence author ID "${id}" was given more than once`)
    } else {
      additionalAuthors.add(id)
    }
  }

  // The actor is always trusted (§8); an operator repeating the actor ID is
  // deduplicated rather than rejected — only genuine duplicates among the
  // additional choices are invalid.
  const document = {
    schema: RUN_CONFIG_SCHEMA,
    targetBranch: answers.targetBranch,
    setup: answers.setup,
    tests: answers.tests,
    maxWorkRounds: answers.maxWorkRounds,
    maxPushRetries: answers.maxPushRetries,
    concurrency: answers.concurrency,
    worker: answers.worker,
    reviewer: answers.reviewer,
    trustedEvidenceAuthorIds: [...new Set([actor.id, ...additionalAuthors])],
  }

  const resolved = resolveRunConfig(document, modelFamilyResolver(models))
  const resolverViolations: readonly string[] =
    resolved.kind === 'blocked'
      ? ((resolved.evidence[0] as { violations?: string[] } | undefined)?.violations ?? [])
      : []
  const allViolations = [...violations, ...resolverViolations]
  if (resolved.kind === 'ok' && allViolations.length === 0) {
    return resolved
  }
  // Report every independently discoverable violation together, like check
  // does (§2.3), so one bad answer surfaces the full picture.
  return blocked({
    scope: 'operation',
    code: 'invalid-choice',
    reason:
      allViolations.length === 0
        ? 'invalid operator choice'
        : `invalid operator choice: ${allViolations.join('; ')}`,
    evidence: [{ violations: [...allViolations] }],
  })
}

function checkRoleChoice(
  role: 'worker' | 'reviewer',
  choice: AgentRoleInput,
  models: readonly CatalogModel[],
  violations: string[],
): CatalogModel | undefined {
  const model = models.find((candidate) => candidate.id === choice.model)
  if (model === undefined) {
    violations.push(`${role} model "${choice.model}" is not in the authenticated model catalog`)
    return undefined
  }
  if (!model.thinkingLevels.includes(choice.thinking as ThinkingLevel)) {
    violations.push(
      `${role} thinking level "${choice.thinking}" is not supported by ${model.id}`,
    )
  }
  return model
}
