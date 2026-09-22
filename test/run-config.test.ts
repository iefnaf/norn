import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isSha256Digest } from '../src/core/digest.ts'
import { isBlocked } from '../src/core/outcome.ts'
import {
  RUN_CONFIG_DEFAULTS,
  RUN_CONFIG_SCHEMA,
  runConfigRevision,
  runConfigToJson,
  resolveRunConfig,
  resolveRunConfigText,
} from '../src/config/run-config.ts'
import type { ResolvedRunConfig } from '../src/config/run-config.ts'

const FAMILIES = new Map([
  ['provider-a/model-x', { family: 'provider-a' }],
  ['provider-b/model-y', { family: 'provider-b' }],
  ['provider-a/model-z', { family: 'provider-a' }],
])
const resolveFamily = (modelId: string) => FAMILIES.get(modelId)

const BASE_FILE = {
  schema: RUN_CONFIG_SCHEMA,
  targetBranch: 'main',
  tests: [{ argv: ['npm', 'test'], timeoutMs: 120_000 }],
  worker: { model: 'provider-a/model-x', thinking: 'medium', timeoutMs: 3_600_000 },
  reviewer: { model: 'provider-b/model-y', thinking: 'high', timeoutMs: 1_800_000 },
  trustedEvidenceAuthorIds: ['I_actor', 'I_other'],
}

/** A fully resolved config identical to BASE_FILE after default expansion. */
const FULLY_EXPANDED = {
  ...BASE_FILE,
  setup: [],
  maxWorkRounds: 3,
  maxPushRetries: 2,
  concurrency: 4,
  agentEnv: {},
}

/** Independently computed: SHA-256 over RFC 8785 canonical JSON of FULLY_EXPANDED. */
const EXPECTED_FULL_DIGEST = 'sha256:a37b8a407b04d8a09a7857cf2fb16ecc55453c216ab0084bd9f79990fbbfaff1'

function resolveOrThrow(input: unknown) {
  const outcome = resolveRunConfig(input, resolveFamily)
  assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
  if (outcome.kind === 'ok') return outcome.value
  throw new Error('unreachable')
}

describe('resolveRunConfig: defaults expand from fixed constants', () => {
  it('expands setup, agentEnv, maxWorkRounds, maxPushRetries, and concurrency', () => {
    const { config } = resolveOrThrow(BASE_FILE)
    assert.deepEqual(config.setup, [])
    assert.deepEqual(config.agentEnv, {})
    assert.equal(config.maxWorkRounds, RUN_CONFIG_DEFAULTS.maxWorkRounds)
    assert.equal(config.maxPushRetries, RUN_CONFIG_DEFAULTS.maxPushRetries)
    assert.equal(config.concurrency, RUN_CONFIG_DEFAULTS.concurrency)
    assert.equal(config.targetBranch, 'main')
    assert.equal(config.schema, RUN_CONFIG_SCHEMA)
  })

  it('the defaults are the §8 constants, not derived from anywhere', () => {
    assert.deepEqual({ ...RUN_CONFIG_DEFAULTS }, { maxWorkRounds: 3, maxPushRetries: 2, concurrency: 4 })
  })

  it('keeps explicit values instead of defaults', () => {
    const { config } = resolveOrThrow({
      ...BASE_FILE,
      setup: [{ argv: ['npm', 'ci'], timeoutMs: 180_000 }],
      maxWorkRounds: 5,
      maxPushRetries: 0,
      concurrency: 9,
      agentEnv: {
        HTTPS_PROXY: 'http://127.0.0.1:7897',
        NO_PROXY: 'localhost,127.0.0.1',
      },
    })
    assert.deepEqual(config.setup, [{ argv: ['npm', 'ci'], timeoutMs: 180_000 }])
    assert.deepEqual(config.agentEnv, {
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      NO_PROXY: 'localhost,127.0.0.1',
    })
    assert.equal(config.maxWorkRounds, 5)
    assert.equal(config.maxPushRetries, 0)
    assert.equal(config.concurrency, 9)
  })
})

