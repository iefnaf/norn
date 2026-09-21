import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  NORN_SUBCOMMANDS,
  commandSummary,
  parseNornInvocation,
} from '../src/runner/commands.ts'

describe('NORN_SUBCOMMANDS catalog', () => {
  it('declares exactly the five subcommands in canonical order', () => {
    assert.deepEqual(
      NORN_SUBCOMMANDS.map((entry) => entry.name),
      ['init', 'check', 'run', 'status', 'abort'],
    )
  })

  it('takes a map URL for every subcommand except init', () => {
    for (const entry of NORN_SUBCOMMANDS) {
      assert.equal(entry.takesMapUrl, entry.name !== 'init')
      if (entry.takesMapUrl) {
        assert.match(entry.usage, /<map-url>$/)
      } else {
        assert.equal(entry.usage, '/norn init')
      }
    }
  })

  it('carries a non-empty description for every subcommand', () => {
    for (const entry of NORN_SUBCOMMANDS) {
      assert.ok(entry.description.length > 0, entry.name)
    }
  })
})

describe('commandSummary', () => {
  it('returns typed summary data over the catalog', () => {
    const summary = commandSummary()
    assert.equal(summary.command, 'norn')
    assert.equal(summary.tagline, 'Weave the graph. Prove the outcome.')
    assert.equal(summary.subcommands, NORN_SUBCOMMANDS)
  })
})

describe('parseNornInvocation', () => {
  it('treats empty and whitespace-only input as the summary request', () => {
    assert.deepEqual(parseNornInvocation(''), { kind: 'summary' })
    assert.deepEqual(parseNornInvocation('   \t '), { kind: 'summary' })
  })

  it('recognizes a bare subcommand with no arguments', () => {
    const parsed = parseNornInvocation('init')
    assert.equal(parsed.kind, 'subcommand')
    if (parsed.kind === 'subcommand') {
      assert.equal(parsed.subcommand.name, 'init')
      assert.equal(parsed.args, '')
    }
  })

  it('splits the first token and preserves the remaining arguments', () => {
    const url = 'https://github.com/iefnaf/taskflow-dag-demo/issues/6'
    const parsed = parseNornInvocation(`  run   ${url}  `)
    assert.equal(parsed.kind, 'subcommand')
    if (parsed.kind === 'subcommand') {
      assert.equal(parsed.subcommand.name, 'run')
      assert.equal(parsed.args, url)
    }
  })

  it('rejects unknown input without guessing', () => {
    for (const input of ['frobnicate', '#123', 'Init', 'RUN https://x/issues/1']) {
      const parsed = parseNornInvocation(input)
      assert.equal(parsed.kind, 'unknown', input)
      if (parsed.kind === 'unknown') {
        assert.equal(parsed.input, input.trim())
      }
    }
  })
})
