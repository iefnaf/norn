/**
 * The human-readable delivery comment renderers (design.md §10.2, §11.3,
 * §14 — ticket #35).
 *
 * Everything asserted here is the protocol-critical shape: the delivered
 * comment is unmarked prose the §14 envelope grammar must ignore; the merged
 * record comment's machine envelope must parse byte-identically to the bare
 * envelope; rendering is deterministic for replay idempotency; and the
 * configured comment language selects every generated string.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { canonicalJson } from '../src/core/canonical-json.ts'
import type { CanonicalJsonValue } from '../src/core/canonical-json.ts'
import { parseRecordEnvelope } from '../src/evidence/envelope.ts'
import {
  deliveredMarker,
  renderDeliveredComment,
  renderMergedRecordComment,
} from '../src/ship/render-comments.ts'
import type {
  DeliveryRecordV1,
  EvidenceGateV1,
  ShippableChange,
} from '../src/runstate/types.ts'
import { computeDeliveryId } from '../src/evidence/delivery.ts'

const GATE: EvidenceGateV1 = {
  worker: {
    provider: 'zai-coding-cn',
    model: 'zai-coding-cn/glm-5.3',
    family: 'zai-coding-cn',
    thinking: 'low',
  },
  reviewer: {
    provider: 'openai-codex',
    model: 'openai-codex/gpt-5.6-luna',
    family: 'openai-codex',
    thinking: 'minimal',
  },
  tests: [{ argv: ['npm', 'test'], timeoutMs: 120_000 }],
}

function change(overrides: Partial<ShippableChange> = {}): ShippableChange {
  return {
    ticket: {
      role: 'ticket',
      githubHost: 'github.com',
      repositoryId: 'R_kgDOMAP',
      issueId: 'I_7',
      number: 7,
      url: 'https://github.com/o/r/issues/7',
    },
    mapRevision: 'sha256:' + 'a'.repeat(64),
    ticketRevision: 'sha256:' + 'b'.repeat(64),
    baseSha: 'sha1:' + '1'.repeat(40),
    candidateCommit: 'sha1:' + '4'.repeat(40),
    candidateTreeOid: 'sha1:' + '3'.repeat(40),
    workspace: {
      kind: 'ticket',
      repositoryId: 'R_kgDOMAP',
      runId: 'run-x1',
      path: '/wsp',
      branch: 'norn/run-x1/7/wa-1',
      workAttemptId: 'wa-1',
    },
    tests: [
      {
        phase: 'work',
        testIndex: 0,
        argv: ['npm', 'test'],
        timeoutMs: 120_000,
        baseSha: 'sha1:' + '1'.repeat(40),
        treeOid: 'sha1:' + '3'.repeat(40),
        exitCode: 0,
        outputDigest: 'sha256:' + '5'.repeat(64),
      },
    ],
    review: {
      phase: 'work',
      provider: 'openai-codex',
      model: 'openai-codex/gpt-5.6-luna',
      family: 'openai-codex',
      thinking: 'minimal',
      verdict: 'pass',
      mapRevision: 'sha256:' + 'a'.repeat(64),
      ticketRevision: 'sha256:' + 'b'.repeat(64),
      baseSha: 'sha1:' + '1'.repeat(40),
      treeOid: 'sha1:' + '3'.repeat(40),
      testEvidenceDigest: 'sha256:' + '6'.repeat(64),
    },
    summary: '## Summary\n\nthe shape of the change\n\n## Evidence\n\nbefore/after\n\n## Merge Danger\n\n**Door:** two-way',
    ...overrides,
  }
}

function record(zeroDelta: boolean): DeliveryRecordV1 {
  const base = 'sha1:' + '1'.repeat(40)
  const integrated = zeroDelta ? base : 'sha1:' + '4'.repeat(40)
  const tree = zeroDelta ? 'sha1:' + '2'.repeat(40) : 'sha1:' + '3'.repeat(40)
  const draft = {
    schema: 'norn-delivery:v1' as const,
    gate: GATE,
    run: { id: 'run-x1', configRevision: 'sha256:' + '7'.repeat(64), nornVersion: '0.2.0' },
    map: { issueId: 'I_map', revision: 'sha256:' + 'a'.repeat(64) },
    ticket: { issueId: 'I_7', revision: 'sha256:' + 'b'.repeat(64) },
    target: {
      repositoryId: 'R_kgDOMAP',
      branch: 'main',
      baseSha: base,
      integratedSha: integrated,
      treeOid: tree,
    },
    review: change().review,
    tests: change().tests,
    actorId: 'I_actor',
    recordedAt: '2026-09-22T17:36:08.032Z',
  }
  return { ...draft, deliveryId: computeDeliveryId(draft) }
}

describe('renderDeliveredComment', () => {
  it('renders the marker, the worker summary verbatim, gate facts, and the not-merged note', () => {
    const body = renderDeliveredComment({
      runId: 'run-x1',
      change: change(),
      gate: GATE,
      targetBranch: 'main',
      language: 'en',
    })
    assert.equal(
      body.split('\n')[0],
      '<!-- norn:delivered run-x1#7@' + '4'.repeat(40) + ' -->',
    )
    assert.match(body, /Delivered on branch `norn\/run-x1\/7\/wa-1` \(commit `4444444`\)/)
    assert.match(body, /## Summary\n\nthe shape of the change/)
    assert.match(body, /\*\*Gate\*\*: `npm test` ✅ exit 0/)
    assert.match(body, /worker `zai-coding-cn\/glm-5.3` \(low\)/)
    assert.match(body, /reviewer `openai-codex\/gpt-5.6-luna` \(minimal\) → \*\*pass\*\*/)
    assert.match(body, /Not merged to `main` yet\./)
  })

  it('renders the Chinese strings under commentLanguage zh', () => {
    const body = renderDeliveredComment({
      runId: 'run-x1',
      change: change(),
      gate: GATE,
      targetBranch: 'main',
      language: 'zh',
    })
    assert.match(body, /已在分支 `norn\/run-x1\/7\/wa-1` 完成实现（候选提交 `4444444`）。/)
    assert.match(body, /尚未合并进 `main`。/)
  })

  it('falls back to a facts-only shape for legacy seals without a summary', () => {
    const body = renderDeliveredComment({
      runId: 'run-x1',
      change: change({ summary: undefined }),
      gate: GATE,
      targetBranch: 'main',
      language: 'en',
    })
    assert.doesNotMatch(body, /## Summary/)
    assert.match(body, /\*\*Gate\*\*: `npm test`/)
    assert.match(body, /Not merged to `main` yet\./)
  })

  it('is an unmarked comment the §14 envelope grammar ignores', () => {
    const body = renderDeliveredComment({
      runId: 'run-x1',
      change: change(),
      gate: GATE,
      targetBranch: 'main',
      language: 'en',
    })
    assert.equal(parseRecordEnvelope(body).kind, 'unmarked')
  })

  it('is deterministic, and the marker binds run, ticket, and candidate', () => {
    const input = {
      runId: 'run-x1',
      change: change(),
      gate: GATE,
      targetBranch: 'main',
      language: 'en' as const,
    }
    assert.equal(renderDeliveredComment(input), renderDeliveredComment(input))
    assert.notEqual(
      deliveredMarker('run-x1', 7, 'sha1:' + '4'.repeat(40)),
      deliveredMarker('run-x2', 7, 'sha1:' + '4'.repeat(40)),
    )
    assert.notEqual(
      deliveredMarker('run-x1', 7, 'sha1:' + '4'.repeat(40)),
      deliveredMarker('run-x1', 8, 'sha1:' + '4'.repeat(40)),
    )
    assert.notEqual(
      deliveredMarker('run-x1', 7, 'sha1:' + '4'.repeat(40)),
      deliveredMarker('run-x1', 7, 'sha1:' + '9'.repeat(40)),
    )
  })
})

