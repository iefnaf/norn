import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isError, isOk } from '../src/core/outcome.ts'
import { gitCliDeliveryFacts } from '../src/adapters/git-repository.ts'
import type { GitFactsCommandResult, GitFactsCommandRunner } from '../src/adapters/git-repository.ts'

const ROOT = '/repo'
const SHA = `sha1:${'1'.repeat(40)}`
const BASE = `sha1:${'2'.repeat(40)}`
const TIP = `sha1:${'f'.repeat(40)}`

/** Script one `run` invocation; unmatched calls fail the test. */
function scriptRunner(script: readonly { args: readonly string[]; result: GitFactsCommandResult }[]) {
  let call = 0
  const seen: string[][] = []
  const run: GitFactsCommandRunner = async (args) => {
    seen.push([...args])
    const step = script[call]
    call += 1
    if (step === undefined) throw new Error(`unexpected git invocation #${call}: ${args.join(' ')}`)
    assert.deepEqual(args, step.args)
    return step.result
  }
  return { run, seen }
}

describe('gitCliDeliveryFacts with an injected runner', () => {
  it('fetches the remote target branch exactly as asked', async () => {
    const { run, seen } = scriptRunner([
      { args: ['fetch', 'origin', 'main'], result: { ok: true, stdout: '' } },
    ])
    const facts = gitCliDeliveryFacts(run)
    const outcome = await facts.fetchTarget(ROOT, 'origin', 'main')
    assert.ok(isOk(outcome))
    assert.deepEqual(seen, [['fetch', 'origin', 'main']])
  })

  it('resolves the fetched target tip through the remote-tracking ref', async () => {
    const { run } = scriptRunner([
      { args: ['rev-parse', 'refs/remotes/origin/main'], result: { ok: true, stdout: `${TIP}\n` } },
    ])
    const outcome = await gitCliDeliveryFacts(run).targetSha(ROOT, 'origin', 'main')
    assert.ok(isOk(outcome))
    if (outcome.kind === 'ok') assert.equal(outcome.value, TIP)
  })

  it('reports commit facts as tree plus parents, including the no-parent case', async () => {
    const { run } = scriptRunner([
      {
        args: ['rev-parse', '--verify', '--quiet', `${SHA}^{commit}`],
        result: { ok: true, stdout: `${SHA}\n` },
      },
      {
        args: ['show', '-s', '--format=%T%n%P', SHA],
        result: { ok: true, stdout: `sha1:${'3'.repeat(40)}\n\n` },
      },
    ])
    const outcome = await gitCliDeliveryFacts(run).commitFacts(ROOT, SHA)
    assert.ok(isOk(outcome))
    if (outcome.kind === 'ok' && outcome.value !== undefined) {
      assert.equal(outcome.value.treeOid, `sha1:${'3'.repeat(40)}`)
      assert.deepEqual(outcome.value.parents, [])
    }

    const withParent = scriptRunner([
      {
        args: ['rev-parse', '--verify', '--quiet', `${SHA}^{commit}`],
        result: { ok: true, stdout: `${SHA}\n` },
      },
      {
        args: ['show', '-s', '--format=%T%n%P', SHA],
        result: { ok: true, stdout: `sha1:${'3'.repeat(40)}\n${BASE}\n` },
      },
    ])
    const second = await gitCliDeliveryFacts(withParent.run).commitFacts(ROOT, SHA)
    if (second.kind === 'ok' && second.value !== undefined) {
      assert.deepEqual(second.value.parents, [BASE])
    }
  })

  it('answers undefined when the quiet rev-parse proves the object absent', async () => {
    const { run } = scriptRunner([
      {
        args: ['rev-parse', '--verify', '--quiet', `${SHA}^{commit}`],
        result: { ok: false, exitCode: 1, message: 'Command failed: git rev-parse' },
      },
    ])
    const outcome = await gitCliDeliveryFacts(run).commitFacts(ROOT, SHA)
    assert.ok(isOk(outcome))
    if (outcome.kind === 'ok') assert.equal(outcome.value, undefined)
  })

  it('answers ancestry from the merge-base exit status', async () => {
    const ancestor = scriptRunner([
      {
        args: ['merge-base', '--is-ancestor', SHA, 'refs/remotes/origin/main'],
        result: { ok: true, stdout: '' },
      },
    ])
    const yes = await gitCliDeliveryFacts(ancestor.run).isAncestorOfTarget(ROOT, 'origin', 'main', SHA)
    assert.ok(isOk(yes) && yes.value === true)

    const notAncestor = scriptRunner([
      {
        args: ['merge-base', '--is-ancestor', SHA, 'refs/remotes/origin/main'],
        result: { ok: false, exitCode: 1, message: 'Command failed: git merge-base' },
      },
    ])
    const no = await gitCliDeliveryFacts(notAncestor.run).isAncestorOfTarget(ROOT, 'origin', 'main', SHA)
    assert.ok(isOk(no) && no.value === false)
  })

  it('surfaces a missing git binary as git-unavailable and other failures as git-failed', async () => {
    const unavailable = gitCliDeliveryFacts(async () => ({
      ok: false as const,
      exitCode: undefined,
      message: 'the git CLI is not installed or not on PATH',
    }))
    const missing = await unavailable.targetSha(ROOT, 'origin', 'main')
    assert.ok(isError(missing))
    if (missing.kind === 'error') assert.equal(missing.code, 'git-unavailable')

    const failing = gitCliDeliveryFacts(async () => ({
      ok: false as const,
      exitCode: 128,
      message: 'fatal: bad object HEAD',
    }))
    const corrupt = await failing.commitFacts(ROOT, SHA)
    assert.ok(isError(corrupt))
    if (corrupt.kind === 'error') assert.equal(corrupt.code, 'git-failed')
  })
})
