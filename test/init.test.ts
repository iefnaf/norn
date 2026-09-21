import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { isBlocked, isError, isOk } from '../src/core/outcome.ts'
import { fsControlStore, loadRunConfig } from '../src/control/control-store.ts'
import type { LocalControlStore } from '../src/control/control-store.ts'
import type { GitRemote, GitRepositoryAdapter } from '../src/adapters/git-repository.ts'
import type {
  GitHubGatewayAdapter,
  ResolvedGitHubRepository,
} from '../src/adapters/github-gateway.ts'
import { blocked, error, ok } from '../src/core/outcome.ts'
import type { CatalogModel, ModelCatalogAdapter } from '../src/adapters/model-catalog.ts'
import { initRepository, plausibleRemoteIdentities } from '../src/runner/init.ts'
import { resolveNornHome } from '../src/config/paths.ts'
import type {
  AgentRoleInput,
  CommandSpecInput,
  InitDeps,
  InitInteraction,
  InitOutcome,
  PlausibleRepositoryRemote,
} from '../src/runner/init.ts'

const REPOSITORY: ResolvedGitHubRepository = {
  githubHost: 'github.com',
  repositoryId: 'R_kgDOB123',
  owner: 'iefnaf',
  name: 'norn',
  defaultBranch: 'main',
}

const ACTOR = { id: 'I_actor', login: 'operator' } as const

const MODELS: readonly CatalogModel[] = [
  { id: 'provider-a/model-x', family: 'provider-a', displayName: 'Model X', thinkingLevels: ['off', 'medium', 'high'] },
  { id: 'provider-a/model-z', family: 'provider-a', displayName: 'Model Z', thinkingLevels: ['off', 'low'] },
  { id: 'provider-b/model-y', family: 'provider-b', displayName: 'Model Y', thinkingLevels: ['off', 'high'] },
]

const WORKER: AgentRoleInput = { model: 'provider-a/model-x', thinking: 'medium', timeoutMs: 3_600_000 }
const REVIEWER: AgentRoleInput = { model: 'provider-b/model-y', thinking: 'high', timeoutMs: 1_800_000 }
const TESTS: readonly CommandSpecInput[] = [{ argv: ['npm', 'test'], timeoutMs: 120_000 }]

function fakeGit(root: string, remotes: readonly GitRemote[]): GitRepositoryAdapter {
  return {
    async resolveRoot(cwd: string) {
      return cwd === '/not-a-repository'
        ? error({ scope: 'operation', code: 'not-a-repository', reason: 'nope' })
        : ok(root)
    },
    async listRemotes() {
      return ok(remotes)
    },
  }
}

function fakeGateway(
  repositoryResult: 'ok' | 'not-found' | 'unauthenticated' | 'unavailable',
  actorResult: 'ok' | 'unavailable' = 'ok',
): GitHubGatewayAdapter {
  return {
    async resolveRepository() {
      if (repositoryResult === 'ok') return ok(REPOSITORY)
      if (repositoryResult === 'not-found') {
        return blocked({ scope: 'operation', code: 'repository-not-found', reason: 'gone' })
      }
      if (repositoryResult === 'unauthenticated') {
        return blocked({ scope: 'operation', code: 'github-unauthenticated', reason: 'gh auth login' })
      }
      return error({ scope: 'operation', code: 'github-unavailable', reason: 'network' })
    },
    async authenticatedActor() {
      return actorResult === 'ok'
        ? ok(ACTOR)
        : error({ scope: 'operation', code: 'github-unavailable', reason: 'network' })
    },
  }
}

function fakeCatalog(models: readonly CatalogModel[]): ModelCatalogAdapter {
  return {
    async listModels() {
      return models.length === 0
        ? error({ scope: 'operation', code: 'model-catalog-unavailable', reason: 'empty' })
        : ok(models)
    },
  }
}

