import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { canonicalJson } from '../src/core/canonical-json.ts'
import { canonicalJsonDigest, sha256Digest } from '../src/core/digest.ts'
import type { TestEvidence } from '../src/core/test-evidence.ts'
import { testEvidenceDigest } from '../src/core/test-evidence.ts'

const FIRST: TestEvidence = {
  phase: 'work',
  testIndex: 0,
  argv: ['npm', 'test'],
  timeoutMs: 120000,
  baseSha: 'sha1:0123456789abcdef0123456789abcdef01234567',
  treeOid: 'sha1:fedcba9876543210fedcba9876543210fedcba98',
  exitCode: 0,
  outputDigest: sha256Digest('stdout+stderr for test 0'),
}

const SECOND: TestEvidence = {
  phase: 'work',
  testIndex: 1,
  argv: ['npm', 'run', 'check'],
  timeoutMs: 60000,
  baseSha: FIRST.baseSha,
  treeOid: FIRST.treeOid,
  exitCode: 0,
  outputDigest: sha256Digest('stdout+stderr for test 1'),
}

describe('testEvidenceDigest', () => {
  it('hashes the RFC 8785 canonical JSON of the ordered list', () => {
    const tests = [FIRST, SECOND]
    assert.equal(testEvidenceDigest(tests), canonicalJsonDigest(tests))
  })

  it('encodes every field, including the zero exit code, in the canonical form', () => {
    const single: readonly TestEvidence[] = [FIRST]
    assert.equal(
      canonicalJson(single as never),
      `[{"argv":["npm","test"],"baseSha":"${FIRST.baseSha}","exitCode":0,` +
        `"outputDigest":"${FIRST.outputDigest}","phase":"work","testIndex":0,` +
        `"timeoutMs":120000,"treeOid":"${FIRST.treeOid}"}]`,
    )
  })

  it('is deterministic for identical ordered lists', () => {
    assert.equal(testEvidenceDigest([FIRST, SECOND]), testEvidenceDigest([FIRST, SECOND]))
  })

  it('treats list order as significant', () => {
    assert.notEqual(
      testEvidenceDigest([FIRST, SECOND]),
      testEvidenceDigest([SECOND, FIRST]),
    )
  })

  it('changes when any evidence field changes', () => {
    const base = testEvidenceDigest([FIRST, SECOND])
    const variants: TestEvidence[] = [
      { ...FIRST, phase: 'ship' },
      { ...FIRST, testIndex: 3 },
      { ...FIRST, argv: ['npm', 'test', '--', 'unit'] },
      { ...FIRST, timeoutMs: 121000 },
      { ...FIRST, baseSha: 'sha1:' + 'f'.repeat(40) },
      { ...FIRST, treeOid: 'sha1:' + '0'.repeat(40) },
      { ...FIRST, outputDigest: sha256Digest('different output') },
    ]
    for (const variant of variants) {
      assert.notEqual(testEvidenceDigest([variant, SECOND]), base, JSON.stringify(variant))
    }
  })

  it('changes when a list entry is added or removed', () => {
    const base = testEvidenceDigest([FIRST, SECOND])
    assert.notEqual(testEvidenceDigest([FIRST]), base)
    const third: TestEvidence = {
      phase: 'work',
      testIndex: 2,
      argv: ['node', '--test'],
      timeoutMs: 30000,
      baseSha: FIRST.baseSha,
      treeOid: FIRST.treeOid,
      exitCode: 0,
      outputDigest: sha256Digest('stdout+stderr for test 2'),
    }
    assert.notEqual(testEvidenceDigest([FIRST, SECOND, third]), base)
  })

  it('binds the phase of the enclosing gate', () => {
    const work: TestEvidence = { ...FIRST, phase: 'work' }
    const ship: TestEvidence = { ...FIRST, phase: 'ship' }
    const completion: TestEvidence = { ...FIRST, phase: 'map-completion' }
    const digests = new Set([work, ship, completion].map((t) => testEvidenceDigest([t])))
    assert.equal(digests.size, 3)
  })

  it('hashes the empty list as the canonical empty array', () => {
    assert.equal(testEvidenceDigest([]), canonicalJsonDigest([]))
    assert.equal(testEvidenceDigest([]), sha256Digest('[]'))
  })
})
