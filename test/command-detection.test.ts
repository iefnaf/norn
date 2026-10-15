import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { WorkspaceReaderAdapter } from '../src/adapters/workspace-reader.ts'
import { error } from '../src/core/outcome.ts'
import {
  DETECTED_COMMAND_TIMEOUT_MS,
  detectWorkspaceCommandPlan,
  planFromProbeFiles,
} from '../src/runner/command-detection.ts'

const T = DETECTED_COMMAND_TIMEOUT_MS

function packageJson(scripts: Record<string, string> = { test: 'node --test' }): string {
  return JSON.stringify({ name: 'demo', scripts })
}

/** The npm-init placeholder — present in package.json but not a real test. */
const NPM_PLACEHOLDER = 'echo "Error: no test specified" && exit 1'

describe('planFromProbeFiles: JavaScript workspaces', () => {
  it('detects npm with a lockfile as npm ci + npm test', () => {
    const plan = planFromProbeFiles({
      'package.json': packageJson(),
      'package-lock.json': '{}',
    })
    assert.deepEqual(plan, {
      setup: [{ argv: ['npm', 'ci'], timeoutMs: T }],
      tests: [{ argv: ['npm', 'test'], timeoutMs: T }],
      source: 'npm (package-lock.json)',
    })
  })

  it('falls back to npm install when only package.json exists', () => {
    const plan = planFromProbeFiles({ 'package.json': packageJson() })
    assert.deepEqual(plan?.setup, [{ argv: ['npm', 'install'], timeoutMs: T }])
    assert.equal(plan?.source, 'npm (package.json)')
  })

  it('detects pnpm, yarn, and bun by their lockfiles', () => {
    for (const [lockfile, source, setupArgv, testArgv] of [
      ['pnpm-lock.yaml', 'pnpm (pnpm-lock.yaml)', ['pnpm', 'install', '--frozen-lockfile'], ['pnpm', 'test']],
      ['yarn.lock', 'yarn (yarn.lock)', ['yarn', 'install', '--immutable'], ['yarn', 'test']],
      ['bun.lock', 'bun (bun.lock)', ['bun', 'install', '--frozen-lockfile'], ['bun', 'test']],
      ['bun.lockb', 'bun (bun.lockb)', ['bun', 'install', '--frozen-lockfile'], ['bun', 'test']],
    ] as const) {
      const plan = planFromProbeFiles({ 'package.json': packageJson(), [lockfile]: '' })
      assert.deepEqual(plan?.setup, [{ argv: [...setupArgv], timeoutMs: T }], lockfile)
      assert.deepEqual(plan?.tests, [{ argv: [...testArgv], timeoutMs: T }], lockfile)
      assert.equal(plan?.source, source, lockfile)
    }
  })

  it('prefers pnpm when several lockfiles coexist', () => {
    const plan = planFromProbeFiles({
      'package.json': packageJson(),
      'package-lock.json': '{}',
      'pnpm-lock.yaml': '',
    })
    assert.equal(plan?.source, 'pnpm (pnpm-lock.yaml)')
  })

  it('refuses to invent tests when scripts.test is missing, empty, or the npm placeholder', () => {
    for (const scripts of [
      {},
      { test: '' },
      { test: NPM_PLACEHOLDER },
      { build: 'tsc' },
    ] as const) {
      const plan = planFromProbeFiles({
        'package.json': packageJson(scripts as Record<string, string>),
        'package-lock.json': '{}',
      })
      assert.equal(plan, undefined, JSON.stringify(scripts))
    }
  })

  it('bun still detects without scripts.test because bun test is built in', () => {
    const plan = planFromProbeFiles({
      'package.json': packageJson({}),
      'bun.lock': '',
    })
    assert.deepEqual(plan?.tests, [{ argv: ['bun', 'test'], timeoutMs: T }])
  })

  it('a malformed package.json is unrecognized', () => {
    assert.equal(planFromProbeFiles({ 'package.json': '{oops' }), undefined)
  })
})

describe('planFromProbeFiles: other ecosystems', () => {
  it('detects cargo and go without setup commands', () => {
    assert.deepEqual(planFromProbeFiles({ 'Cargo.toml': '' })?.tests, [
      { argv: ['cargo', 'test'], timeoutMs: T },
    ])
    assert.deepEqual(planFromProbeFiles({ 'go.mod': '' })?.tests, [
      { argv: ['go', 'test', './...'], timeoutMs: T },
    ])
  })

  it('detects a Makefile with a test target, in every spelling', () => {
    for (const name of ['GNUmakefile', 'makefile', 'Makefile'] as const) {
      const plan = planFromProbeFiles({ [name]: 'build:\n\tgo build\n\ntest:\n\tgo test ./...\n' })
      assert.deepEqual(plan?.tests, [{ argv: ['make', 'test'], timeoutMs: T }], name)
      assert.equal(plan?.source, `make (${name})`)
    }
  })

  it('a Makefile without a test target is unrecognized', () => {
    assert.equal(planFromProbeFiles({ Makefile: 'build:\n\ttrue\n' }), undefined)
  })

  it('an empty or foreign workspace is unrecognized', () => {
    assert.equal(planFromProbeFiles({}), undefined)
    assert.equal(planFromProbeFiles({ 'pyproject.toml': '[project]\nname = "x"\n' }), undefined)
    assert.equal(planFromProbeFiles({ 'README.md': '# hi' }), undefined)
  })

  it('a JavaScript workspace wins over a Makefile test target', () => {
    const plan = planFromProbeFiles({
      'package.json': packageJson(),
      Makefile: 'test:\n\tnpm test\n',
    })
    assert.equal(plan?.source, 'npm (package.json)')
  })
})

describe('detectWorkspaceCommandPlan through the adapter', () => {
  it('probes the candidate files and returns the plan', async () => {
    const probed: string[] = []
    const reader: WorkspaceReaderAdapter = {
      async readTextFile(_root, relativePath) {
        probed.push(relativePath)
        if (relativePath === 'package.json') return Promise.resolve({ kind: 'ok' as const, value: packageJson() })
        return Promise.resolve({ kind: 'ok' as const, value: undefined })
      },
    }
    const outcome = await detectWorkspaceCommandPlan(reader, '/repo')
    assert.equal(outcome.kind, 'ok')
    if (outcome.kind === 'ok') {
      assert.equal(outcome.value?.source, 'npm (package.json)')
    }
    assert.equal(probed.includes('package.json'), true)
    assert.equal(probed.includes('Cargo.toml'), true)
  })

  it('propagates a read failure as a typed error', async () => {
    const reader: WorkspaceReaderAdapter = {
      async readTextFile() {
        return error({ scope: 'operation', code: 'workspace-read', reason: 'permission denied' })
      },
    }
    const outcome = await detectWorkspaceCommandPlan(reader, '/repo')
    assert.equal(outcome.kind, 'error')
    if (outcome.kind === 'error') assert.equal(outcome.code, 'workspace-read')
  })
})
