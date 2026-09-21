import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { isBlocked, isError, isOk } from '../src/core/outcome.ts'
import {
  REPOSITORY_METADATA_SCHEMA,
  fsControlStore,
  loadRunConfig,
  parseRepositoryMetadata,
} from '../src/control/control-store.ts'
import type { LocalControlStore } from '../src/control/control-store.ts'
import type { ModelFamilyResolver } from '../src/config/run-config.ts'
import { resolveRunConfig, runConfigToJson } from '../src/config/run-config.ts'

const IDENTITY = { githubHost: 'github.com', repositoryId: 'R_kgDOB123' } as const

const FAMILIES = new Map([
  ['provider-a/model-x', { family: 'provider-a' }],
  ['provider-b/model-y', { family: 'provider-b' }],
])
const resolveFamily: ModelFamilyResolver = (modelId) => FAMILIES.get(modelId)

const VALID_CONFIG = {
  schema: 'norn-run:v1',
  targetBranch: 'main',
  tests: [{ argv: ['npm', 'test'], timeoutMs: 120_000 }],
  worker: { model: 'provider-a/model-x', thinking: 'medium', timeoutMs: 3_600_000 },
  reviewer: { model: 'provider-b/model-y', thinking: 'high', timeoutMs: 1_800_000 },
  trustedEvidenceAuthorIds: ['I_actor'],
}

const VALID_METADATA = {
  schema: REPOSITORY_METADATA_SCHEMA,
  githubHost: 'github.com',
  repositoryId: 'R_kgDOB123',
  owner: 'iefnaf',
  name: 'norn',
  defaultBranch: 'main',
}

function tempStore(): { store: LocalControlStore; home: string; nornHome: string } {
  const nornHome = mkdtempSync(join(tmpdir(), 'norn-control-store-'))
  const store = fsControlStore(nornHome)
  const home = store.repositoryHome(IDENTITY)
  return { store, home, nornHome }
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

function writeConfig(home: string, value: unknown): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'config.json'),
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    'utf8',
  )
}

/** Serialized config.json text of a valid document, with optional overrides. */
function validConfigJson(overrides: Record<string, unknown> = {}): string {
  const resolved = resolveRunConfig({ ...VALID_CONFIG, ...overrides })
  if (resolved.kind !== 'ok') throw new Error(`fixture config is invalid: ${JSON.stringify(resolved)}`)
  return runConfigToJson(resolved.value.config)
}

describe('fsControlStore: repository setup persistence', () => {
  it('writes metadata.json and config.json under repository home, atomically', async () => {
    const { store, home, nornHome } = tempStore()
    try {
      const configJson = validConfigJson()
      const metadataJson = `${JSON.stringify(VALID_METADATA, null, 2)}\n`
      const written = await store.writeRepositorySetup(home, { metadataJson, configJson })
      assert.equal(written.kind, 'ok')

      assert.equal(readFileSync(join(home, 'metadata.json'), 'utf8'), metadataJson)
      assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), configJson)
      // Atomic writes leave no temporary files behind.
      assert.deepEqual(readdirSync(home).sort(), ['config.json', 'metadata.json'])
      assert.ok(home.startsWith(nornHome))
    } finally {
      cleanup(nornHome)
    }
  })

  it('reads metadata and config text back, and reports absent files as undefined', async () => {
    const { store, home, nornHome } = tempStore()
    try {
      assert.equal((await store.readConfigText(home)).kind === 'ok' ? undefined : 'err', undefined)
      const okConfig = await store.readConfigText(home)
      assert.ok(isOk(okConfig))
      if (okConfig.kind === 'ok') assert.equal(okConfig.value, undefined)
      const okMetadata = await store.readMetadataText(home)
      assert.ok(isOk(okMetadata))
      if (okMetadata.kind === 'ok') assert.equal(okMetadata.value, undefined)

      await store.writeRepositorySetup(home, {
        metadataJson: `${JSON.stringify(VALID_METADATA)}\n`,
        configJson: validConfigJson(),
      })
      const configText = await store.readConfigText(home)
      if (configText.kind === 'ok') assert.match(configText.value ?? '', /norn-run:v1/)
    } finally {
      cleanup(nornHome)
    }
  })

  it('replaces an existing setup in place', async () => {
    const { store, home, nornHome } = tempStore()
    try {
      await store.writeRepositorySetup(home, {
        metadataJson: '{}\n',
        configJson: validConfigJson(),
      })
      await store.writeRepositorySetup(home, {
        metadataJson: `${JSON.stringify(VALID_METADATA)}\n`,
        configJson: validConfigJson({ targetBranch: 'develop' }),
      })
      const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
      assert.equal(config.targetBranch, 'develop')
    } finally {
      cleanup(nornHome)
    }
  })
})