type Recorder = {
  calls: string[]
  selected?: PlausibleRepositoryRemote
  confirmedExisting?: { configJson: string; metadataJson: string | undefined }
  confirmedProposed?: { configJson: string; metadataJson: string }
}

/** A successful default operator, with optional per-question overrides. */
function scriptedInteraction(
  recorder: Recorder,
  overrides: Partial<InitInteraction> = {},
): InitInteraction {
  const defaults: InitInteraction = {
    async selectRepositoryIdentity(options) {
      const selected = options[0]
      recorder.selected = selected
      return selected
    },
    async chooseTargetBranch(suggested) {
      return suggested
    },
    async chooseCommandList(kind) {
      return kind === 'setup' ? [] : TESTS
    },
    async chooseAgentRole(role) {
      return role === 'worker' ? WORKER : REVIEWER
    },
    async chooseInteger(field, suggested) {
      return suggested
    },
    async chooseTrustedEvidenceAuthors() {
      return []
    },
    async confirmReplaceConfig(existing, proposed) {
      recorder.confirmedExisting = existing
      recorder.confirmedProposed = proposed
      return true
    },
  }

  // Wrap every method so the recorder sees calls even for overridden
  // questions, keeping the call log complete for ordering assertions.
  const merged: InitInteraction = { ...defaults, ...overrides }
  const interaction = {} as Record<string, (...args: unknown[]) => Promise<unknown>>
  for (const key of Object.keys(defaults) as (keyof InitInteraction)[]) {
    const method = merged[key] as (...args: unknown[]) => Promise<unknown>
    interaction[key] = async (...args: unknown[]) => {
      recorder.calls.push(key)
      return method(...args)
    }
  }
  return interaction as unknown as InitInteraction
}

type Environment = {
  deps: InitDeps
  store: LocalControlStore
  home: string
  nornHome: string
  repoTree: string
  recorder: Recorder
  gatewayRequests: Array<{ githubHost: string; owner: string; name: string }>
}

function makeEnvironment(
  overrides: {
    remotes?: readonly GitRemote[]
    gateway?: GitHubGatewayAdapter
    catalog?: ModelCatalogAdapter
    store?: LocalControlStore
    interactionOverrides?: Partial<InitInteraction>
    existingRunStatus?: 'running' | 'terminal' | 'aborted'
    existingConfig?: object | null
  } = {},
): Environment {
  const nornHome = mkdtempSync(join(tmpdir(), 'norn-home-'))
  const repoTree = mkdtempSync(join(tmpdir(), 'norn-repo-'))
  const store = overrides.store ?? fsControlStore(nornHome)
  const recorder: Recorder = { calls: [] }
  const gateway = overrides.gateway ?? fakeGateway('ok')
  const gatewayRequests: Array<{ githubHost: string; owner: string; name: string }> = []
  const recordingGateway: GitHubGatewayAdapter = {
    async resolveRepository(ref) {
      gatewayRequests.push({ githubHost: ref.githubHost, owner: ref.owner, name: ref.name })
      return gateway.resolveRepository(ref)
    },
    async authenticatedActor(host) {
      return gateway.authenticatedActor(host)
    },
  }
  const deps: InitDeps = {
    cwd: repoTree,
    git: fakeGit(repoTree, overrides.remotes ?? [
      { name: 'origin', url: 'https://github.com/iefnaf/norn.git' },
    ]),
    gateway: recordingGateway,
    catalog: overrides.catalog ?? fakeCatalog(MODELS),
    store,
    interaction: scriptedInteraction(recorder, overrides.interactionOverrides),
  }
  const home = store.repositoryHome(REPOSITORY)

  if (overrides.existingConfig !== undefined && overrides.existingConfig !== null) {
    mkdirSync(home, { recursive: true })
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify(overrides.existingConfig, null, 2),
      'utf8',
    )
  }
  if (overrides.existingRunStatus !== undefined) {
    const mapDir = join(home, 'maps', 'I_map1')
    mkdirSync(mapDir, { recursive: true })
    writeFileSync(
      join(mapDir, 'run-state.json'),
      JSON.stringify({ schema: 'norn-run-state:v1', status: overrides.existingRunStatus }),
      'utf8',
    )
  }

  return { deps, store, home, nornHome, repoTree, recorder, gatewayRequests }
}

