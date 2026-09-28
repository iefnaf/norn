/**
 * The staged progress comments of ticket #40 (design.md §10.2, §12, §15):
 * pure rendering of the round handoff, review verdict, park, and map
 * completion findings comments, plus their identity markers and the
 * scan-before-write posting engine with side-record semantics.
 *
 * Everything here is deterministic: identical inputs render identical
 * bytes, so replays can compare whole bodies for idempotency — exactly the
 * contract the delivered comment established (#35).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { error, ok } from '../src/core/outcome.ts'
import type { IssueEvidenceReadOutcome } from '../src/evidence/read.ts'
import {
  FINDINGS_MARKER_PREFIX,
  HANDOFF_MARKER_PREFIX,
  PARKED_MARKER_PREFIX,
  VERDICT_MARKER_PREFIX,
  completionGateDetailOf,
  excerptOf,
  findingsMarker,
  handoffMarker,
  parkedMarker,
  postProgressComment,
  renderCompletionFindingsComment,
  renderHandoffComment,
  renderParkedComment,
  renderVerdictComment,
  sanitizeStagedProse,
  verdictMarker,
} from '../src/run/progress-comments.ts'

const IDENTITY = { runId: 'run-1', ticketNumber: 7, workAttemptId: 'wa-w1-t7', round: 1 } as const
const BASE = 'sha1:' + 'c'.repeat(40)
const CANDIDATE = { commit: 'sha1:' + 'a'.repeat(40), treeOid: 'sha1:' + 'b'.repeat(40), zeroDelta: false }

describe('staged comment markers', () => {
  it('binds a handoff and verdict marker to run, ticket, attempt, and round', () => {
    const round2 = { ...IDENTITY, round: 2 }
    assert.equal(handoffMarker(round2), '<!-- norn:handoff run-1#7@wa-w1-t7/r2 -->')
    assert.equal(verdictMarker(round2), '<!-- norn:verdict run-1#7@wa-w1-t7/r2 -->')
    assert.ok(handoffMarker(round2).startsWith(HANDOFF_MARKER_PREFIX))
    assert.ok(verdictMarker(round2).startsWith(VERDICT_MARKER_PREFIX))
  })

  it('separates handoff and verdict markers of the same round', () => {
    assert.notEqual(handoffMarker(IDENTITY), verdictMarker(IDENTITY))
  })

  it('separates markers across attempts of the same run and across runs', () => {
    const otherAttempt = { ...IDENTITY, workAttemptId: 'wa-w2-t7' }
    const otherRun = { ...IDENTITY, runId: 'run-2' }
    assert.notEqual(handoffMarker(IDENTITY), handoffMarker(otherAttempt))
    assert.notEqual(handoffMarker(IDENTITY), handoffMarker(otherRun))
    assert.notEqual(verdictMarker(IDENTITY), verdictMarker(otherAttempt))
    assert.notEqual(parkedMarker('run-1', 7), parkedMarker('run-2', 7))
    assert.notEqual(findingsMarker('run-1', 'run-1-mc1'), findingsMarker('run-1', 'run-1-mc2'))
  })

  it('binds the park marker to one run and ticket', () => {
    assert.equal(parkedMarker('run-1', 7), '<!-- norn:parked run-1#7 -->')
    assert.ok(parkedMarker('run-1', 7).startsWith(PARKED_MARKER_PREFIX))
  })

  it('binds the findings marker to one completion attempt', () => {
    assert.equal(findingsMarker('run-1', 'run-1-mc1'), '<!-- norn:findings run-1@run-1-mc1 -->')
    assert.ok(findingsMarker('run-1', 'run-1-mc1').startsWith(FINDINGS_MARKER_PREFIX))
  })
})

describe('sanitizeStagedProse', () => {
  it('redacts every norn machine-marker word from agent prose', () => {
    assert.equal(
      sanitizeStagedProse('the <!-- norn:record --> marker and norn:delivered plus norn:handoff text'),
      'the <!-- norn:… --> marker and norn:… plus norn:… text',
    )
  })

  it('leaves ordinary prose untouched and is deterministic', () => {
    const prose = 'Standards axis: the file lacks tests. nornish names stay.'
    assert.equal(sanitizeStagedProse(prose), prose)
    assert.equal(sanitizeStagedProse(prose), sanitizeStagedProse(prose))
  })
})

describe('renderHandoffComment', () => {
  const input = {
    identity: IDENTITY,
    language: 'en' as const,
    summary: '## Summary\n\nthe shape of the change\n\n## Evidence\n\nbefore/after\n\n## Merge Danger\n\n**Door:** two-way',
    base: BASE,
    candidate: CANDIDATE,
  }

  it('renders the marker, headline, the worker summary verbatim, and candidate facts', () => {
    const body = renderHandoffComment(input)
    assert.ok(body.startsWith('<!-- norn:handoff run-1#7@wa-w1-t7/r1 -->'))
    assert.match(body, /^Round 1 work handoff: the worker settled candidate `aaaaaaa/m)
    assert.match(body, /## Merge Danger/)
    assert.match(body, /\*\*Door:\*\* two-way/)
    assert.match(body, /\*\*Base\*\* `ccccccc` → candidate `aaaaaaa` · tree `bbbbbbb`/)
    assert.doesNotMatch(body, /zero-delta/i)
  })

  it('marks a zero-delta handoff explicitly', () => {
    const body = renderHandoffComment({
      ...input,
      candidate: { ...CANDIDATE, zeroDelta: true },
    })
    assert.match(body, /zero-delta: the candidate tree equals the base/)
  })

  it('renders the Chinese shape for commentLanguage zh', () => {
    const body = renderHandoffComment({
      ...input,
      language: 'zh',
      identity: { ...IDENTITY, round: 2 },
      candidate: { ...CANDIDATE, zeroDelta: true },
    })
    assert.ok(body.startsWith('<!-- norn:handoff '))
    assert.match(body, /第 2 轮实现交付/)
    assert.match(body, /零差异：候选树与 base 相同。/)
  })

  it('sanitizes marker words inside the summary', () => {
    const body = renderHandoffComment({ ...input, summary: 'mentions norn:record inside' })
    assert.doesNotMatch(body, /norn:record/)
    assert.match(body, /norn:…/)
  })

  it('is deterministic for identical inputs', () => {
    assert.equal(renderHandoffComment(input), renderHandoffComment(input))
  })
})

describe('renderVerdictComment', () => {
  const reviewer = { model: 'provider-b/model-y', thinking: 'high' }

  it('renders pass with both axes and the reviewer identity', () => {
    const body = renderVerdictComment({
      identity: IDENTITY,
      language: 'en',
      verdict: { discriminant: 'pass' },
      reviewer,
    })
    assert.ok(body.startsWith('<!-- norn:verdict run-1#7@wa-w1-t7/r1 -->'))
    assert.match(body, /Round 1 review: \*\*pass\*\*/)
    assert.match(body, /Standards and Spec/)
    assert.match(body, /proceeds to Ship/)
    assert.match(body, /\*\*Reviewer\*\* `provider-b\/model-y` \(high\)/)
    assert.doesNotMatch(body, /## /)
  })

  it('renders iterate with the axis-labelled findings verbatim', () => {
    const body = renderVerdictComment({
      identity: IDENTITY,
      language: 'en',
      verdict: {
        discriminant: 'iterate',
        feedback: 'Standards axis: missing test coverage.\n\nSpec axis: the CLI flag is not handled.',
      },
      reviewer,
    })
    assert.match(body, /Round 1 review: \*\*iterate\*\*/)
    assert.match(body, /Standards axis: missing test coverage\./)
    assert.match(body, /Spec axis: the CLI flag is not handled\./)
    assert.match(body, /next worker round/)
  })

  it('sanitizes marker words inside the findings and renders zh', () => {
    const body = renderVerdictComment({
      identity: { ...IDENTITY, round: 3 },
      language: 'zh',
      verdict: { discriminant: 'iterate', feedback: 'norn:record 注入尝试' },
      reviewer,
    })
    assert.match(body, /第 3 轮评审：\*\*iterate\*\*/)
    assert.doesNotMatch(body, /norn:record/)
  })

  it('is deterministic for identical inputs', () => {
    const input = {
      identity: { ...IDENTITY, round: 2 },
      language: 'en' as const,
      verdict: { discriminant: 'iterate' as const, feedback: 'tighten' },
      reviewer,
    }
    assert.equal(renderVerdictComment(input), renderVerdictComment(input))
  })
})

