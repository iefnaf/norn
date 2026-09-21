import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import nornExtension from '../src/extension/index.ts'
import { executeCheckCommand } from '../src/extension/check-command.ts'
import type { CheckCommandAdapters } from '../src/extension/check-command.ts'
import { fsControlStore } from '../src/control/control-store.ts'
import type { GitRemote } from '../src/adapters/git-repository.ts'
import type { ResolvedGitHubRepository } from '../src/adapters/github-gateway.ts'
import type { TaskMapLoadOutcome } from '../src/map/loader.ts'
import { HOST, MAP_URL, REPO, member, memberA, memberB, rawLoad, rawRef } from './helpers/map-fixtures.ts'

type RegisteredCommand = {
  name: string
  def: {
    description?: string
    handler: (args: string, ctx: unknown) => Promise<void>
  }
}

function registeredNorn(): { commands: RegisteredCommand[] } {
  const commands: RegisteredCommand[] = []
  const pi = {
    registerCommand(name: string, def: RegisteredCommand['def']) {
      commands.push({ name, def })
    },
  }
  nornExtension(pi as never)
  return { commands }
}

function notifyOnlyUi() {
  const notifications: Array<{ message: string; level: string }> = []
  return {
    notifications,
    ui: {
      notify(message: string, level: 'info' | 'warning' | 'error') {
        notifications.push({ message, level })
      },
    },
  }
}

function fakeCtx(cwd: string, hasUI = true) {
  const { notifications, ui } = notifyOnlyUi()
  return { notifications, ctx: { cwd, hasUI, ui } }
}

const REPOSITORY: ResolvedGitHubRepository = {
  githubHost: HOST,
  repositoryId: REPO,
  owner: 'acme',
  name: 'widget',
  defaultBranch: 'main',
}

const VALID_CONFIG = `${JSON.stringify(
  {
    schema: 'norn-run:v1',
    targetBranch: 'main',
    tests: [{ argv: ['npm', 'test'], timeoutMs: 60_000 }],
    worker: { model: 'provider-a/model-x', thinking: 'medium', timeoutMs: 1_000 },
    reviewer: { model: 'provider-b/model-y', thinking: 'high', timeoutMs: 1_000 },
    trustedEvidenceAuthorIds: ['MDQ6VXlcjIxMzY3'],
  },
  null,
  2,
)}\n`

const REMOTES: readonly GitRemote[] = [{ name: 'origin', url: 'https://github.com/acme/widget.git' }]

function fakeAdapters(nornHome: string, readonlyScript: readonly TaskMapLoadOutcome[] = []): CheckCommandAdapters {
  const script = [...readonlyScript]
  return {
    git: {
      async resolveRoot(cwd: string) {
        return { kind: 'ok' as const, value: cwd }
      },
      async listRemotes() {
        return { kind: 'ok' as const, value: REMOTES }
      },
    },
    gateway: {
      async resolveRepository() {
        return { kind: 'ok' as const, value: REPOSITORY }
      },
      async authenticatedActor() {
        throw new Error('check does not resolve the actor')
      },
    },
    loader: {
      async loadTaskMap() {
        const outcome = script.shift()
        if (outcome === undefined) throw new Error('no scripted load left')
        return outcome
      },
    },
    store: fsControlStore(nornHome),
  }
}

async function initializedHome(): Promise<{ nornHome: string; cleanup: () => void }> {
  const nornHome = mkdtempSync(join(tmpdir(), 'norn-check-ext-'))
  const store = fsControlStore(nornHome)
  const home = store.repositoryHome({ githubHost: HOST, repositoryId: REPO })
  const written = await store.writeRepositorySetup(home, {
    metadataJson: `${JSON.stringify({ schema: 'norn-repository-metadata:v1' })}\n`,
    configJson: VALID_CONFIG,
  })
  assert.ok(written.kind === 'ok')
  return { nornHome, cleanup: () => rmSync(nornHome, { recursive: true, force: true }) }
}

const okLoad = (value: ReturnType<typeof rawLoad>): TaskMapLoadOutcome => ({ kind: 'ok', value })

