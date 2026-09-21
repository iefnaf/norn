/**
 * The model catalog seam (design.md §8): read-only access to the
 * authenticated model catalog. `/norn init` presents exact provider/model IDs
 * from this catalog — it never invents or fuzzy-matches model names — and Run
 * Config resolution uses it to prove Worker and Reviewer resolve to different
 * provider families.
 *
 * The built-in production adapter reads the Pi extension's model registry.
 * Tests inject canned catalogs — no network, no clock.
 */
import { error, ok } from '../core/outcome.ts'
import type { Outcome } from '../core/outcome.ts'
import type { ModelFamilyResolver } from '../config/run-config.ts'

/** Every thinking level a Pi model can declare (pi-ai `ModelThinkingLevel`). */
export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** One model in the authenticated catalog, as operator choices present it. */
export type CatalogModel = {
  /** Exact `provider/model` ID, the form Run Config stores. */
  readonly id: string
  /** Provider family; Worker and Reviewer must differ here (§8). */
  readonly family: string
  readonly displayName: string
  /** Thinking levels the model supports, always including `off`. */
  readonly thinkingLevels: readonly ThinkingLevel[]
}

export type ModelCatalogErrorCode = 'model-catalog-unavailable'

export type ModelCatalogAdapter = {
  /** Every available model with configured authentication, in catalog order. */
  listModels(): Promise<Outcome<readonly CatalogModel[], never, ModelCatalogErrorCode>>
}

/** The structural slice of Pi's `ModelRegistry` the adapter needs. */
export type ModelRegistryLike = {
  /** Reload the model catalog; awaited before synchronous reads. */
  refresh(): Promise<unknown>
  getAvailable(): readonly RegistryModelLike[]
}

export type RegistryModelLike = {
  readonly id: string
  readonly name: string
  readonly provider: string
  /** A level mapped to `null` is unsupported; missing keys use provider defaults. */
  readonly thinkingLevelMap?: Readonly<Partial<Record<ThinkingLevel, string | null>>>
}

/** Thinking levels the model supports: `off` plus every level not mapped to `null`. */
export function supportedThinkingLevels(
  model: Pick<RegistryModelLike, 'thinkingLevelMap'>,
): readonly ThinkingLevel[] {
  return THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null)
}

/** The built-in production adapter over the Pi model registry. */
export function registryModelCatalog(registry: ModelRegistryLike): ModelCatalogAdapter {
  return {
    async listModels() {
      try {
        await registry.refresh()
      } catch {
        // The registry may still hold a usable stored catalog; read it below.
      }
      let available: readonly RegistryModelLike[]
      try {
        available = registry.getAvailable()
      } catch (cause) {
        return error({
          scope: 'operation',
          code: 'model-catalog-unavailable',
          reason: `reading the model catalog failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        })
      }
      const models = available.map((model) => ({
        id: `${model.provider}/${model.id}`,
        family: model.provider,
        displayName: model.name,
        thinkingLevels: supportedThinkingLevels(model),
      }))
      if (models.length === 0) {
        return error({
          scope: 'operation',
          code: 'model-catalog-unavailable',
          reason: 'the authenticated model catalog is empty',
        })
      }
      return ok(models)
    },
  }
}

/**
 * Build the pure family resolver Run Config validation uses: one catalog
 * snapshot, looked up by exact `provider/model` ID.
 */
export function modelFamilyResolver(
  models: readonly CatalogModel[],
): ModelFamilyResolver {
  const families = new Map(models.map((model) => [model.id, { family: model.family }]))
  return (modelId: string) => families.get(modelId)
}