describe('renderParkedComment', () => {
  it('renders the park outcome code and reason', () => {
    const body = renderParkedComment({
      runId: 'run-1',
      ticketNumber: 7,
      language: 'en',
      code: 'worker-block',
      reason: 'the worker blocked: cannot-satisfy-spec',
    })
    assert.ok(body.startsWith('<!-- norn:parked run-1#7 -->'))
    assert.match(body, /Parked for this run: `worker-block`/)
    assert.match(body, /the worker blocked: cannot-satisfy-spec/)
    assert.match(body, /later run/)
  })

  it('renders reviewer findings when a ship review gate failed', () => {
    const body = renderParkedComment({
      runId: 'run-1',
      ticketNumber: 7,
      language: 'en',
      code: 'ship-gate-failed',
      reason: 'the review gate of the reconciled candidate for ticket #7 did not pass',
      findings: 'Spec axis: the flag is not handled.',
    })
    assert.match(body, /\*\*Reviewer findings:\*\*/)
    assert.match(body, /Spec axis: the flag is not handled\./)
  })

  it('renders zh and stays deterministic', () => {
    const input = {
      runId: 'run-1',
      ticketNumber: 7,
      language: 'zh' as const,
      code: 'work-rounds-exhausted',
      reason: '三轮未过',
    }
    const body = renderParkedComment(input)
    assert.match(body, /本轮运行已搁置该 ticket/)
    assert.equal(body, renderParkedComment(input))
  })
})

