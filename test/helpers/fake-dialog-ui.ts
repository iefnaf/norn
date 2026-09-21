/**
 * Shared fakes for extension-level tests: a scripted dialog UI and a fixed
 * model catalog. Presentation only — no policy, no I/O.
 */
import type { CatalogModel } from '../../src/adapters/model-catalog.ts'

export type FakeDialogUi = {
  select(title: string, options: readonly string[]): Promise<string | undefined>
  confirm(title: string, message: string): Promise<boolean>
  input(title: string, placeholder?: string): Promise<string | undefined>
}

export const FAKE_CATALOG: readonly CatalogModel[] = [
  {
    id: 'provider-a/model-x',
    family: 'provider-a',
    displayName: 'Model X',
    thinkingLevels: ['off', 'medium', 'high'],
  },
  {
    id: 'provider-b/model-y',
    family: 'provider-b',
    displayName: 'Model Y',
    thinkingLevels: ['off', 'high'],
  },
]

export function fakeCatalogModels(models: readonly CatalogModel[] = FAKE_CATALOG) {
  return {
    async listModels() {
      return { kind: 'ok' as const, value: models }
    },
  }
}