function listFilesRecursive(root: string, prefix = ''): string[] {
  const entries: string[] = []
  for (const name of readdirSync(join(root, prefix))) {
    const relative = prefix === '' ? name : `${prefix}/${name}`
    if (statSync(join(root, relative)).isDirectory()) {
      entries.push(...listFilesRecursive(root, relative))
    } else {
      entries.push(relative)
    }
  }
  return entries.sort()
}

function cleanup(environment: Environment): void {
  rmSync(environment.nornHome, { recursive: true, force: true })
  rmSync(environment.repoTree, { recursive: true, force: true })
}

describe('initRepository: successful setup', () => {
  it('writes metadata and a config with exactly the operator choices under repository home', async () => {
    const environment = makeEnvironment({
      interactionOverrides: {
        async chooseCommandList(kind) {
          return kind === 'setup'
            ? [{ argv: ['npm', 'ci'], timeoutMs: 180_000 }]
            : [{ argv: ['npm', 'run', 'check'], timeoutMs: 60_000 }]
        },
        async chooseInteger(field) {
          return field === 'maxWorkRounds' ? 5 : field === 'maxPushRetries' ? 0 : 8
        },
        async chooseTargetBranch() {
          return 'trunk'
        },
        async chooseTrustedEvidenceAuthors() {
          return ['I_zeta', 'I_alpha']
        },
      },
    })
    try {
      const outcome = await initRepository(environment.deps)
      assert.ok(isOk(outcome))
      if (outcome.kind !== 'ok') return

      assert.ok(existsSync(join(environment.home, 'metadata.json')))
      assert.ok(existsSync(join(environment.home, 'config.json')))

      const metadata = JSON.parse(readFileSync(join(environment.home, 'metadata.json'), 'utf8'))
      assert.deepEqual(metadata, {
        schema: 'norn-repository-metadata:v1',
        githubHost: 'github.com',
        repositoryId: 'R_kgDOB123',
        owner: 'iefnaf',
        name: 'norn',
        defaultBranch: 'main',
      })

      const config = JSON.parse(readFileSync(join(environment.home, 'config.json'), 'utf8'))
      assert.deepEqual(config, {
        schema: 'norn-run:v1',
        targetBranch: 'trunk',
        setup: [{ argv: ['npm', 'ci'], timeoutMs: 180_000 }],
        tests: [{ argv: ['npm', 'run', 'check'], timeoutMs: 60_000 }],
        maxWorkRounds: 5,
        maxPushRetries: 0,
        concurrency: 8,
        worker: WORKER,
        reviewer: REVIEWER,
        trustedEvidenceAuthorIds: ['I_actor', 'I_alpha', 'I_zeta'],
      })
      assert.equal(outcome.value.replacedExistingConfig, false)
      const loaded = await loadRunConfig(environment.store, environment.home)
      assert.ok(isOk(loaded))
      if (loaded.kind === 'ok') {
        assert.equal(outcome.value.configRevision, loaded.value.configRevision)
      }
    } finally {
      cleanup(environment)
    }
  })

  it('the repository home honors the Norn home the store was built with', async () => {
    const environment = makeEnvironment()
    try {
      const outcome = await initRepository(environment.deps)
      assert.ok(isOk(outcome))
      if (outcome.kind === 'ok') {
        assert.ok(outcome.value.repositoryHome.startsWith(environment.nornHome))
        assert.equal(
          outcome.value.repositoryHome,
          join(environment.nornHome, 'repositories', 'github.com', 'R_kgDOB123'),
        )
      }
    } finally {
      cleanup(environment)
    }
  })

  it('honors PI_CODING_AGENT_DIR end to end when the store root is derived from it', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'norn-agent-dir-'))
    const repoTree = mkdtempSync(join(tmpdir(), 'norn-repo-'))
    const store = fsControlStore(
      resolveNornHome({ PI_CODING_AGENT_DIR: agentDir }, '/unused-home'),
    )
    const recorder: Recorder = { calls: [] }
    try {
      const outcome = await initRepository({
        cwd: repoTree,
        git: fakeGit(repoTree, [{ name: 'origin', url: 'https://github.com/iefnaf/norn.git' }]),
        gateway: fakeGateway('ok'),
        catalog: fakeCatalog(MODELS),
        store,
        interaction: scriptedInteraction(recorder),
      })
      assert.ok(isOk(outcome))
      const expectedHome = join(agentDir, 'norn', 'repositories', 'github.com', 'R_kgDOB123')
      if (outcome.kind === 'ok') assert.equal(outcome.value.repositoryHome, expectedHome)
      assert.ok(existsSync(join(expectedHome, 'config.json')))
      assert.ok(existsSync(join(expectedHome, 'metadata.json')))
    } finally {
      rmSync(agentDir, { recursive: true, force: true })
      rmSync(repoTree, { recursive: true, force: true })
    }
  })

  it('the report revision equals the revision a later load recomputes', async () => {
    const environment = makeEnvironment()
    try {
      const outcome = await initRepository(environment.deps)
      const loaded = await loadRunConfig(environment.store, environment.home)
      assert.ok(isOk(loaded))
      if (outcome.kind === 'ok' && loaded.kind === 'ok') {
        assert.equal(outcome.value.configRevision, loaded.value.configRevision)
        assert.deepEqual(outcome.value.config, loaded.value.config)
      }
    } finally {
      cleanup(environment)
    }
  })

  it('creates nothing inside the target repository working tree', async () => {
    const environment = makeEnvironment()
    try {
      const before = listFilesRecursive(environment.repoTree)
      const outcome = await initRepository(environment.deps)
      assert.ok(isOk(outcome))
      assert.deepEqual(listFilesRecursive(environment.repoTree), before)
      assert.deepEqual(before, [])
    } finally {
      cleanup(environment)
    }
  })
})

