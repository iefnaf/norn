/**
 * Ordered-test-evidence digest (design.md §10.3).
 *
 * A successful gate contains exactly one `TestEvidence` entry for every
 * configured test, in configuration order. The reviewer binds that ordered
 * list through `testEvidenceDigest`: SHA-256 over the UTF-8 bytes of the RFC
 * 8785 canonical JSON encoding of the list, written `sha256:<lowercase-hex>`.
 *
 * Order is significant — unlike revision payloads, the list is never sorted.
 */
import type { CanonicalJsonValue } from './canonical-json.ts'
import { canonicalJsonDigest } from './digest.ts'
import type { Sha256Digest } from './digest.ts'

export type TestEvidencePhase = 'work' | 'ship' | 'map-completion'

/** One successful configured test command bound to an exact base and tree. */
export type TestEvidence = {
  readonly phase: TestEvidencePhase
  readonly testIndex: number
  readonly argv: readonly string[]
  readonly timeoutMs: number
  readonly baseSha: string
  readonly treeOid: string
  readonly exitCode: 0
  readonly outputDigest: Sha256Digest
}

/**
 * Digest of the ordered `TestEvidence` list supplied to a reviewer. The input
 * order is preserved exactly; reordering the same entries changes the digest.
 */
export function testEvidenceDigest(tests: readonly TestEvidence[]): Sha256Digest {
  return canonicalJsonDigest(tests as CanonicalJsonValue)
}
