/**
 * The remote evidence envelope grammar (design.md §14–15).
 *
 * Norn machine comments use one parsing envelope: RFC 8785 canonical JSON in
 * the only fenced `json` block immediately following the exact marker
 * `<!-- norn:record -->`. Human-readable prose may appear outside that
 * envelope and is ignored. A marked comment whose machine block is missing,
 * malformed, non-canonical, or accompanied by an additional machine block is
 * rejected — never guessed into a record.
 *
 * Parsers must follow every comment and timeline pagination cursor before
 * deciding uniqueness or chronology; that orchestration lives in
 * `src/evidence/delivery.ts` and the gateway adapter, while this module is
 * the pure single-comment grammar.
 */
import { canonicalJson } from '../core/canonical-json.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'

/** The exact machine-comment marker (design.md §14). */
export const NORN_RECORD_MARKER = '<!-- norn:record -->'

/** The fence info string of the one machine block. */
export const RECORD_FENCE_INFO = 'json'

/** One parsed comment body under the §14 envelope grammar. */
export type RecordEnvelope =
  | { readonly kind: 'unmarked' }
  | {
      readonly kind: 'record'
      /** The exact bytes of the fenced block — already canonical (verified). */
      readonly canonicalText: string
      /** The parsed record value; `canonicalJson(value) === canonicalText`. */
      readonly value: CanonicalJsonValue
    }
  | { readonly kind: 'invalid'; readonly reason: string }

/** Normalize comment bodies to LF lines the way GitHub bodies are read. */
function toLines(body: string): readonly string[] {
  return body.replace(/\r\n?/g, '\n').split('\n')
}

/** Whether a line is the exact marker (surrounding line whitespace ignored). */
function isMarkerLine(line: string): boolean {
  return line.trim() === NORN_RECORD_MARKER
}

/** A fence opening line: ` ```json ` etc. Returns its info string. */
function fenceInfo(line: string): string | undefined {
  const match = /^(`{3,})(.*)$/.exec(line)
  if (match === null) return undefined
  return match[2]!.trim()
}

/** Whether a line closes a fence opened with `fenceLength` backticks. */
function isFenceClose(line: string, fenceLength: number): boolean {
  const match = /^(`{3,})\s*$/.exec(line)
  return match !== null && match[1]!.length >= fenceLength
}

/**
 * Parse one comment body under the envelope grammar:
 *
 * - no marker line at all → `unmarked` (prose, ignored);
 * - exactly one marker line, immediately followed by the comment's only
 *   `json`-fenced block, whose content is valid canonical JSON of an object →
 *   `record`;
 * - anything else on a marked comment → `invalid` with the specific reason.
 */
export function parseRecordEnvelope(body: string): RecordEnvelope {
  const lines = toLines(body)
  const markerIndices = lines.map((line, index) => (isMarkerLine(line) ? index : -1)).filter((i) => i >= 0)

  if (markerIndices.length === 0) return { kind: 'unmarked' }
  if (markerIndices.length > 1) {
    return { kind: 'invalid', reason: `the marker appears ${markerIndices.length} times` }
  }
  const markerIndex = markerIndices[0]!

  // The machine block must open on the line immediately after the marker.
  const openIndex = markerIndex + 1
  if (openIndex >= lines.length) {
    return { kind: 'invalid', reason: 'no machine block follows the marker' }
  }
  const openLine = lines[openIndex]!
  const openMatch = /^(`{3,})(.*)$/.exec(openLine)
  if (openMatch === null || openMatch[2]!.trim() !== RECORD_FENCE_INFO) {
    return {
      kind: 'invalid',
      reason: 'the marker is not immediately followed by a fenced json block',
    }
  }
  const fenceLength = openMatch[1]!.length

  // The block must close before the comment ends.
  let closeIndex = -1
  for (let index = openIndex + 1; index < lines.length; index++) {
    if (isFenceClose(lines[index]!, fenceLength)) {
      closeIndex = index
      break
    }
  }
  if (closeIndex === -1) {
    return { kind: 'invalid', reason: 'the machine block is never closed' }
  }
  const content = lines.slice(openIndex + 1, closeIndex).join('\n')

  // No additional machine block may appear anywhere else in the comment.
  for (let index = 0; index < lines.length; index++) {
    if (index === openIndex) continue
    if (fenceInfo(lines[index]!) === RECORD_FENCE_INFO) {
      return { kind: 'invalid', reason: 'an additional json machine block is present' }
    }
  }

  // The block content must be valid JSON of an object, in canonical form.
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (cause) {
    return {
      kind: 'invalid',
      reason: `the machine block is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'invalid', reason: 'the machine block is not a JSON object' }
  }
  let canonical: string
  try {
    canonical = canonicalJson(parsed as CanonicalJsonValue)
  } catch (cause) {
    return {
      kind: 'invalid',
      reason: `the machine block is outside the RFC 8785 data model: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
  if (canonical !== content) {
    return { kind: 'invalid', reason: 'the machine block is not RFC 8785 canonical JSON' }
  }
  return { kind: 'record', canonicalText: canonical, value: parsed as CanonicalJsonValue }
}

/**
 * Render one machine comment: the marker, the single canonical `json` block,
 * and nothing else. This is the byte shape `parseRecordEnvelope` accepts and
 * the writer side of the §14 envelope will emit.
 */
export function formatRecordEnvelope(canonicalText: string): string {
  return `${NORN_RECORD_MARKER}\n\`\`\`${RECORD_FENCE_INFO}\n${canonicalText}\n\`\`\`\n`
}