describe('renderMergedRecordComment', () => {
  it('parses through the §14 envelope byte-identically to the bare machine envelope', () => {
    const sealed = record(false)
    const canonicalText = canonicalJson(sealed as unknown as CanonicalJsonValue)
    const body = renderMergedRecordComment({
      record: sealed,
      canonicalText,
      zeroDelta: false,
      language: 'en',
    })
    const envelope = parseRecordEnvelope(body)
    assert.equal(envelope.kind, 'record')
    if (envelope.kind !== 'record') return
    assert.equal(envelope.canonicalText, canonicalText)
    assert.equal(
      (envelope.value as { deliveryId?: unknown }).deliveryId,
      sealed.deliveryId,
    )
  })

  it('folds exactly one json machine block inside the details element', () => {
    const sealed = record(false)
    const body = renderMergedRecordComment({
      record: sealed,
      canonicalText: canonicalJson(sealed as unknown as CanonicalJsonValue),
      zeroDelta: false,
      language: 'en',
    })
    assert.equal(body.match(/```json/g)?.length, 1)
    assert.match(body, /^<details>$/m)
    assert.match(body, /^<\/details>$/m)
    assert.match(body, /Merged to `main` \(`4444444`, base `1111111`\)/)
    assert.match(body, /deliveryId [0-9a-f]{7}/)
  })

  it('renders the zero-delta headline and the Chinese strings', () => {
    const zero = record(true)
    const en = renderMergedRecordComment({
      record: zero,
      canonicalText: canonicalJson(zero as unknown as CanonicalJsonValue),
      zeroDelta: true,
      language: 'en',
    })
    assert.match(en, /No merge needed \(zero-delta\)/)

    const sealed = record(false)
    const zh = renderMergedRecordComment({
      record: sealed,
      canonicalText: canonicalJson(sealed as unknown as CanonicalJsonValue),
      zeroDelta: false,
      language: 'zh',
    })
    assert.match(zh, /已在 `main` 合并（`4444444`，base `1111111`）。/)
    assert.match(zh, /norn 交付记录 · norn-delivery:v1/)
  })

  it('is deterministic for identical sealed facts', () => {
    const sealed = record(false)
    const input = {
      record: sealed,
      canonicalText: canonicalJson(sealed as unknown as CanonicalJsonValue),
      zeroDelta: false,
      language: 'en' as const,
    }
    assert.equal(renderMergedRecordComment(input), renderMergedRecordComment(input))
  })
})