describe('executeCheckCommand — rendering the typed outcome', () => {
  it('renders the passing preflight with the accepted snapshot', async () => {
    const { nornHome, cleanup } = await initializedHome()
    try {
      const repo = mkdtempSync(join(tmpdir(), 'norn-check-cwd-'))
      try {
        const load = rawLoad([memberA(), memberB()])
        const adapters = fakeAdapters(nornHome, [okLoad(load), okLoad(load)])
        const { notifications, ctx } = fakeCtx(repo)
        await executeCheckCommand(ctx, MAP_URL, adapters)
        assert.equal(notifications.length, 1)
        assert.equal(notifications[0]?.level, 'info')
        const message = notifications[0]!.message
        assert.match(message, /Norn check passed/)
        assert.match(message, /acme\/widget @ github\.com/)
        assert.match(message, /mapRevision: sha256:[0-9a-f]{64}/)
        assert.match(message, /#2 Ticket I_B \[open\] — blocked by #1/)
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    } finally {
      cleanup()
    }
  })

  it('renders every topology finding as its own line', async () => {
    const { nornHome, cleanup } = await initializedHome()
    try {
      const repo = mkdtempSync(join(tmpdir(), 'norn-check-cwd-'))
      try {
        const cycleA = member('I_A', 1, { blockers: [rawRef('I_B', 2)] })
        const cycleB = member('I_B', 2, { blockers: [rawRef('I_A', 1)] })
        const load = rawLoad([cycleA, cycleB])
        const adapters = fakeAdapters(nornHome, [okLoad(load), okLoad(load)])
        const { notifications, ctx } = fakeCtx(repo)
        await executeCheckCommand(ctx, MAP_URL, adapters)
        assert.equal(notifications[0]?.level, 'warning')
        const message = notifications[0]!.message
        assert.match(message, /Norn check found 1 finding\(s\):/)
        assert.match(message, /- the Task Map violates 1 topology rule\(s\):/)
        assert.match(message, /dependency cycle: I_A → I_B → I_A/)
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    } finally {
      cleanup()
    }
  })

  it('renders the full-URL requirement when #123 shorthand is used', async () => {
    const { nornHome, cleanup } = await initializedHome()
    try {
      const repo = mkdtempSync(join(tmpdir(), 'norn-check-cwd-'))
      try {
        const adapters = fakeAdapters(nornHome, [])
        const { notifications, ctx } = fakeCtx(repo)
        await executeCheckCommand(ctx, '#123', adapters)
        assert.equal(notifications[0]?.level, 'warning')
        assert.match(notifications[0]!.message, /is not a full GitHub issue URL/)
        assert.match(notifications[0]!.message, /#123/)
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    } finally {
      cleanup()
    }
  })

  it('renders an infrastructure error as a warning with its code', async () => {
    const { nornHome, cleanup } = await initializedHome()
    try {
      const repo = mkdtempSync(join(tmpdir(), 'norn-check-cwd-'))
      try {
        const adapters = fakeAdapters(nornHome, [
          { kind: 'error', scope: 'operation', code: 'github-unavailable', reason: 'dial tcp: timeout', sharedWrite: 'none', evidence: [] },
        ])
        const { notifications, ctx } = fakeCtx(repo)
        await executeCheckCommand(ctx, MAP_URL, adapters)
        assert.equal(notifications[0]?.level, 'warning')
        assert.match(notifications[0]!.message, /Norn check error \(github-unavailable\)/)
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    } finally {
      cleanup()
    }
  })
})

describe('/norn check routing in the registered extension', () => {
  it('requires a map URL argument without touching any adapter', async () => {
    const pi = registeredNorn()
    const { notifications, ctx } = fakeCtx(process.cwd())
    await pi.commands[0]!.def.handler('check', ctx)
    assert.equal(notifications.length, 1)
    assert.match(notifications[0]!.message, /takes exactly one full GitHub issue URL/)
  })

  it('reports shorthand input through the real read-only pipeline', async () => {
    const pi = registeredNorn()
    const plain = mkdtempSync(join(tmpdir(), 'norn-plain-dir-'))
    try {
      const { notifications, ctx } = fakeCtx(plain)
      await pi.commands[0]!.def.handler('check #123', ctx)
      // Production adapters run, but #123 never reaches GitHub: only the
      // local-repository and URL-syntax facts are discoverable.
      const message = notifications.at(-1)!.message
      assert.match(message, /Norn check found/)
      assert.match(message, /not inside a Git repository/)
      assert.match(message, /is not a full GitHub issue URL/)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('does nothing without a UI surface', async () => {
    const pi = registeredNorn()
    const { notifications, ctx } = fakeCtx(process.cwd(), false)
    await pi.commands[0]!.def.handler(`check ${MAP_URL}`, ctx)
    assert.deepEqual(notifications, [])
  })
})
