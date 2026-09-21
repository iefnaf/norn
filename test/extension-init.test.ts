import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import nornExtension from '../src/extension/index.ts'
import { executeInitCommand } from '../src/extension/init-command.ts'
import { fsControlStore } from '../src/control/control-store.ts'
import { fakeCatalogModels, type FakeDialogUi } from './helpers/fake-dialog-ui.ts'

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

/** A scripted Pi command context: dialogs follow operator scripts. */
function fakeCtx(options: { cwd: string; ui: FakeDialogUi; hasUI?: boolean }) {
  const notifications: Array<{ message: string; level: string }> = []
  return {
    notifications,
    ctx: {
      cwd: options.cwd,
      hasUI: options.hasUI ?? true,
      modelRegistry: {
        async refresh() {
          return undefined
        },
        getAvailable() {
          return []
        },
      },
      ui: {
        async select(title: string, optionList: readonly string[]) {
          return options.ui.select(title, optionList)
        },
        async confirm(title: string, message: string) {
          return options.ui.confirm(title, message)
        },
        async input(title: string, placeholder?: string) {
          return options.ui.input(title, placeholder)
        },
        notify(message: string, level: 'info' | 'warning' | 'error') {
          notifications.push({ message, level })
        },
      },
    },
  }
}

/** The happy-path operator: accepts every suggestion, adds one test command. */
function acceptingUi(): FakeDialogUi {
  return {
    async select(title, options) {
      if (title.includes('worker model')) {
        return options.find((option) => option.startsWith('provider-a/model-x')) ?? options[0]
      }
      if (title.includes('reviewer model')) {
        return options.find((option) => option.startsWith('provider-b/model-y')) ?? options[0]
      }
      if (title.includes('thinking')) {
        return options.includes('medium') ? 'medium' : 'high'
      }
      return options[0]
    },
    async confirm(title) {
      if (title.startsWith('Add setup')) return false
      return title.startsWith('Add tests command #1')
    },
    async input(title) {
      if (title.includes('argv')) return 'npm test'
      return '' // accept every suggested value
    },
  }
}

function fakeAdapters(cwd: string, store: ReturnType<typeof fsControlStore>) {
  return {
    cwd,
    git: {
      async resolveRoot() {
        return { kind: 'ok' as const, value: cwd }
      },
      async listRemotes() {
        return {
          kind: 'ok' as const,
          value: [{ name: 'origin', url: 'https://github.com/iefnaf/norn.git' }],
        }
      },
    },
    gateway: {
      async resolveRepository() {
        return {
          kind: 'ok' as const,
          value: {
            githubHost: 'github.com',
            repositoryId: 'R_kgDOB123',
            owner: 'iefnaf',
            name: 'norn',
            defaultBranch: 'main',
          },
        }
      },
      async authenticatedActor() {
        return { kind: 'ok' as const, value: { id: 'I_actor', login: 'operator' } }
      },
    },
    catalog: fakeCatalogModels(),
    store,
  }
}