describe('initRepository: remote identity resolution', () => {
  it('uses the single plausible remote without asking', async () => {
    const environment = makeEnvironment()
    try {
      const outcome = await initRepository(environment.deps)
      assert.ok(isOk(outcome))
      assert.equal(environment.recorder.calls.includes('selectRepositoryIdentity'), false)
    } finally {
      cleanup(environment)
    }
  })

  it('requires explicit selection when multiple remotes are plausible', async () => {
    const environment = makeEnvironment({
      remotes: [
        { name: 'origin', url: 'https://github.com/iefnaf/norn.git' },
        { name: 'upstream', url: 'git@github.com:other/project.git' },
      ],
      interactionOverrides: {
        async selectRepositoryIdentity(options) {
          return options.find((option) => option.name === 'project')
        },
      },
    })
    try {
      const outcome = await initRepository(environment.deps)
      assert.ok(isOk(outcome))
      assert.equal(environment.recorder.calls[0], 'selectRepositoryIdentity')
      // The operator's selection — not the first remote — reached the gateway.
      assert.deepEqual(environment.gatewayRequests, [
        { githubHost: 'github.com', owner: 'other', name: 'project' },
      ])
    } finally {
      cleanup(environment)
    }
  })

  it('cancelling remote selection blocks with operator-cancelled and writes nothing', async () => {
    const environment = makeEnvironment({
      remotes: [
        { name: 'origin', url: 'https://github.com/iefnaf/norn.git' },
        { name: 'upstream', url: 'https://github.com/other/project.git' },
      ],
      interactionOverrides: {
        async selectRepositoryIdentity() {
          return undefined
        },
      },
    })
    try {
      const outcome = await initRepository(environment.deps)
      assert.ok(isBlocked(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'operator-cancelled')
        assert.equal(outcome.scope, 'operation')
        assert.equal(outcome.sharedWrite, 'none')
      }
      assert.equal(existsSync(environment.home), false)
      assert.equal(environment.recorder.calls.length, 1)
    } finally {
      cleanup(environment)
    }
  })

  it('blocks when the repository has no plausible GitHub remotes', async () => {
    for (const remotes of [
      [],
      [{ name: 'local', url: '/srv/git/repo.git' }],
    ] as const) {
      const environment = makeEnvironment({ remotes })
      try {
        const outcome = await initRepository(environment.deps)
        assert.ok(isBlocked(outcome), JSON.stringify(remotes))
        if (outcome.kind === 'blocked') assert.equal(outcome.code, 'no-github-remote')
        assert.deepEqual(environment.recorder.calls, [])
      } finally {
        cleanup(environment)
      }
    }
  })
})

