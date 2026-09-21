import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isError, isOk } from '../src/core/outcome.ts'
import {
  THINKING_LEVELS,
  modelFamilyResolver,
  registryModelCatalog,
  supportedThinkingLevels,
} from '../src/adapters/model-catalog.ts'
import type { ModelRegistryLike, RegistryModelLike } from '../src/adapters/model-catalog.ts'

describe('supportedThinkingLevels', () => {
  it('offers every level for a model without a thinking level map', () => {
    assert.deepEqual(supportedThinkingLevels({}), [...THINKING_LEVELS])
  })

  it('keeps levels mapped to values, drops levels mapped to null, keeps missing keys', () => {
    const model: RegistryModelLike = {
      id: 'model-x',
      name: 'Model X',
      provider: 'provider-a',
      thinkingLevelMap: { low: 'low', high: null },
    }
    assert.deepEqual(supportedThinkingLevels(model), [
      'off',
      'minimal',
      'low',
      'medium',
      'xhigh',
      'max',
    ])
  })
})

describe('registryModelCatalog', () => {
  function registry(models: RegistryModelLike[], failing = false): ModelRegistryLike {
    return {
      async refresh() {
        if (failing) throw new Error('network down')
        return undefined
      },
      getAvailable() {
        return models
      },
    }
  }

  it('maps registry models to catalog entries keyed by provider/model with family = provider', async () => {
    const catalog = registryModelCatalog(
      registry([
        {
          id: 'model-x',
          name: 'Model X',
          provider: 'provider-a',
          thinkingLevelMap: { high: 'high', max: null },
        },
        { id: 'model-y', name: 'Model Y', provider: 'provider-b' },
      ]),
    )
    const outcome = await catalog.listModels()
    assert.ok(isOk(outcome))
    if (outcome.kind === 'ok') {
      assert.deepEqual(outcome.value, [
        {
          id: 'provider-a/model-x',
          family: 'provider-a',
          displayName: 'Model X',
          thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
        },
        {
          id: 'provider-b/model-y',
          family: 'provider-b',
          displayName: 'Model Y',
          thinkingLevels: [...THINKING_LEVELS],
        },
      ])
    }
  })

  it('still serves the stored catalog when refresh fails', async () => {
    const catalog = registryModelCatalog(registry([{ id: 'm', name: 'M', provider: 'p' }], true))
    const outcome = await catalog.listModels()
    assert.ok(isOk(outcome))
  })

  it('errors when no model is available at all', async () => {
    const catalog = registryModelCatalog(registry([]))
    const outcome = await catalog.listModels()
    assert.ok(isError(outcome))
    if (outcome.kind === 'error') assert.equal(outcome.code, 'model-catalog-unavailable')
  })
})

describe('modelFamilyResolver', () => {
  it('resolves exact provider/model IDs and rejects unknown ones', () => {
    const resolve = modelFamilyResolver([
      { id: 'provider-a/model-x', family: 'provider-a', displayName: 'X', thinkingLevels: ['off'] },
      { id: 'provider-b/model-y', family: 'provider-b', displayName: 'Y', thinkingLevels: ['off'] },
    ])
    assert.deepEqual(resolve('provider-a/model-x'), { family: 'provider-a' })
    assert.deepEqual(resolve('provider-b/model-y'), { family: 'provider-b' })
    assert.equal(resolve('provider-a/model-z'), undefined)
    assert.equal(resolve('model-x'), undefined)
  })
})