describe('renderCompletionFindingsComment', () => {
  const reviewer = { model: 'provider-b/model-y', thinking: 'high' }

  it('renders an iterate completion review with the findings verbatim', () => {
    const body = renderCompletionFindingsComment({
      runId: 'run-1',
      completionAttemptId: 'run-1-mc1',
      language: 'en',
      gate: 'review',
      detail: { kind: 'review-iterate', feedback: 'Spec (blocking): the test aggregator misses count.test.js.' },
      reviewer,
    })
    assert.ok(body.startsWith('<!-- norn:findings run-1@run-1-mc1 -->'))
    assert.match(body, /Map completion review failed: \*\*iterate\*\*/)
    assert.match(body, /Map remains open/)
    assert.match(body, /Spec \(blocking\): the test aggregator misses count\.test\.js\./)
    assert.match(body, /\*\*Reviewer\*\* `provider-b\/model-y` \(high\)/)
  })

  it('renders a failed completion test with a bounded output excerpt', () => {
    const body = renderCompletionFindingsComment({
      runId: 'run-1',
      completionAttemptId: 'run-1-mc1',
      language: 'en',
      gate: 'tests',
      detail: {
        kind: 'command',
        argv: ['npm', 'test'],
        cause: 'non-zero-exit',
        exitCode: 1,
        stdout: 'x'.repeat(5_000),
        stderr: 'boom',
      },
    })
    assert.match(body, /Map completion tests failed:/)
    assert.match(body, /`npm test`/)
    assert.match(body, /exit 1/)
    assert.ok(body.length < 5_000, 'the command output must be excerpted, not inlined')
    assert.match(body, /…/)
  })

  it('renders a blocked completion review and the zh shape', () => {
    const en = renderCompletionFindingsComment({
      runId: 'run-1',
      completionAttemptId: 'run-1-mc1',
      language: 'en',
      gate: 'review',
      detail: { kind: 'review-block', code: 'spec-defect', reason: 'the spec contradicts itself' },
      reviewer,
    })
    assert.match(en, /\*\*block\*\* \(`spec-defect`\)/)
    assert.match(en, /the spec contradicts itself/)

    const zh = renderCompletionFindingsComment({
      runId: 'run-1',
      completionAttemptId: 'run-1-mc1',
      language: 'zh',
      gate: 'review',
      detail: { kind: 'review-iterate', feedback: '发现' },
      reviewer,
    })
    assert.match(zh, /地图完成评审未通过：\*\*iterate\*\*/)
    assert.match(zh, /地图保持开启/)
  })

  it('renders the unknown shape generically', () => {
    const body = renderCompletionFindingsComment({
      runId: 'run-1',
      completionAttemptId: 'run-1-mc1',
      language: 'en',
      gate: 'review',
      detail: { kind: 'unknown' },
    })
    assert.match(body, /Map completion review failed\./)
    assert.match(body, /Map remains open/)
  })
})

describe('completionGateDetailOf', () => {
  it('narrows evidence detail values into the typed rendering shape', () => {
    assert.deepEqual(
      completionGateDetailOf({ verdict: 'iterate', feedback: 'findings' }),
      { kind: 'review-iterate', feedback: 'findings' },
    )
    assert.deepEqual(
      completionGateDetailOf({ verdict: 'block', code: 'unsafe-change', reason: 'why' }),
      { kind: 'review-block', code: 'unsafe-change', reason: 'why' },
    )
    assert.deepEqual(
      completionGateDetailOf({ argv: ['npm', 'test'], cause: 'non-zero-exit', exitCode: 2, stdout: 'o', stderr: 'e' }),
      { kind: 'command', argv: ['npm', 'test'], cause: 'non-zero-exit', exitCode: 2, stdout: 'o', stderr: 'e' },
    )
    assert.deepEqual(completionGateDetailOf({ verdict: 'aborted' }), { kind: 'unknown' })
    assert.deepEqual(completionGateDetailOf(undefined), { kind: 'unknown' })
  })
})