describe('initRepository: adapter failures map to typed outcomes', () => {
  async function expectBlocked(
    environment: Environment,
    code: string,
  ): Promise<void> {
    try {
      const outcome = await initRepository(environment.deps)
      assert.ok(isBlocked(outcome))
      if (outcome.kind === 'blocked') assert.equal(outcome.code, code)
      assert.equal(existsSync(environment.home), false)
    } finally {
      cleanup(environment)
    }
  }

  it('blocks not-a-repository before anything else', async () => {
    const nornHome = mkdtempSync(join(tmpdir(), 'norn-home-'))
    const repoTree = mkdtempSync(join(tmpdir(), 'norn-repo-'))
    try {
      const recorder: Recorder = { calls: [] }
      const deps: InitDeps = {
        cwd: '/not-a-repository',
        git: fakeGit(repoTree, []),
        gateway: fakeGateway('ok'),
        catalog: fakeCatalog(MODELS),
        store: fsControlStore(nornHome),
        interaction: scriptedInteraction(recorder),
      }
      const outcome = await initRepository(deps)
      assert.ok(isBlocked(outcome))
      if (outcome.kind === 'blocked') assert.equal(outcome.code, 'not-a-repository')
      assert.deepEqual(recorder.calls, [])
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
      rmSync(repoTree, { recursive: true, force: true })
    }
  })

  it('blocks repository-not-found from the gateway', async () => {
    await expectBlocked(makeEnvironment({ gateway: fakeGateway('not-found') }), 'repository-not-found')
  })

  it('blocks github-unauthenticated from the gateway', async () => {
    await expectBlocked(makeEnvironment({ gateway: fakeGateway('unauthenticated') }), 'github-unauthenticated')
  })

  it('errors when the gateway cannot establish facts', async () => {
    const environment = makeEnvironment({ gateway: fakeGateway('unavailable') })
    try {
      const outcome = await initRepository(environment.deps)
      assert.ok(isError(outcome))
      if (outcome.kind === 'error') assert.equal(outcome.code, 'github-unavailable')
    } finally {
      cleanup(environment)
    }
  })

  it('errors when the authenticated actor cannot be resolved', async () => {
    const environment = makeEnvironment({ gateway: fakeGateway('ok', 'unavailable') })
    try {
      const outcome = await initRepository(environment.deps)
      assert.ok(isError(outcome))
      if (outcome.kind === 'error') assert.equal(outcome.code, 'github-unavailable')
    } finally {
      cleanup(environment)
    }
  })

  it('errors when the model catalog is unavailable', async () => {
    const environment = makeEnvironment({ catalog: fakeCatalog([]) })
    try {
      const outcome = await initRepository(environment.deps)
      assert.ok(isError(outcome))
      if (outcome.kind === 'error') assert.equal(outcome.code, 'model-catalog-unavailable')
    } finally {
      cleanup(environment)
    }
  })

  it('errors when the control store cannot persist', async () => {
    const nornHome = mkdtempSync(join(tmpdir(), 'norn-home-'))
    const repoTree = mkdtempSync(join(tmpdir(), 'norn-repo-'))
    const failingStore: LocalControlStore = {
      ...fsControlStore(nornHome),
      async writeRepositorySetup() {
        return error({ scope: 'operation', code: 'control-store', reason: 'disk full' })
      },
    }
    try {
      const recorder: Recorder = { calls: [] }
      const deps: InitDeps = {
        cwd: repoTree,
        git: fakeGit(repoTree, [{ name: 'origin', url: 'https://github.com/iefnaf/norn.git' }]),
        gateway: fakeGateway('ok'),
        catalog: fakeCatalog(MODELS),
        store: failingStore,
        interaction: scriptedInteraction(recorder),
      }
      const outcome = await initRepository(deps)
      assert.ok(isError(outcome))
      if (outcome.kind === 'error') assert.equal(outcome.code, 'control-store')
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
      rmSync(repoTree, { recursive: true, force: true })
    }
  })
})

