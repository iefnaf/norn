import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { isOk } from '../src/core/outcome.ts'
import {
  gitCliRepository,
  normalizeHost,
  parseGitRemoteUrl,
} from '../src/adapters/git-repository.ts'
import type { GitCommandResult, GitCommandRunner } from '../src/adapters/git-repository.ts'
import { plausibleRemoteIdentities } from '../src/runner/init.ts'
import type { GitRemote } from '../src/adapters/git-repository.ts'

describe('parseGitRemoteUrl', () => {
  it('parses https URLs with and without .git and trailing slash', () => {
    assert.deepEqual(parseGitRemoteUrl('https://github.com/owner/repo.git'), {
      host: 'github.com',
      owner: 'owner',
      name: 'repo',
    })
    assert.deepEqual(parseGitRemoteUrl('https://github.com/Owner/Repo/'), {
      host: 'github.com',
      owner: 'Owner',
      name: 'Repo',
    })
  })

  it('normalizes host case and the default https port', () => {
    assert.equal(parseGitRemoteUrl('https://GitHub.com:443/o/r.git')?.host, 'github.com')
    assert.equal(parseGitRemoteUrl('https://GHE.Example.com/o/r.git')?.host, 'ghe.example.com')
  })

  it('keeps an explicit non-default port in the host', () => {
    assert.equal(parseGitRemoteUrl('https://ghe.example.com:8443/o/r.git')?.host, 'ghe.example.com:8443')
  })

  it('parses ssh URLs and scp-style URLs', () => {
    assert.deepEqual(parseGitRemoteUrl('ssh://git@github.com/owner/repo.git'), {
      host: 'github.com',
      owner: 'owner',
      name: 'repo',
    })
    assert.deepEqual(parseGitRemoteUrl('ssh://git@github.com:22/owner/repo.git'), {
      host: 'github.com',
      owner: 'owner',
      name: 'repo',
    })
    assert.deepEqual(parseGitRemoteUrl('git@github.com:owner/repo.git'), {
      host: 'github.com',
      owner: 'owner',
      name: 'repo',
    })
  })

  it('rejects paths that are not exactly owner/name', () => {
    assert.equal(parseGitRemoteUrl('https://github.com/owner'), undefined)
    assert.equal(parseGitRemoteUrl('https://github.com/owner/repo/sub'), undefined)
    assert.equal(parseGitRemoteUrl('https://github.com/'), undefined)
  })

  it('rejects unsupported schemes and plain paths', () => {
    assert.equal(parseGitRemoteUrl('git://github.com/owner/repo.git'), undefined)
    assert.equal(parseGitRemoteUrl('file:///srv/git/repo.git'), undefined)
    assert.equal(parseGitRemoteUrl('/local/path'), undefined)
    assert.equal(parseGitRemoteUrl('owner/repo'), undefined)
  })
})

describe('normalizeHost', () => {
  it('lowercases and strips the default https port', () => {
    assert.equal(normalizeHost('GitHub.COM'), 'github.com')
    assert.equal(normalizeHost('github.com:443'), 'github.com')
    assert.equal(normalizeHost('ghe.io:8443'), 'ghe.io:8443')
  })
})

describe('plausibleRemoteIdentities', () => {
  it('deduplicates remotes that resolve to the same repository', () => {
    const remotes: GitRemote[] = [
      { name: 'origin', url: 'git@github.com:owner/repo.git' },
      { name: 'github', url: 'https://github.com/owner/repo.git' },
    ]
    const plausible = plausibleRemoteIdentities(remotes)
    assert.equal(plausible.length, 1)
    assert.deepEqual(plausible[0]!.remoteNames, ['github', 'origin'])
    assert.equal(plausible[0]!.githubHost, 'github.com')
    assert.equal(plausible[0]!.owner, 'owner')
    assert.equal(plausible[0]!.name, 'repo')
  })

  it('keeps distinct identities in deterministic order and requires explicit selection', () => {
    const remotes: GitRemote[] = [
      { name: 'origin', url: 'https://github.com/owner/repo.git' },
      { name: 'upstream', url: 'https://github.com/other/project.git' },
    ]
    const plausible = plausibleRemoteIdentities(remotes)
    assert.equal(plausible.length, 2)
    assert.deepEqual(
      plausible.map((entry) => `${entry.owner}/${entry.name}`),
      ['other/project', 'owner/repo'],
    )
  })

  it('ignores unparseable remotes entirely', () => {
    const remotes: GitRemote[] = [
      { name: 'local', url: '/srv/git/repo.git' },
      { name: 'gitproto', url: 'git://github.com/owner/repo.git' },
    ]
    assert.deepEqual(plausibleRemoteIdentities(remotes), [])
  })
})