describe('resolveRunConfig: configRevision determinism', () => {
  it('identical content always produces the same revision', () => {
    const first = resolveOrThrow(BASE_FILE)
    const second = resolveOrThrow(structuredClone(BASE_FILE))
    assert.equal(first.configRevision, second.configRevision)
    assert.ok(isSha256Digest(first.configRevision))
  })

  it('matches an independently computed RFC 8785 + SHA-256 digest', () => {
    const { config, configRevision } = resolveOrThrow(BASE_FILE)
    assert.deepEqual(config, FULLY_EXPANDED)
    assert.equal(configRevision, EXPECTED_FULL_DIGEST)
    assert.equal(configRevision, runConfigRevision(FULLY_EXPANDED as ResolvedRunConfig))
  })

  it('omitted optional fields and explicit defaults produce the same revision', () => {
    const omitted = resolveOrThrow(BASE_FILE)
    const explicit = resolveOrThrow(FULLY_EXPANDED)
    assert.equal(omitted.configRevision, explicit.configRevision)
  })

  it('canonicalizes agentEnv key order and binds its values into the revision', () => {
    const first = resolveOrThrow({
      ...BASE_FILE,
      agentEnv: { NO_PROXY: 'localhost', HTTPS_PROXY: 'http://127.0.0.1:7897' },
    })
    const reordered = resolveOrThrow({
      ...BASE_FILE,
      agentEnv: { HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost' },
    })
    const changed = resolveOrThrow({
      ...BASE_FILE,
      agentEnv: { HTTPS_PROXY: 'http://127.0.0.1:7898', NO_PROXY: 'localhost' },
    })

    assert.deepEqual(Object.keys(first.config.agentEnv), ['HTTPS_PROXY', 'NO_PROXY'])
    assert.equal(first.configRevision, reordered.configRevision)
    assert.notEqual(first.configRevision, changed.configRevision)
  })

  it('key order and formatting of the file text do not affect the revision', () => {
    const reordered = `{
      "trustedEvidenceAuthorIds": ["I_other", "I_actor"],
      "reviewer": ${JSON.stringify(BASE_FILE.reviewer)},
      "worker": ${JSON.stringify(BASE_FILE.worker)},
      "tests": ${JSON.stringify(BASE_FILE.tests)},
      "targetBranch": "main",
      "schema": "${RUN_CONFIG_SCHEMA}"
    }`
    const fromText = resolveRunConfigText(reordered, resolveFamily)
    assert.equal(fromText.kind, 'ok')
    if (fromText.kind === 'ok') {
      assert.equal(fromText.value.configRevision, EXPECTED_FULL_DIGEST)
    }
  })

  it('trusted evidence authors resolve in one canonical order regardless of input order', () => {
    const { config } = resolveOrThrow({ ...BASE_FILE, trustedEvidenceAuthorIds: ['I_other', 'I_actor'] })
    assert.deepEqual(config.trustedEvidenceAuthorIds, ['I_actor', 'I_other'])
  })

  it('different content produces a different revision', () => {
    const base = resolveOrThrow(BASE_FILE)
    const changed = resolveOrThrow({ ...BASE_FILE, targetBranch: 'develop' })
    assert.notEqual(base.configRevision, changed.configRevision)
  })
})

describe('resolveRunConfig: validation blocks violations with invalid-config', () => {
  type Case = { name: string; mutate: (file: Record<string, unknown>) => void; expect?: RegExp }

  const cases: Case[] = [
    { name: 'wrong schema', mutate: (f) => { f.schema = 'norn-run:v2' } },
    { name: 'missing schema', mutate: (f) => { delete f.schema } },
    { name: 'missing targetBranch', mutate: (f) => { delete f.targetBranch } },
    { name: 'empty targetBranch', mutate: (f) => { f.targetBranch = '' } },
    { name: 'targetBranch with whitespace', mutate: (f) => { f.targetBranch = 'main develop' } },
    { name: 'targetBranch with leading dash', mutate: (f) => { f.targetBranch = '-main' } },
    { name: 'targetBranch containing ..', mutate: (f) => { f.targetBranch = 'ma..in' } },
    { name: 'missing tests', mutate: (f) => { delete f.tests } },
    { name: 'empty tests list', mutate: (f) => { f.tests = [] }, expect: /at least one/ },
    { name: 'setup is not an array', mutate: (f) => { f.setup = 'npm ci' } },
    {
      name: 'command entry with empty argv',
      mutate: (f) => { f.tests = [{ argv: [], timeoutMs: 1000 }] },
      expect: /non-empty array/,
    },
    {
      name: 'command entry with non-string argv element',
      mutate: (f) => { f.tests = [{ argv: ['npm', 1], timeoutMs: 1000 }] },
    },
    {
      name: 'command entry with zero timeout',
      mutate: (f) => { f.tests = [{ argv: ['npm', 'test'], timeoutMs: 0 }] },
    },
    {
      name: 'command entry with negative timeout',
      mutate: (f) => { f.tests = [{ argv: ['npm', 'test'], timeoutMs: -1 }] },
    },
    {
      name: 'command entry with unknown field',
      mutate: (f) => { f.tests = [{ argv: ['npm', 'test'], timeoutMs: 1000, shell: true }] },
      expect: /unknown field/,
    },
    { name: 'maxWorkRounds below 1', mutate: (f) => { f.maxWorkRounds = 0 } },
    { name: 'maxWorkRounds not an integer', mutate: (f) => { f.maxWorkRounds = 2.5 } },
    { name: 'maxWorkRounds not a number', mutate: (f) => { f.maxWorkRounds = '3' } },
    { name: 'maxPushRetries negative', mutate: (f) => { f.maxPushRetries = -1 } },
    { name: 'concurrency zero', mutate: (f) => { f.concurrency = 0 } },
    { name: 'agentEnv is not an object', mutate: (f) => { f.agentEnv = ['HTTPS_PROXY'] } },
    {
      name: 'agentEnv value is not a string',
      mutate: (f) => { f.agentEnv = { HTTPS_PROXY: 7897 } },
      expect: /must be a string/,
    },
    {
      name: 'agentEnv name is not a valid environment name',
      mutate: (f) => { f.agentEnv = { 'HTTPS-PROXY': 'http://127.0.0.1:7897' } },
      expect: /invalid environment name/,
    },
    {
      name: 'agentEnv value contains NUL',
      mutate: (f) => { f.agentEnv = { HTTPS_PROXY: 'http://proxy\0suffix' } },
      expect: /NUL/,
    },
    {
      name: 'agentEnv tries to replace the coordinator context',
      mutate: (f) => { f.agentEnv = { NORN_AGENT_CONTEXT: '{}' } },
      expect: /reserved environment name/,
    },
    {
      name: 'agentEnv tries to set __proto__',
      mutate: (f) => {
        f.agentEnv = JSON.parse('{"__proto__":"value"}') as Record<string, string>
      },
      expect: /reserved environment name/,
    },
    {
      name: 'agentEnv contains a GitHub token',
      mutate: (f) => { f.agentEnv = { GITHUB_TOKEN: 'secret' } },
      expect: /denied credential/,
    },
    {
      name: 'agentEnv contains an enterprise GitHub token',
      mutate: (f) => { f.agentEnv = { GH_ENTERPRISE_TOKEN: 'secret' } },
      expect: /denied credential/,
    },
    {
      name: 'agentEnv contains push credential configuration',
      mutate: (f) => { f.agentEnv = { GIT_CONFIG_VALUE_0: 'credential.helper=store' } },
      expect: /denied credential/,
    },
    { name: 'missing worker', mutate: (f) => { delete f.worker } },
    { name: 'worker without model', mutate: (f) => { f.worker = { thinking: 'low', timeoutMs: 1 } } },
    { name: 'worker with empty model', mutate: (f) => { f.worker = { ...(f.worker as object), model: '' } } },
    { name: 'worker with empty thinking', mutate: (f) => { f.worker = { ...(f.worker as object), thinking: '' } } },
    { name: 'worker with zero timeout', mutate: (f) => { f.worker = { ...(f.worker as object), timeoutMs: 0 } } },
    { name: 'reviewer with unknown field', mutate: (f) => { f.reviewer = { ...(f.reviewer as object), extra: 1 } }, expect: /unknown field/ },
    { name: 'missing trustedEvidenceAuthorIds', mutate: (f) => { delete f.trustedEvidenceAuthorIds } },
    { name: 'empty trustedEvidenceAuthorIds', mutate: (f) => { f.trustedEvidenceAuthorIds = [] } },
    { name: 'empty author ID string', mutate: (f) => { f.trustedEvidenceAuthorIds = ['I_actor', ''] } },
    {
      name: 'duplicate author IDs',
      mutate: (f) => { f.trustedEvidenceAuthorIds = ['I_actor', 'I_actor'] },
      expect: /duplicate/,
    },
    { name: 'unknown top-level field', mutate: (f) => { f.notifications = [] }, expect: /unknown field/ },
  ]

  for (const testCase of cases) {
    it(`blocks ${testCase.name}`, () => {
      const file = structuredClone(BASE_FILE) as Record<string, unknown>
      testCase.mutate(file)
      const outcome = resolveRunConfig(file, resolveFamily)
      assert.ok(isBlocked(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'invalid-config')
        assert.equal(outcome.scope, 'operation')
        assert.equal(outcome.sharedWrite, 'none')
        if (testCase.expect !== undefined) {
          assert.match(outcome.reason, testCase.expect)
        }
      }
    })
  }

  it('blocks non-object documents', () => {
    for (const input of [null, [], 'norn-run:v1', 42, true]) {
      const outcome = resolveRunConfig(input)
      assert.ok(isBlocked(outcome), String(input))
      assert.equal(outcome.kind === 'blocked' ? outcome.code : '', 'invalid-config')
    }
  })

  it('blocks hand-edited NaN timeouts arriving as parsed objects', () => {
    const file = structuredClone(BASE_FILE) as Record<string, unknown>
    ;(file.tests as Array<{ argv: string[]; timeoutMs: number }>)[0]!.timeoutMs = Number.NaN
    const outcome = resolveRunConfig(file)
    assert.ok(isBlocked(outcome))
  })

  it('reports multiple violations together', () => {
    const outcome = resolveRunConfig({ schema: RUN_CONFIG_SCHEMA })
    assert.ok(isBlocked(outcome))
    if (outcome.kind === 'blocked') {
      const evidence = outcome.evidence[0] as { violations?: string[] }
      assert.ok((evidence.violations?.length ?? 0) >= 4)
    }
  })
})

describe('resolveRunConfig: model catalog family rules', () => {
  it('blocks worker and reviewer in the same provider family', () => {
    const outcome = resolveRunConfig(
      { ...BASE_FILE, reviewer: { model: 'provider-a/model-z', thinking: 'low', timeoutMs: 1000 } },
      resolveFamily,
    )
    assert.ok(isBlocked(outcome))
    if (outcome.kind === 'blocked') {
      assert.equal(outcome.code, 'invalid-config')
      assert.match(outcome.reason, /different provider families/)
    }
  })

  it('blocks a model that is not in the catalog', () => {
    const outcome = resolveRunConfig(
      { ...BASE_FILE, worker: { model: 'provider-a/missing', thinking: 'low', timeoutMs: 1000 } },
      resolveFamily,
    )
    assert.ok(isBlocked(outcome))
    if (outcome.kind === 'blocked') {
      assert.match(outcome.reason, /not in the authenticated model catalog/)
    }
  })

  it('accepts different families', () => {
    const { config } = resolveOrThrow(BASE_FILE)
    assert.equal(config.worker.model, 'provider-a/model-x')
    assert.equal(config.reviewer.model, 'provider-b/model-y')
  })

  it('skips family checks when no catalog resolver is supplied (pure structural load)', () => {
    const outcome = resolveRunConfig(BASE_FILE)
    assert.equal(outcome.kind, 'ok')
  })

  it('cannot judge family divergence without a catalog, and blocks it the moment one is supplied', () => {
    // Family membership is a catalog fact: without a resolver, structural
    // validation alone cannot know families. The rule is enforced on every
    // load that has a catalog, deterministically.
    const sameFamilyFile = {
      ...BASE_FILE,
      reviewer: { model: 'provider-a/model-z', thinking: 'low', timeoutMs: 1000 },
    }
    assert.equal(resolveRunConfig(sameFamilyFile).kind, 'ok')
    assert.ok(isBlocked(resolveRunConfig(sameFamilyFile, resolveFamily)))
  })
})

describe('resolveRunConfigText', () => {
  it('resolves valid JSON text', () => {
    const outcome = resolveRunConfigText(JSON.stringify(BASE_FILE), resolveFamily)
    assert.equal(outcome.kind, 'ok')
  })

  it('blocks malformed JSON text as invalid-config', () => {
    const outcome = resolveRunConfigText('{ not json', resolveFamily)
    assert.ok(isBlocked(outcome))
    if (outcome.kind === 'blocked') {
      assert.equal(outcome.code, 'invalid-config')
      assert.match(outcome.reason, /not valid JSON/)
    }
  })
})

describe('runConfigToJson', () => {
  it('serializes in §8 document order, pretty-printed, round-tripping through resolution', () => {
    const { config, configRevision } = resolveOrThrow(BASE_FILE)
    const text = runConfigToJson(config)
    assert.match(text, /^{\n  "schema": "norn-run:v1",\n  "targetBranch": "main",/)
    assert.match(text, /\n$/)
    const roundTrip = resolveRunConfigText(text, resolveFamily)
    assert.equal(roundTrip.kind, 'ok')
    if (roundTrip.kind === 'ok') {
      assert.equal(roundTrip.value.configRevision, configRevision)
    }
  })
})
