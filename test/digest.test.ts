import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  SHA256_DIGEST_PATTERN,
  canonicalJsonDigest,
  isSha256Digest,
  sha256Digest,
} from '../src/core/digest.ts'

describe('sha256Digest formatting', () => {
  it('writes sha256: followed by 64 lowercase hex digits', () => {
    const digest = sha256Digest('norn')
    assert.match(digest, SHA256_DIGEST_PATTERN)
    assert.match(digest, /^sha256:[0-9a-f]{64}$/)
  })

  it('matches the known SHA-256 vectors for UTF-8 input', () => {
    assert.equal(
      sha256Digest(''),
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    assert.equal(
      sha256Digest('abc'),
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    // U+20AC encodes as the three UTF-8 bytes e2 82 ac.
    assert.equal(
      sha256Digest('€'),
      'sha256:c4cc90ed3d26f12d4b08a75140970a7904035c31cbb4515a83f19b9003c00d1d',
    )
  })

  it('hashes a Uint8Array as given and agrees with its UTF-8 string form', () => {
    const bytes = new TextEncoder().encode('€')
    assert.equal(sha256Digest(bytes), sha256Digest('€'))
    assert.notEqual(sha256Digest(new Uint8Array([0xe2])), sha256Digest(new Uint8Array([0x2e])))
  })

  it('is deterministic and injective for different inputs', () => {
    assert.equal(sha256Digest('x'), sha256Digest('x'))
    assert.notEqual(sha256Digest('x'), sha256Digest('y'))
  })
})

describe('canonicalJsonDigest', () => {
  it('hashes the UTF-8 bytes of the canonical JSON encoding', () => {
    // The payload is the RFC 8785 §3.2.2 sample; its canonical UTF-8 bytes are
    // documented verbatim in RFC 8785 §3.2.4, so this expected digest is
    // anchored to the RFC document rather than to this implementation.
    const payload = {
      literals: [null, true, false],
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27],
      string: '€$\u000f\nA\'B"\\\\"/',
    }
    assert.equal(
      canonicalJsonDigest(payload),
      'sha256:2d5e01a318d0f0879ab568c4be289c8b1f64ef8921a53c6277d5e069978baacb',
    )
  })

  it('produces identical digests for identical logical payloads', () => {
    const first = { b: 2, a: 1 }
    const second = { a: 1, b: 2 }
    assert.equal(canonicalJsonDigest(first), canonicalJsonDigest(second))
    assert.notEqual(canonicalJsonDigest(first), canonicalJsonDigest({ a: 1, b: 3 }))
  })
})

describe('isSha256Digest', () => {
  const valid = 'sha256:' + 'ab'.repeat(32)

  it('accepts well-formed digests', () => {
    assert.equal(isSha256Digest(valid), true)
    assert.equal(isSha256Digest(sha256Digest('anything')), true)
  })

  it('rejects malformed digest strings', () => {
    for (const invalid of [
      '',
      'sha256:',
      'sha256:' + 'AB'.repeat(32),
      'sha256:' + 'a'.repeat(63),
      'sha256:' + 'a'.repeat(65),
      'sha1:' + 'a'.repeat(40),
      'a'.repeat(64),
      'sha256:' + 'g'.repeat(64),
      42,
      null,
      undefined,
    ]) {
      assert.equal(isSha256Digest(invalid), false, String(invalid))
    }
  })
})