describe('excerptOf', () => {
  it('keeps short text verbatim and truncates long text deterministically', () => {
    assert.equal(excerptOf('short', 100), 'short')
    const long = 'a'.repeat(300)
    const cut = excerptOf(long, 100)
    assert.equal(cut.length, 101)
    assert.ok(cut.endsWith('…'))
    assert.equal(cut, excerptOf(long, 100))
  })
})

describe('postProgressComment', () => {
  const locator = { githubHost: 'github.com', number: 7, url: 'https://github.com/o/r/issues/7' }

  function seamsOf(world: {
    comments?: Array<{ body: string }>
    readFails?: 'error' | 'blocked'
    writeFails?: boolean
  }) {
    const written: string[] = []
    const calls = { read: 0, write: 0 }
    return {
      written,
      calls,
      seams: {
        loadComments: async (): Promise<IssueEvidenceReadOutcome> => {
          calls.read += 1
          if (world.readFails === 'error') {
            return error({ scope: 'operation', code: 'github-unavailable' as const, reason: 'down' })
          }
          if (world.readFails === 'blocked') {
            return {
              kind: 'blocked' as const,
              scope: 'operation' as const,
              code: 'issue-not-found' as const,
              reason: 'gone',
              sharedWrite: 'none' as const,
              evidence: [],
            }
          }
          return ok({
            comments: (world.comments ?? []).map((comment, index) => ({
              commentId: `c${index}`,
              authorId: 'A_1',
              body: comment.body,
            })),
            timeline: [],
          })
        },
        writeComment: async (_locator: typeof locator, body: string) => {
          calls.write += 1
          if (world.writeFails) {
            return error({ scope: 'operation', code: 'github-unavailable' as const, reason: 'write failed' })
          }
          written.push(body)
          return ok({ commentId: `c${written.length}` })
        },
      },
    }
  }

  const expected = '<!-- norn:handoff run-1#7@wa-w1-t7/r1 -->\nbody'
  const marker = '<!-- norn:handoff run-1#7@wa-w1-t7/r1 -->'

  it('scans before writing and posts exactly once', async () => {
    const fake = seamsOf({})
    const warnings = await postProgressComment(fake.seams, locator, expected, marker, 'handoff of #7')
    assert.deepEqual(warnings, [])
    assert.equal(fake.calls.write, 1)
    assert.deepEqual(fake.written, [expected])
  })

  it('reuses an identical existing comment without writing', async () => {
    const fake = seamsOf({ comments: [{ body: expected }] })
    const warnings = await postProgressComment(fake.seams, locator, expected, marker, 'handoff of #7')
    assert.deepEqual(warnings, [])
    assert.equal(fake.calls.write, 0)
  })

  it('warns and leaves a divergent same-marker comment untouched', async () => {
    const divergent = `${marker}\ndifferent bytes`
    const fake = seamsOf({ comments: [{ body: divergent }] })
    const warnings = await postProgressComment(fake.seams, locator, expected, marker, 'handoff of #7')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /different bytes/)
    assert.equal(fake.calls.write, 0)
  })

  it('ignores other markers and unmarked comments when scanning', async () => {
    const fake = seamsOf({
      comments: [
        { body: '<!-- norn:delivered run-1#7@abc -->\ndelivered' },
        { body: '<!-- norn:verdict run-1#7@wa-w1-t7/r1 -->\nverdict' },
        { body: 'plain human prose' },
      ],
    })
    await postProgressComment(fake.seams, locator, expected, marker, 'handoff of #7')
    assert.equal(fake.calls.write, 1)
  })

  it('degrades read and write failures to warnings — side records never fail the run', async () => {
    for (const world of [
      { readFails: 'error' as const },
      { readFails: 'blocked' as const },
      { writeFails: true },
    ]) {
      const fake = seamsOf(world)
      const warnings = await postProgressComment(fake.seams, locator, expected, marker, 'handoff of #7')
      assert.equal(warnings.length, 1, `expected one warning for ${JSON.stringify(world)}`)
      assert.match(warnings[0]!, /handoff of #7/)
    }
  })
})
