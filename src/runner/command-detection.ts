/**
 * Setup/test command detection for the quick `/norn init` flow (design.md
 * §2.3, §8): recognize the repository's own build files and derive the
 * configured command entries from them. Detection reads facts once at init
 * time and its result is written explicitly into `config.json` — Run Config
 * resolution never consults the workspace.
 *
 * The decision table is pure over a probe of candidate root files; the
 * workspace reader adapter supplies the reads. When nothing is recognized,
 * detection yields `undefined` and init asks for the test commands directly:
 * Norn never invents a machine gate (§8: `tests` must not be empty).
 */
import type { Outcome } from '../core/outcome.ts'
import { error, ok } from '../core/outcome.ts'
import type { WorkspaceReaderAdapter } from '../adapters/workspace-reader.ts'
import type { CommandSpecInput } from './init.ts'

/** The detection result: complete command entries plus their provenance. */
export type DetectedCommandPlan = {
  readonly setup: readonly CommandSpecInput[]
  readonly tests: readonly CommandSpecInput[]
  /** Human-readable provenance, e.g. `npm (package-lock.json)`. */
  readonly source: string
}

/**
 * Detected commands get a generous fixed budget: dependency installs and full
 * suites routinely exceed the two-minute value the Customize path suggests.
 */
export const DETECTED_COMMAND_TIMEOUT_MS = 600_000

/** `npm init`'s placeholder script — present, but not a real test. */
const NPM_DEFAULT_TEST_PLACEHOLDER = 'echo "Error: no test specified" && exit 1'

const PROBE_PATHS = [
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.toml',
  'go.mod',
  'GNUmakefile',
  'makefile',
  'Makefile',
] as const

type PackageManagerPlan = {
  readonly id: string
  readonly lockfiles: readonly string[]
  readonly setupWithLockfile: readonly string[]
  readonly setupWithoutLockfile: readonly string[]
  readonly test: readonly string[]
  /** Whether the test entry requires a real `scripts.test` in package.json. */
  readonly requiresScriptsTest: boolean
}

/**
 * Priority order when several lockfiles coexist: pnpm, yarn, bun, then npm
 * (npm is also the fallback when only `package.json` exists).
 */
const PACKAGE_MANAGERS: readonly PackageManagerPlan[] = [
  {
    id: 'pnpm',
    lockfiles: ['pnpm-lock.yaml'],
    setupWithLockfile: ['pnpm', 'install', '--frozen-lockfile'],
    setupWithoutLockfile: ['pnpm', 'install'],
    test: ['pnpm', 'test'],
    requiresScriptsTest: true,
  },
  {
    id: 'yarn',
    lockfiles: ['yarn.lock'],
    setupWithLockfile: ['yarn', 'install', '--immutable'],
    setupWithoutLockfile: ['yarn', 'install'],
    test: ['yarn', 'test'],
    requiresScriptsTest: true,
  },
  {
    id: 'bun',
    lockfiles: ['bun.lock', 'bun.lockb'],
    setupWithLockfile: ['bun', 'install', '--frozen-lockfile'],
    setupWithoutLockfile: ['bun', 'install'],
    test: ['bun', 'test'],
    // `bun test` runs Bun's built-in runner even without a scripts entry.
    requiresScriptsTest: false,
  },
  {
    id: 'npm',
    lockfiles: ['package-lock.json'],
    setupWithLockfile: ['npm', 'ci'],
    setupWithoutLockfile: ['npm', 'install'],
    test: ['npm', 'test'],
    requiresScriptsTest: true,
  },
]

function detectedCommand(argv: readonly string[]): CommandSpecInput {
  return { argv, timeoutMs: DETECTED_COMMAND_TIMEOUT_MS }
}

/**
 * The pure decision table over probed root files. `undefined` means the
 * workspace is unrecognized (or a recognizable project has no usable test
 * script) and init must ask explicitly.
 */
export function planFromProbeFiles(
  files: Readonly<Record<string, string | undefined>>,
): DetectedCommandPlan | undefined {
  const packageJsonText = files['package.json']
  if (packageJsonText !== undefined) {
    return planJavaScriptProject(files, packageJsonText)
  }
  if (files['Cargo.toml'] !== undefined) {
    return { setup: [], tests: [detectedCommand(['cargo', 'test'])], source: 'cargo (Cargo.toml)' }
  }
  if (files['go.mod'] !== undefined) {
    return { setup: [], tests: [detectedCommand(['go', 'test', './...'])], source: 'go (go.mod)' }
  }
  for (const name of ['GNUmakefile', 'makefile', 'Makefile'] as const) {
    const makefile = files[name]
    if (makefile !== undefined && /^test\s*:/m.test(makefile)) {
      return { setup: [], tests: [detectedCommand(['make', 'test'])], source: `make (${name})` }
    }
  }
  return undefined
}

function planJavaScriptProject(
  files: Readonly<Record<string, string | undefined>>,
  packageJsonText: string,
): DetectedCommandPlan | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(packageJsonText)
  } catch {
    return undefined
  }
  const scripts =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { scripts?: unknown }).scripts
      : undefined
  const testScript = typeof scripts === 'object' && scripts !== null
    ? (scripts as Record<string, unknown>).test
    : undefined

  const manager =
    PACKAGE_MANAGERS.find((candidate) =>
      candidate.lockfiles.some((lockfile) => files[lockfile] !== undefined),
    ) ?? PACKAGE_MANAGERS[PACKAGE_MANAGERS.length - 1]!
  const lockfile = manager.lockfiles.find((candidate) => files[candidate] !== undefined)

  if (manager.requiresScriptsTest) {
    const usable =
      typeof testScript === 'string' &&
      testScript.trim() !== '' &&
      testScript.trim() !== NPM_DEFAULT_TEST_PLACEHOLDER
    if (!usable) return undefined
  }

  return {
    setup: [detectedCommand(lockfile !== undefined ? manager.setupWithLockfile : manager.setupWithoutLockfile)],
    tests: [detectedCommand(manager.test)],
    source: lockfile !== undefined ? `${manager.id} (${lockfile})` : `${manager.id} (package.json)`,
  }
}

/**
 * Probe the candidate build files through the workspace reader and apply the
 * decision table. A read failure is a typed error; an unrecognized workspace
 * is `ok(undefined)`.
 */
export async function detectWorkspaceCommandPlan(
  reader: WorkspaceReaderAdapter,
  root: string,
): Promise<Outcome<DetectedCommandPlan | undefined, never, 'workspace-read'>> {
  const files: Record<string, string | undefined> = {}
  for (const path of PROBE_PATHS) {
    const text = await reader.readTextFile(root, path)
    if (text.kind !== 'ok') {
      return error({ scope: 'operation', code: text.code, reason: text.reason })
    }
    files[path] = text.value
  }
  return ok(planFromProbeFiles(files))
}