describe('executeInitCommand through the real dialog interaction', () => {
  it('runs the full flow and renders the success report', async () => {
    const nornHome = mkdtempSync(join(tmpdir(), 'norn-ext-home-'))
    const repoTree = mkdtempSync(join(tmpdir(), 'norn-ext-repo-'))
    try {
      const { ctx, notifications } = fakeCtx({ cwd: repoTree, ui: acceptingUi() })
      const deps = fakeAdapters(repoTree, fsControlStore(nornHome))
      await executeInitCommand(ctx, deps as never)

      // The dialog interaction itself may notify informational text; the
      // outcome report is always the final notification.
      const report = notifications.at(-1)!
      assert.equal(notifications.length > 0, true)
      assert.equal(report.level, 'info')
      const message = report.message
      assert.match(message, /Norn repository initialized/)
      assert.match(message, /iefnaf\/norn @ github\.com/)
      assert.match(message, /configRevision: sha256:[0-9a-f]{64}/)
      assert.match(message, /Target branch: main/)
      assert.match(message, /Worker: provider-a\/model-x/)
      assert.match(message, /Reviewer: provider-b\/model-y/)

      const home = join(nornHome, 'repositories', 'github.com', 'R_kgDOB123')
      assert.ok(existsSync(join(home, 'config.json')))
      const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
      assert.equal(config.targetBranch, 'main')
      assert.deepEqual(config.tests, [{ argv: ['npm', 'test'], timeoutMs: 120_000 }])
      assert.deepEqual(config.trustedEvidenceAuthorIds, ['I_actor'])
      // Nothing was created inside the target repository working tree.
      assert.deepEqual(readdirSync(repoTree), [])
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
      rmSync(repoTree, { recursive: true, force: true })
    }
  })

  it('renders a blocked report when the operator declines replacement', async () => {
    const nornHome = mkdtempSync(join(tmpdir(), 'norn-ext-home-'))
    const repoTree = mkdtempSync(join(tmpdir(), 'norn-ext-repo-'))
    try {
      const home = join(nornHome, 'repositories', 'github.com', 'R_kgDOB123')
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync(home, { recursive: true })
      writeFileSync(
        join(home, 'config.json'),
        JSON.stringify({ schema: 'norn-run:v1' }),
        'utf8',
      )

      const ui = acceptingUi()
      const declining: FakeDialogUi = {
        ...ui,
        async confirm(title, message) {
          return title.startsWith('Replace') ? false : ui.confirm(title, message)
        },
      }
      const { ctx, notifications } = fakeCtx({ cwd: repoTree, ui: declining })
      const deps = fakeAdapters(repoTree, fsControlStore(nornHome))
      await executeInitCommand(ctx, deps as never)

      const report = notifications.at(-1)!
      assert.equal(report.level, 'warning')
      assert.match(report.message, /operator-cancelled/)
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
      rmSync(repoTree, { recursive: true, force: true })
    }
  })

  it('renders a blocked report when a dialog is cancelled', async () => {
    const nornHome = mkdtempSync(join(tmpdir(), 'norn-ext-home-'))
    const repoTree = mkdtempSync(join(tmpdir(), 'norn-ext-repo-'))
    try {
      const cancelling: FakeDialogUi = {
        async select() {
          return undefined
        },
        async confirm() {
          return false
        },
        async input() {
          return undefined
        },
      }
      const { ctx, notifications } = fakeCtx({ cwd: repoTree, ui: cancelling })
      const deps = fakeAdapters(repoTree, fsControlStore(nornHome))
      await executeInitCommand(ctx, deps as never)

      const report = notifications.at(-1)!
      assert.equal(report.level, 'warning')
      assert.match(report.message, /operator-cancelled/)
      assert.equal(existsSync(join(nornHome, 'repositories')), false)
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
      rmSync(repoTree, { recursive: true, force: true })
    }
  })
})

describe('/norn init routing in the registered extension', () => {
  it('reports a directory outside any Git repository as blocked', async () => {
    const pi = registeredNorn()
    const plain = mkdtempSync(join(tmpdir(), 'norn-plain-dir-'))
    try {
      const { ctx, notifications } = fakeCtx({ cwd: plain, ui: acceptingUi() })
      await pi.commands[0]!.def.handler('init', ctx)
      const report = notifications.at(-1)!
      assert.match(report.message, /not-a-repository/)
      assert.equal(report.level, 'warning')
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('reports a Git repository without plausible remotes as blocked', async () => {
    const pi = registeredNorn()
    const repo = mkdtempSync(join(tmpdir(), 'norn-remoteless-repo-'))
    try {
      execFileSync('git', ['init', '--quiet', repo])
      const { ctx, notifications } = fakeCtx({ cwd: repo, ui: acceptingUi() })
      await pi.commands[0]!.def.handler('init', ctx)
      const report = notifications.at(-1)!
      assert.match(report.message, /no-github-remote/)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('rejects arguments to /norn init without starting the flow', async () => {
    const pi = registeredNorn()
    const plain = mkdtempSync(join(tmpdir(), 'norn-plain-dir-'))
    try {
      const { ctx, notifications } = fakeCtx({ cwd: plain, ui: acceptingUi() })
      await pi.commands[0]!.def.handler('init https://github.com/o/r/issues/1', ctx)
      const report = notifications.at(-1)!
      assert.match(report.message, /takes no arguments/)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('does nothing without a UI surface, even for init', async () => {
    const pi = registeredNorn()
    const plain = mkdtempSync(join(tmpdir(), 'norn-plain-dir-'))
    try {
      const { ctx, notifications } = fakeCtx({ cwd: plain, ui: acceptingUi(), hasUI: false })
      await pi.commands[0]!.def.handler('init', ctx)
      assert.deepEqual(notifications, [])
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
