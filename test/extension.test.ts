import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import nornExtension from '../src/extension/index.ts'
import {
  NORN_SUBCOMMANDS,
  commandSummary,
} from '../src/runner/commands.ts'
import { renderSummary } from '../src/extension/render.ts'

type NotifyCall = { message: string; level: string }

type RegisteredCommand = {
  name: string
  def: {
    description?: string
    handler: (args: string, ctx: unknown) => Promise<void>
  }
}

function fakePi() {
  const commands: RegisteredCommand[] = []
  return {
    commands,
    registerCommand(name: string, def: RegisteredCommand['def']) {
      commands.push({ name, def })
    },
  }
}

function fakeCtx(hasUI: boolean) {
  const notifications: NotifyCall[] = []
  return {
    notifications,
    ctx: {
      hasUI,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level })
        },
      },
    },
  }
}

function registeredNorn() {
  const pi = fakePi()
  nornExtension(pi as never)
  return pi
}

describe('extension registration', () => {
  it('registers exactly one command, named norn', () => {
    const pi = registeredNorn()
    assert.equal(pi.commands.length, 1)
    assert.equal(pi.commands[0]?.name, 'norn')
    assert.ok((pi.commands[0]?.def.description ?? '').length > 0)
  })
})

describe('bare /norn renders the runner-provided summary', () => {
  it('notifies once with every catalog usage and description', async () => {
    const pi = registeredNorn()
    const { ctx, notifications } = fakeCtx(true)

    await pi.commands[0]!.def.handler('', ctx)

    assert.equal(notifications.length, 1)
    const message = notifications[0]!.message
    assert.equal(notifications[0]!.level, 'info')

    const summary = commandSummary()
    assert.ok(message.includes(summary.tagline))
    for (const entry of NORN_SUBCOMMANDS) {
      assert.ok(message.includes(entry.usage), entry.usage)
      assert.ok(message.includes(entry.description), entry.description)
    }
  })

  it('renders from the typed catalog, not from extension prose', () => {
    const rendered = renderSummary(commandSummary())
    for (const entry of NORN_SUBCOMMANDS) {
      assert.ok(rendered.includes(entry.usage))
    }
  })
})

describe('subcommand routing before implementation', () => {
  it('reports a recognized subcommand as pending with its description', async () => {
    const pi = registeredNorn()
    const { ctx, notifications } = fakeCtx(true)

    await pi.commands[0]!.def.handler('run https://github.com/o/r/issues/1', ctx)

    assert.equal(notifications.length, 1)
    assert.match(notifications[0]!.message, /not implemented yet/)
    assert.match(notifications[0]!.message, /run/)
  })

  it('shows the summary again after unknown input', async () => {
    const pi = registeredNorn()
    const { ctx, notifications } = fakeCtx(true)

    await pi.commands[0]!.def.handler('#123', ctx)

    assert.equal(notifications.length, 1)
    assert.match(notifications[0]!.message, /#123/)
    for (const entry of NORN_SUBCOMMANDS) {
      assert.ok(notifications[0]!.message.includes(entry.usage), entry.usage)
    }
  })
})

describe('modes without UI', () => {
  it('does nothing when there is no UI surface', async () => {
    const pi = registeredNorn()
    const { ctx, notifications } = fakeCtx(false)

    await pi.commands[0]!.def.handler('', ctx)
    await pi.commands[0]!.def.handler('init', ctx)

    assert.equal(notifications.length, 0)
  })
})