describe('fsControlStore: findActiveRuns', () => {
  function writeRunState(home: string, encodedIssueId: string, body: string | object): void {
    const mapDir = join(home, 'maps', encodedIssueId)
    mkdirSync(mapDir, { recursive: true })
    writeFileSync(
      join(mapDir, 'run-state.json'),
      typeof body === 'string' ? body : JSON.stringify(body),
      'utf8',
    )
  }

  it('reports no active runs when the maps directory does not exist', async () => {
    const { store, home, nornHome } = tempStore()
    try {
      const result = await store.findActiveRuns(home)
      assert.ok(isOk(result))
      if (result.kind === 'ok') assert.deepEqual(result.value.activeRunMaps, [])
    } finally {
      cleanup(nornHome)
    }
  })

  it('reports only maps whose Run State status is running', async () => {
    const { store, home, nornHome } = tempStore()
    try {
      writeRunState(home, 'I_running', { schema: 'norn-run-state:v1', status: 'running' })
      writeRunState(home, 'I_terminal', { schema: 'norn-run-state:v1', status: 'terminal' })
      writeRunState(home, 'I_aborted', { schema: 'norn-run-state:v1', status: 'aborted' })
      const result = await store.findActiveRuns(home)
      assert.ok(isOk(result))
      if (result.kind === 'ok') assert.deepEqual(result.value.activeRunMaps, ['I_running'])
    } finally {
      cleanup(nornHome)
    }
  })

  it('treats an unparseable run-state.json as active: an unprovable state must block', async () => {
    const { store, home, nornHome } = tempStore()
    try {
      writeRunState(home, 'I_corrupt', '{ not json')
      const result = await store.findActiveRuns(home)
      assert.ok(isOk(result))
      if (result.kind === 'ok') assert.deepEqual(result.value.activeRunMaps, ['I_corrupt'])
    } finally {
      cleanup(nornHome)
    }
  })

  it('ignores map directories without a run-state.json', async () => {
    const { store, home, nornHome } = tempStore()
    try {
      mkdirSync(join(home, 'maps', 'I_empty'), { recursive: true })
      const result = await store.findActiveRuns(home)
      assert.ok(isOk(result))
      if (result.kind === 'ok') assert.deepEqual(result.value.activeRunMaps, [])
    } finally {
      cleanup(nornHome)
    }
  })
})

describe('loadRunConfig', () => {
  it('resolves a valid config into the resolved document and its configRevision', async () => {
    const { store, home, nornHome } = tempStore()
    try {
      writeConfig(home, VALID_CONFIG)
      const outcome = await loadRunConfig(store, home, resolveFamily)
      assert.ok(isOk(outcome))
      if (outcome.kind === 'ok') {
        assert.equal(outcome.value.config.targetBranch, 'main')
        assert.equal(outcome.value.config.maxWorkRounds, 3)
        assert.match(outcome.value.configRevision, /^sha256:[0-9a-f]{64}$/)
      }
    } finally {
      cleanup(nornHome)
    }
  })

  it('blocks a missing config as no-config', async () => {
    const { store, home, nornHome } = tempStore()
    try {
      const outcome = await loadRunConfig(store, home)
      assert.ok(isBlocked(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'no-config')
        assert.equal(outcome.scope, 'operation')
      }
    } finally {
      cleanup(nornHome)
    }
  })

  it('blocks an invalid or hand-edited config as invalid-config before creating anything', async () => {
    const { store, home, nornHome } = tempStore()
    try {
      writeConfig(home, { ...VALID_CONFIG, tests: [] })
      const outcome = await loadRunConfig(store, home)
      assert.ok(isBlocked(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'invalid-config')
        assert.match(outcome.reason, /tests/)
      }
      // Loading created no run-owned resource: no maps/, runs/, or locks/
      // directories exist — only the config file the test itself wrote.
      assert.deepEqual(readdirSync(home), ['config.json'])
      assert.equal(existsSync(join(home, 'maps')), false)
      assert.equal(existsSync(join(home, 'runs')), false)
      assert.equal(existsSync(join(home, 'locks')), false)
    } finally {
      cleanup(nornHome)
    }
  })

  it('blocks a hand-edited config whose models violate the family rule when a catalog is supplied', async () => {
    const { store, home, nornHome } = tempStore()
    try {
      writeConfig(home, {
        ...VALID_CONFIG,
        reviewer: { model: 'provider-a/model-x', thinking: 'low', timeoutMs: 1000 },
      })
      const outcome = await loadRunConfig(store, home, resolveFamily)
      assert.ok(isBlocked(outcome))
      if (outcome.kind === 'blocked') assert.equal(outcome.code, 'invalid-config')
    } finally {
      cleanup(nornHome)
    }
  })

  it('blocks malformed JSON text as invalid-config', async () => {
    const { store, home, nornHome } = tempStore()
    try {
      writeConfig(home, '{ broken')
      const outcome = await loadRunConfig(store, home)
      assert.ok(isBlocked(outcome))
      if (outcome.kind === 'blocked') assert.equal(outcome.code, 'invalid-config')
    } finally {
      cleanup(nornHome)
    }
  })

  it('passes control-store read errors through', async () => {
    const failing: LocalControlStore = {
      ...fsControlStore('/nonexistent-root-should-not-matter'),
      repositoryHome: () => '/home',
      async readConfigText() {
        const { error } = await import('../src/core/outcome.ts')
        return error({ scope: 'operation', code: 'control-store', reason: 'boom' })
      },
    }
    const outcome = await loadRunConfig(failing, '/home')
    assert.ok(isError(outcome))
    if (outcome.kind === 'error') assert.equal(outcome.code, 'control-store')
  })
})

describe('parseRepositoryMetadata', () => {
  it('parses a well-formed metadata document', () => {
    const metadata = parseRepositoryMetadata(JSON.stringify(VALID_METADATA))
    assert.deepEqual(metadata, VALID_METADATA)
  })

  it('rejects malformed metadata', () => {
    assert.equal(parseRepositoryMetadata('not json'), undefined)
    assert.equal(parseRepositoryMetadata('null'), undefined)
    assert.equal(parseRepositoryMetadata(JSON.stringify({ ...VALID_METADATA, schema: 'other:v1' })), undefined)
    assert.equal(parseRepositoryMetadata(JSON.stringify({ ...VALID_METADATA, owner: '' })), undefined)
    assert.equal(parseRepositoryMetadata(JSON.stringify({ ...VALID_METADATA, defaultBranch: 1 })), undefined)
  })
})
