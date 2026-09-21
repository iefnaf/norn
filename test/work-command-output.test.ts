/**
 * Exactly framed captured output (design.md §10.2, §10.3, ticket #7): the
 * framing is injective and the digest is SHA-256 over the framed bytes.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import { sha256Digest } from '../src/core/digest.ts'
import {
  commandOutputDigest,
  framedCommandOutput,
  OUTPUT_FRAME_LENGTH_BYTES,
} from '../src/work/command-output.ts'

function be64(length: number): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(length))
  return buffer
}

describe('framedCommandOutput', () => {
  it('length-prefixes each stream with an unsigned 64-bit big-endian frame', () => {
    const stdout = Buffer.from('out')
    const stderr = Buffer.from('error')
    const framed = framedCommandOutput(stdout, stderr)
    assert.deepEqual(Buffer.from(framed), Buffer.concat([be64(3), stdout, be64(5), stderr]))
    assert.equal(OUTPUT_FRAME_LENGTH_BYTES, 8)
  })

  it('frames empty streams as sixteen zero bytes', () => {
    const framed = framedCommandOutput(new Uint8Array(0), new Uint8Array(0))
    assert.deepEqual(Buffer.from(framed), Buffer.alloc(16, 0))
  })

  it('keeps bytes exact, including NUL and non-UTF-8 bytes', () => {
    const stdout = Buffer.from([0x00, 0xff, 0xfe, 0x0a, 0x0d, 0x0a])
    const stderr = Buffer.from([0x80, 0x81])
    const framed = framedCommandOutput(stdout, stderr)
    assert.deepEqual(Buffer.from(framed.subarray(8, 14)), stdout)
    assert.deepEqual(Buffer.from(framed.subarray(14 + 8)), stderr)
  })

  it('is injective: no stream split produces the same framed bytes', () => {
    const a = framedCommandOutput(Buffer.from('ab'), Buffer.from('c'))
    const b = framedCommandOutput(Buffer.from('a'), Buffer.from('bc'))
    const c = framedCommandOutput(Buffer.from('abc'), Buffer.from(''))
    const d = framedCommandOutput(Buffer.from(''), Buffer.from('abc'))
    const distinct = new Set([a, b, c, d].map((frame) => Buffer.from(frame).toString('latin1')))
    assert.equal(distinct.size, 4)
  })
})

describe('commandOutputDigest', () => {
  it('is SHA-256 over the exact framed bytes', () => {
    const stdout = Buffer.from('stdout bytes \n')
    const stderr = Buffer.from('stderr bytes')
    const framed = framedCommandOutput(stdout, stderr)
    const expected = 'sha256:' + createHash('sha256').update(framed).digest('hex')
    assert.equal(commandOutputDigest(stdout, stderr), expected)
    assert.equal(commandOutputDigest(stdout, stderr), sha256Digest(framed))
  })

  it('changes when either stream changes by a single byte', () => {
    const stdout = Buffer.from('same')
    const digestA = commandOutputDigest(stdout, Buffer.from('a'))
    const digestB = commandOutputDigest(stdout, Buffer.from('b'))
    assert.notEqual(digestA, digestB)
  })

  it('distinguishes swapped streams', () => {
    const one = commandOutputDigest(Buffer.from('x'), Buffer.from('y'))
    const two = commandOutputDigest(Buffer.from('y'), Buffer.from('x'))
    assert.notEqual(one, two)
  })
})