describe('initRepository: existing configuration', () => {
  const EXISTING_CONFIG = {
    schema: 'norn-run:v1',
    targetBranch: 'old-branch',
    tests: [{ argv: ['make', 'test'], timeoutMs: 60_000 }],
    worker: { model: 'provider-a/model-z', thinking: 'low', timeoutMs: 900_000 },
    reviewer: { model: 'provider-b/model-y', thinking: 'high', timeoutMs: 900_000 },
    trustedEvidenceAuthorIds: ['I_actor'],
  }

  it('shows the existing and proposed configuration and replaces it after confirmation', async () => {
    const environment = makeEnvironment({ existingConfig: EXISTING_CONFIG })
    try {
      const outcome = await initRepository(environment.deps)
      assert.ok(isOk(outcome))
      if (outcome.kind === 'ok') assert.equal(outcome.value.replacedExistingConfig, true)

      const { confirmedExisting, confirmedProposed } = environment.recorder
      assert.match(confirmedExisting?.configJson ?? '', /old-branch/)
      assert.match(confirmedProposed?.configJson ?? '', /"targetBranch": "main"/)
      assert.equal(environment.recorder.calls.includes('confirmReplaceConfig'), true)

      const config = JSON.parse(readFileSync(join(environment.home, 'config.json'), 'utf8'))
      assert.equal(config.targetBranch, 'main')
    } finally {
      cleanup(environment)
    }
  })

  it('declining the replacement blocks with operator-cancelled and keeps the file', async () => {
    const environment = makeEnvironment({
      existingConfig: EXISTING_CONFIG,
      interactionOverrides: {
        async confirmReplaceConfig() {
          return false
        },
      },
    })
    try {
      const outcome = await initRepository(environment.deps)
      assert.ok(isBlocked(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'operator-cancelled')
        assert.match(outcome.reason, /declined/)
      }
      const config = JSON.parse(readFileSync(join(environment.home, 'config.json'), 'utf8'))
      assert.equal(config.targetBranch, 'old-branch')
    } finally {
      cleanup(environment)
    }
  })

  it('blocks with config-in-use while any run is running, before any prompt', async () => {
    const environment = makeEnvironment({
      existingConfig: EXISTING_CONFIG,
      existingRunStatus: 'running',
    })
    try {
      const outcome = await initRepository(environment.deps)
      assert.ok(isBlocked(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'config-in-use')
        assert.equal(outcome.scope, 'operation')
        assert.equal(outcome.sharedWrite, 'none')
        assert.deepEqual((outcome.evidence[0] as { activeRunMaps: string[] }).activeRunMaps, ['I_map1'])
      }
      assert.deepEqual(environment.recorder.calls, [])
      const config = JSON.parse(readFileSync(join(environment.home, 'config.json'), 'utf8'))
      assert.equal(config.targetBranch, 'old-branch')
    } finally {
      cleanup(environment)
    }
  })

  it('allows replacement once runs reached terminal or aborted', async () => {
    for (const status of ['terminal', 'aborted'] as const) {
      const environment = makeEnvironment({
        existingConfig: EXISTING_CONFIG,
        existingRunStatus: status,
      })
      try {
        const outcome = await initRepository(environment.deps)
        assert.ok(isOk(outcome), status)
      } finally {
        cleanup(environment)
      }
    }
  })

  it('blocks config-in-use even when no config file exists yet', async () => {
    const environment = makeEnvironment({ existingRunStatus: 'running' })
    try {
      const outcome = await initRepository(environment.deps)
      assert.ok(isBlocked(outcome))
      if (outcome.kind === 'blocked') assert.equal(outcome.code, 'config-in-use')
      assert.deepEqual(environment.recorder.calls, [])
    } finally {
      cleanup(environment)
    }
  })
})

