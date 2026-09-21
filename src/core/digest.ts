/**
 * SHA-256 digests in Norn's uniform revision format: `sha256:<lowercase-hex>`
 * (design.md §7.3). All revisions, `outputDigest`, `testEvidenceDigest`,
 * `deliveryId`, and `completionId` use this one presentation.
 *
 * Pure computation only: hashing is deterministic and involves no I/O.
 */
import { createHash } from 'node:crypto'

import type { CanonicalJsonValue } from './canonical-json.ts'
import { canonicalJson } from './canonical-json.ts'

declare const sha256DigestBrand: unique symbol

/** A SHA-256 digest written as `sha256:` followed by 64 lowercase hex digits. */
export type Sha256Digest = string & { readonly [sha256DigestBrand]: 'sha256-digest' }

export const SHA256_PREFIX = 'sha256:'

/** Exact shape every Norn digest must have. */
export const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

/** Type guard for digest-shaped strings arriving from parsed input. */
export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && SHA256_DIGEST_PATTERN.test(value)
}

/**
 * SHA-256 over `data`. A string is hashed as its UTF-8 bytes, matching how
 * canonical JSON text is hashed; a `Uint8Array` is hashed as given.
 */
export function sha256Digest(data: string | Uint8Array): Sha256Digest {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  return (SHA256_PREFIX + createHash('sha256').update(bytes).digest('hex')) as Sha256Digest
}

/**
 * SHA-256 over the UTF-8 bytes of the RFC 8785 canonical JSON encoding of
 * `value` — the one hashing path every revision and evidence digest takes
 * (design.md §7.3, §10.3, §14, §15).
 */
export function canonicalJsonDigest(value: CanonicalJsonValue): Sha256Digest {
  return sha256Digest(canonicalJson(value))
}