describe('gitCliRepository with an injected runner', () => {
  it('parses git remote -v output into named remotes', async () => {
    const run = async (): Promise<GitCommandResult> => ({
      ok: true,
      stdout: [
        'origin\thttps://github.com/owner/repo.git (fetch)',
        'origin\tgit@github.com:owner/repo.git (push)',
        'upstream\thttps://github.com/other/project.git (fetch)',
        'upstream\thttps://github.com/other/project.git (push)',
      ].join('\n'),
    })
    const git = gitCliRepository(run)
    const remotes = await git.listRemotes('/repo')
    assert.ok(isOk(remotes))
    if (remotes.kind === 'ok') {
      assert.deepEqual(remotes.value, [
        { name: 'origin', url: 'https://github.com/owner/repo.git' },
        { name: 'upstream', url: 'https://github.com/other/project.git' },
      ])
    }
  })

  it('classifies not-a-repository stderr as a not-a-repository failure', async () => {
    const run = async (): Promise<GitCommandResult> => ({
      ok: false,
      failure: 'not-a-repository',
      message: 'fatal: not a git repository (or any of the parent directories): .git',
    })
    const git = gitCliRepository(run)
    const root = await git.resolveRoot('/nowhere')
    assert.equal(root.kind, 'error')
    if (root.kind === 'error') assert.equal(root.code, 'not-a-repository')
  })
})

describe('gitCliRepository against a real temporary repository', () => {
  function tempGitRepository(): { root: string; cleanupDir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'norn-git-adapter-'))
    execFileSync('git', ['init', '--quiet', dir])
    writeFileSync(join(dir, 'README.md'), '# temp\n', 'utf8')
    execFileSync('git', ['-C', dir, 'add', 'README.md'])
    execFileSync('git', ['-C', dir, 'commit', '--quiet', '--no-gpg-sign', '-m', 'init'])
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git'])
    return { root: dir, cleanupDir: dir }
  }

  it('resolves the repository root from a nested directory', async () => {
    const { root, cleanupDir } = tempGitRepository()
    try {
      const nested = join(root, 'deeply', 'nested')
      mkdirSync(nested, { recursive: true })
      const git = gitCliRepository()
      const resolved = await git.resolveRoot(nested)
      assert.ok(isOk(resolved))
      if (resolved.kind === 'ok') assert.equal(resolved.value, realpathSync(root))
    } finally {
      rmSync(cleanupDir, { recursive: true, force: true })
    }
  })

  it('lists the configured remotes with fetch URLs', async () => {
    const { root, cleanupDir } = tempGitRepository()
    try {
      const git = gitCliRepository()
      const remotes = await git.listRemotes(root)
      assert.ok(isOk(remotes))
      if (remotes.kind === 'ok') {
        assert.deepEqual(remotes.value, [
          { name: 'origin', url: 'https://github.com/owner/repo.git' },
        ])
      }
    } finally {
      rmSync(cleanupDir, { recursive: true, force: true })
    }
  })

  it('reports a plain directory as not-a-repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norn-not-a-repo-'))
    try {
      const git = gitCliRepository()
      const resolved = await git.resolveRoot(dir)
      assert.equal(resolved.kind, 'error')
      if (resolved.kind === 'error') assert.equal(resolved.code, 'not-a-repository')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates nothing inside the repository working tree while reading', async () => {
    const { root, cleanupDir } = tempGitRepository()
    try {
      const git = gitCliRepository()
      const before = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })
      await git.resolveRoot(root)
      await git.listRemotes(root)
      const after = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })
      assert.equal(after, before)
      assert.equal(after, '')
    } finally {
      rmSync(cleanupDir, { recursive: true, force: true })
    }
  })
})
