/**
 * Shared fakes for extension-level tests: a scripted dialog UI, a fixed
 * model catalog, and a canned workspace. Presentation only — no policy, no
 * real I/O.
 */
import type { CatalogModel } from '../../src/adapters/model-catalog.ts'
import type { WorkspaceReaderAdapter } from '../../src/adapters/workspace-reader.ts'
import { ok } from '../../src/core/outcome.ts'

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

/** A recognizable JavaScript workspace: npm lockfile plus a real test script. */
export const FAKE_WORKSPACE_FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({
    name: 'demo',
    scripts: { test: 'node --test' },
  }),
  'package-lock.json': '{}',
}

/** A canned workspace reader over a fixed file tree (absent paths → undefined). */
export function fakeWorkspaceReader(
  files: Readonly<Record<string, string>> = FAKE_WORKSPACE_FILES,
): WorkspaceReaderAdapter {
  return {
    async readTextFile(_root, relativePath) {
      return ok(files[relativePath])
    },
  }
}
