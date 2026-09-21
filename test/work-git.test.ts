/**
 * Work workspace creation against real temporary repositories (design.md
 * §10.1, ticket #7), exercised through the built-in `git` CLI runner — the
 * same seam the production adapter uses.
 *
 * Covers: worktrees created under repository home at the exact Wave base
 * with run-qualified names; commit→tree OID, object-format (sha1 and sha256
 * repositories), and repository-identity verification; refused creation at
 * a wrong base; map-completion workspaces checked out detached at the exact
 * completion commit; and ignored dependency directories that may remain
 * without ever counting as evidence.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

import { runGit } from '../src/adapters/git-repository.ts'
import { isError, isOk } from '../src/core/outcome.ts'
import { inspectWorkspace } from '../src/work/workspace.ts'
import { createMapCompletionWorkspace, createTicketWorkspace } from '../src/work/workspace.ts'

type TempRepository = {
  readonly root: string
  readonly baseSha: string
  readonly baseTreeHex: string
  readonly objectFormat: 'sha1' | 'sha256'
  readonly cleanup: () => void
}

function tempGitRepository(options: { objectFormat?: 'sha1' | 'sha256'; ignoreNodeModules?: boolean } = {}): TempRepository {
  const objectFormat = options.objectFormat ?? 'sha1'
  const scratch = mkdtempSync(join(tmpdir(), `norn-workspace-${objectFormat}-`))
  const root = join(scratch, 'repo')
  execFileSync('git', ['init', '--quiet', '--object-format', objectFormat, '-b', 'main', root])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'norn@example.invalid'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Norn Test'])

  if (options.ignoreNodeModules) {
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n', 'utf8')
  }
  writeFileSync(join(root, 'README.md'), '# temp\n', 'utf8')
  execFileSync('git', ['-C', root, 'add', '.'])
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'init'])

  const baseSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const baseTreeHex = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD^{tree}'], {
    encoding: 'utf8',
  }).trim()
  return { root, baseSha, baseTreeHex, objectFormat, cleanup: () => rmSync(scratch, { recursive: true, force: true }) }
}

function tempRepositoryHome(label: string): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), `norn-repository-home-${label}-`))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

function gitText(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

describe('createTicketWorkspace in a real sha1 repository', () => {
  it('creates the run-qualified branch and worktree at the exact base, verified', async () => {
    const repo = tempGitRepository()
    const home = tempRepositoryHome('sha1')
    try {
      const outcome = await createTicketWorkspace(
        { git: runGit },
        {
          repositoryRoot: repo.root,
          repositoryHome: home.home,
          repositoryId: 'R_1',
          runId: 'run-4',
          ticketNumber: 12,
          workAttemptId: 'wa-1',
          base: { sha: `sha1:${repo.baseSha}`, treeOid: `sha1:${repo.baseTreeHex}` },
        },
      )
      assert.ok(isOk(outcome))
      if (outcome.kind !== 'ok') return
      const workspace = outcome.value
      assert.equal(workspace.kind, 'ticket')
      assert.equal(workspace.branch, 'norn/run-4/12/wa-1')
      assert.equal(workspace.path, join(home.home, 'runs', 'run-4', 'workspaces', '12', 'wa-1'))

      // Independent verification outside the seam under test.
      assert.ok(existsSync(join(workspace.path, 'README.md')))
      assert.equal(gitText(workspace.path, ['rev-parse', 'HEAD']), repo.baseSha)
      assert.equal(gitText(workspace.path, ['rev-parse', 'HEAD^{tree}']), repo.baseTreeHex)
      assert.equal(
        gitText(workspace.path, ['rev-parse', '--symbolic-full-name', 'HEAD']),
        'refs/heads/norn/run-4/12/wa-1',
      )
      assert.equal(gitText(repo.root, ['rev-parse', 'refs/heads/norn/run-4/12/wa-1']), repo.baseSha)
      assert.equal(gitText(workspace.path, ['status', '--porcelain']), '')
      // The worktree belongs to the expected repository: one shared common
      // dir (the main repository reports it relative to its own root).
      const workspaceCommon = gitText(workspace.path, ['rev-parse', '--git-common-dir'])
      const rootCommon = gitText(repo.root, ['rev-parse', '--git-common-dir'])
      assert.equal(
        realpathSync(resolve(workspace.path, workspaceCommon)),
        realpathSync(resolve(repo.root, rootCommon)),
      )
    } finally {
      repo.cleanup()
      home.cleanup()
    }
  })

  it('refuses a base whose tree does not match the captured tree OID', async () => {
    const repo = tempGitRepository()
    const home = tempRepositoryHome('wrong-tree')
    try {
      const wrongTree = `sha1:${'c'.repeat(40)}`
      const outcome = await createTicketWorkspace(
        { git: runGit },
        {
          repositoryRoot: repo.root,
          repositoryHome: home.home,
          repositoryId: 'R_1',
          runId: 'run-4',
          ticketNumber: 13,
          workAttemptId: 'wa-1',
          base: { sha: `sha1:${repo.baseSha}`, treeOid: wrongTree },
        },
      )
      assert.ok(isError(outcome))
      assert.equal(outcome.kind === 'error' ? outcome.code : '', 'base-tree-mismatch')
      // Nothing was created: no branch, no workspace directory.
      assert.equal(existsSync(join(home.home, 'runs')), false)
      assert.throws(() => gitText(repo.root, ['rev-parse', '--verify', '--quiet', 'refs/heads/norn/run-4/13/wa-1']))
    } finally {
      repo.cleanup()
      home.cleanup()
    }
  })

  it('refuses an unknown base commit', async () => {
    const repo = tempGitRepository()
    const home = tempRepositoryHome('unknown-base')
    try {
      const outcome = await createTicketWorkspace(
        { git: runGit },
        {
          repositoryRoot: repo.root,
          repositoryHome: home.home,
          repositoryId: 'R_1',
          runId: 'run-4',
          ticketNumber: 14,
          workAttemptId: 'wa-1',
          base: { sha: `sha1:${'d'.repeat(40)}`, treeOid: `sha1:${repo.baseTreeHex}` },
        },
      )
      assert.ok(isError(outcome))
      assert.equal(outcome.kind === 'error' ? outcome.code : '', 'git-failed')
    } finally {
      repo.cleanup()
      home.cleanup()
    }
  })

  it('fails when the run-qualified branch already exists', async () => {
    const repo = tempGitRepository()
    const home = tempRepositoryHome('branch-exists')
    try {
      const params = {
        repositoryRoot: repo.root,
        repositoryHome: home.home,
        repositoryId: 'R_1',
        runId: 'run-4',
        ticketNumber: 15,
        workAttemptId: 'wa-1',
        base: { sha: `sha1:${repo.baseSha}`, treeOid: `sha1:${repo.baseTreeHex}` },
      }
      const first = await createTicketWorkspace({ git: runGit }, params)
      assert.ok(isOk(first))
      const second = await createTicketWorkspace({ git: runGit }, params)
      assert.ok(isError(second))
      assert.equal(second.kind === 'error' ? second.code : '', 'git-failed')
    } finally {
      repo.cleanup()
      home.cleanup()
    }
  })
})

describe('createTicketWorkspace in a real sha256 repository', () => {
  it('captures sha256-prefixed OIDs and verifies the object format', async () => {
    const repo = tempGitRepository({ objectFormat: 'sha256' })
    const home = tempRepositoryHome('sha256')
    try {
      assert.equal(repo.baseSha.length, 64)
      const outcome = await createTicketWorkspace(
        { git: runGit },
        {
          repositoryRoot: repo.root,
          repositoryHome: home.home,
          repositoryId: 'R_1',
          runId: 'run-6',
          ticketNumber: 1,
          workAttemptId: 'wa-1',
          base: { sha: `sha256:${repo.baseSha}`, treeOid: `sha256:${repo.baseTreeHex}` },
        },
      )
      assert.ok(isOk(outcome))
      if (outcome.kind !== 'ok') return
      assert.equal(gitText(outcome.value.path, ['rev-parse', 'HEAD']), repo.baseSha)
      assert.equal(gitText(outcome.value.path, ['status', '--porcelain']), '')
    } finally {
      repo.cleanup()
      home.cleanup()
    }
  })

  it('refuses sha1-prefixed OIDs against a sha256 repository', async () => {
    const repo = tempGitRepository({ objectFormat: 'sha256' })
    const home = tempRepositoryHome('sha256-mismatch')
    try {
      const outcome = await createTicketWorkspace(
        { git: runGit },
        {
          repositoryRoot: repo.root,
          repositoryHome: home.home,
          repositoryId: 'R_1',
          runId: 'run-6',
          ticketNumber: 2,
          workAttemptId: 'wa-1',
          base: { sha: `sha1:${'a'.repeat(40)}`, treeOid: `sha1:${'b'.repeat(40)}` },
        },
      )
      assert.ok(isError(outcome))
      assert.equal(outcome.kind === 'error' ? outcome.code : '', 'object-format-mismatch')
    } finally {
      repo.cleanup()
      home.cleanup()
    }
  })
})

describe('createMapCompletionWorkspace in a real repository', () => {
  it('checks out exactly the completion commit, detached, without a branch', async () => {
    const repo = tempGitRepository()
    const home = tempRepositoryHome('map-completion')
    try {
      const outcome = await createMapCompletionWorkspace(
        { git: runGit },
        {
          repositoryRoot: repo.root,
          repositoryHome: home.home,
          repositoryId: 'R_1',
          runId: 'run-8',
          completionAttemptId: 'mc-1',
          completion: { sha: `sha1:${repo.baseSha}`, treeOid: `sha1:${repo.baseTreeHex}` },
        },
      )
      assert.ok(isOk(outcome))
      if (outcome.kind !== 'ok') return
      const workspace = outcome.value
      assert.equal(workspace.kind, 'map-completion')
      assert.equal(workspace.path, join(home.home, 'runs', 'run-8', 'workspaces', 'map', 'mc-1'))

      assert.equal(gitText(workspace.path, ['rev-parse', 'HEAD']), repo.baseSha)
      assert.equal(gitText(workspace.path, ['rev-parse', '--symbolic-full-name', 'HEAD']), 'HEAD')
      assert.equal(gitText(workspace.path, ['status', '--porcelain']), '')
      assert.equal(
        gitText(repo.root, ['for-each-ref', '--format=%(refname)', `refs/heads/norn/run-8/**`]),
        '',
      )
    } finally {
      repo.cleanup()
      home.cleanup()
    }
  })
})

describe('workspace inspection with ignored residue', () => {
  it('never counts ignored dependency directories as changes', async () => {
    const repo = tempGitRepository({ ignoreNodeModules: true })
    const home = tempRepositoryHome('ignored')
    try {
      const outcome = await createTicketWorkspace(
        { git: runGit },
        {
          repositoryRoot: repo.root,
          repositoryHome: home.home,
          repositoryId: 'R_1',
          runId: 'run-9',
          ticketNumber: 3,
          workAttemptId: 'wa-1',
          base: { sha: `sha1:${repo.baseSha}`, treeOid: `sha1:${repo.baseTreeHex}` },
        },
      )
      assert.ok(isOk(outcome))
      if (outcome.kind !== 'ok') return

      // A dependency and cache directory may remain in the workspace.
      const nodeModules = join(outcome.value.path, 'node_modules', 'left-pad')
      mkdirSync(nodeModules, { recursive: true })
      writeFileSync(join(nodeModules, 'index.js'), '// cache\n', 'utf8')

      const inspection = await inspectWorkspace(runGit, outcome.value.path)
      assert.equal(inspection.status, 'ok')
      if (inspection.status !== 'ok') return
      assert.deepEqual(inspection.state.status, [])
      assert.equal(inspection.state.head, `sha1:${repo.baseSha}`)
      assert.equal(inspection.state.headTree, `sha1:${repo.baseTreeHex}`)

      // A single non-ignored untracked file is residue and is reported.
      writeFileSync(join(outcome.value.path, 'residue.txt'), 'x\n', 'utf8')
      const dirty = await inspectWorkspace(runGit, outcome.value.path)
      assert.equal(dirty.status, 'ok')
      if (dirty.status !== 'ok') return
      assert.deepEqual(dirty.state.status, ['?? residue.txt'])
    } finally {
      repo.cleanup()
      home.cleanup()
    }
  })
})