describe('initRepository: operator cancellations', () => {
  const CANCELLATIONS: Array<{ name: string; override: Partial<InitInteraction> }> = [
    {
      name: 'target branch',
      override: { async chooseTargetBranch() { return undefined } },
    },
    {
      name: 'setup commands',
      override: { async chooseCommandList() { return undefined } },
    },
    {
      name: 'test commands',
      override: { async chooseCommandList(kind) { return kind === 'tests' ? undefined : [] } },
    },
    {
      name: 'worker role',
      override: { async chooseAgentRole(role) { return role === 'worker' ? undefined : REVIEWER } },
    },
    {
      name: 'reviewer role',
      override: { async chooseAgentRole(role) { return role === 'reviewer' ? undefined : WORKER } },
    },
    {
      name: 'maxWorkRounds',
      override: { async chooseInteger(field, suggested) { return field === 'maxWorkRounds' ? undefined : suggested } },
    },
    {
      name: 'concurrency',
      override: { async chooseInteger(field, suggested) { return field === 'concurrency' ? undefined : suggested } },
    },
    {
      name: 'trusted evidence authors',
      override: { async chooseTrustedEvidenceAuthors() { return undefined } },
    },
  ]

  for (const cancellation of CANCELLATIONS) {
    it(`cancelling the ${cancellation.name} prompt blocks and writes nothing`, async () => {
      const environment = makeEnvironment({ interactionOverrides: cancellation.override })
      try {
        const outcome: InitOutcome = await initRepository(environment.deps)
        assert.ok(isBlocked(outcome), cancellation.name)
        if (outcome.kind === 'blocked') {
          assert.equal(outcome.code, 'operator-cancelled', cancellation.name)
        }
        assert.equal(existsSync(environment.home), false, cancellation.name)
      } finally {
        cleanup(environment)
      }
    })
  }
})

