/**
 * Exactly framed captured command output (design.md §10.2, §10.3).
 *
 * The Command runner captures stdout and stderr byte-accurately, and
 * `TestEvidence.outputDigest` is SHA-256 over the runner's "exact framed
 * stdout/stderr bytes". Framing makes the two streams unambiguously bound:
 * each stream is prefixed with its byte length as an unsigned 64-bit
 * big-endian integer, so no split of bytes across the stream boundary — and
 * no reordering or truncation — can produce the same framed bytes.
 *
 * Pure computation only: hashing is deterministic and involves no I/O.
 */
import { sha256Digest } from '../core/digest.ts'
import type { Sha256Digest } from '../core/digest.ts'

/** The framing prefix is exactly eight bytes per stream. */
export const OUTPUT_FRAME_LENGTH_BYTES = 8

/**
 * The exact framed bytes: `BE64(len(stdout)) ‖ stdout ‖ BE64(len(stderr)) ‖ stderr`.
 * The encoding is injective over all pairs of byte strings.
 */
export function framedCommandOutput(stdout: Uint8Array, stderr: Uint8Array): Uint8Array {
  const framed = new Uint8Array(
    2 * OUTPUT_FRAME_LENGTH_BYTES + stdout.byteLength + stderr.byteLength,
  )
  writeLengthPrefix(framed, 0, stdout.byteLength)
  framed.set(stdout, OUTPUT_FRAME_LENGTH_BYTES)
  const stderrStart = OUTPUT_FRAME_LENGTH_BYTES + stdout.byteLength
  writeLengthPrefix(framed, stderrStart, stderr.byteLength)
  framed.set(stderr, stderrStart + OUTPUT_FRAME_LENGTH_BYTES)
  return framed
}

/**
 * `outputDigest` (design.md §10.3): SHA-256 over the exact framed
 * stdout/stderr bytes of one command execution, written
 * `sha256:<lowercase-hex>` like every other Norn digest.
 */
export function commandOutputDigest(stdout: Uint8Array, stderr: Uint8Array): Sha256Digest {
  return sha256Digest(framedCommandOutput(stdout, stderr))
}

function writeLengthPrefix(target: Uint8Array, offset: number, length: number): void {
  let remaining = length
  for (let index = OUTPUT_FRAME_LENGTH_BYTES - 1; index >= 0; index--) {
    target[offset + index] = remaining % 0x100
    remaining = Math.floor(remaining / 0x100)
  }
  if (remaining !== 0) {
    throw new RangeError('captured output exceeds the 64-bit framing prefix')
  }
}