describe('initRepository: invalid choices', () => {
  type Case = { name: string; override: Partial<InitInteraction>; expect?: RegExp }

  const cases: Case[] = [
    {
      name: 'empty test list',
      override: { async chooseCommandList(kind) { return kind === 'setup' ? [] : [] } },
      expect: /at least one/,
    },
    {
      name: 'worker and reviewer in the same provider family',
      override: {
        async chooseAgentRole(role) {
          return role === 'worker'
            ? WORKER
            : { model: 'provider-a/model-z', thinking: 'low', timeoutMs: 900_000 }
        },
      },
      expect: /different provider families/,
    },
    {
      name: 'model not in the catalog',
      override: {
        async chooseAgentRole(role) {
          return role === 'worker'
            ? { model: 'provider-c/model-q', thinking: 'low', timeoutMs: 900_000 }
            : REVIEWER
        },
      },
      expect: /not in the authenticated model catalog/,
    },
    {
      name: 'unsupported thinking level',
      override: {
        async chooseAgentRole(role) {
          return role === 'worker'
            ? { model: 'provider-a/model-x', thinking: 'max', timeoutMs: 3_600_000 }
            : REVIEWER
        },
      },
      expect: /not supported/,
    },
    {
      name: 'malformed branch name',
      override: { async chooseTargetBranch() { return '-bad branch' } },
    },
    {
      name: 'empty branch name',
      override: { async chooseTargetBranch() { return '' } },
    },
    {
      name: 'non-integer attempt limit',
      override: { async chooseInteger(field, suggested) { return field === 'maxWorkRounds' ? 2.5 : suggested } },
    },
    {
      name: 'zero concurrency',
      override: { async chooseInteger(field, suggested) { return field === 'concurrency' ? 0 : suggested } },
    },
    {
      name: 'NaN timeout parsed from a blank dialog',
      override: {
        async chooseCommandList(kind) {
          return kind === 'setup' ? [] : [{ argv: ['npm', 'test'], timeoutMs: Number('abc') }]
        },
      },
    },
    {
      name: 'command with empty argv',
      override: {
        async chooseCommandList(kind) {
          return kind === 'setup' ? [{ argv: [], timeoutMs: 1000 }] : TESTS
        },
      },
      expect: /non-empty/,
    },
    {
      name: 'empty trusted author id',
      override: { async chooseTrustedEvidenceAuthors() { return ['I_x', ''] } },
    },
    {
      name: 'duplicate trusted author ids',
      override: { async chooseTrustedEvidenceAuthors() { return ['I_x', 'I_x'] } },
      expect: /more than once/,
    },
  ]

  for (const testCase of cases) {
    it(`blocks invalid choice: ${testCase.name}`, async () => {
      const environment = makeEnvironment({ interactionOverrides: testCase.override })
      try {
        const outcome = await initRepository(environment.deps)
        assert.ok(isBlocked(outcome), testCase.name)
        if (outcome.kind === 'blocked') {
          assert.equal(outcome.code, 'invalid-choice', testCase.name)
          assert.equal(outcome.scope, 'operation')
          if (testCase.expect !== undefined) {
            assert.match(outcome.reason, testCase.expect, testCase.name)
          }
        }
        assert.equal(existsSync(environment.home), false, testCase.name)
      } finally {
        cleanup(environment)
      }
    })
  }
})

describe('initRepository: trusted evidence authors', () => {
  it('always includes the authenticated actor, in canonical order', async () => {
    const environment = makeEnvironment({
      interactionOverrides: {
        async chooseTrustedEvidenceAuthors() {
          return ['I_zeta', 'I_beta']
        },
      },
    })
    try {
      const outcome = await initRepository(environment.deps)
      assert.ok(isOk(outcome))
      if (outcome.kind === 'ok') {
        assert.deepEqual(outcome.value.config.trustedEvidenceAuthorIds, [
          'I_actor',
          'I_beta',
          'I_zeta',
        ])
      }
    } finally {
      cleanup(environment)
    }
  })

  it('the actor id may be repeated by the operator without becoming invalid', async () => {
    const environment = makeEnvironment({
      interactionOverrides: {
        async chooseTrustedEvidenceAuthors() {
          return [ACTOR.id]
        },
      },
    })
    try {
      const outcome = await initRepository(environment.deps)
      assert.ok(isOk(outcome))
      if (outcome.kind === 'ok') {
        assert.deepEqual(outcome.value.config.trustedEvidenceAuthorIds, ['I_actor'])
      }
    } finally {
      cleanup(environment)
    }
  })
})

describe('plausibleRemoteIdentities (exported helper)', () => {
  it('groups by host/owner/name and returns sorted remote names', () => {
    const identities = plausibleRemoteIdentities([
      { name: 'origin', url: 'https://github.com/o/r.git' },
      { name: 'backup', url: 'git@github.com:o/r.git' },
    ])
    assert.equal(identities.length, 1)
    assert.deepEqual(identities[0]!.remoteNames, ['backup', 'origin'])
  })
})
