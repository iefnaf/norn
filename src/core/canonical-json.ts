/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) encoding (design.md §7.3, §8,
 * §10.3, §14–15). Every Norn revision and evidence digest is taken over the
 * UTF-8 bytes of this encoding, so identical logical payloads always produce
 * identical bytes.
 *
 * This is a pure function over in-memory JSON data: no I/O, no clock.
 */

/**
 * JSON data expressible in the RFC 8785 data model: `null`, booleans, finite
 * IEEE 754 numbers, Unicode strings without lone surrogates, arrays, and
 * objects with JSON-valued properties. Keys are plain strings.
 */
export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue }

/**
 * Compare two strings as arrays of unsigned UTF-16 code units (RFC 8785
 * §3.2.3). This is the exact ordering JCS mandates for object property names;
 * it differs from code-point order for supplementary characters, which sort by
 * their leading surrogate.
 */
export function compareUtf16CodeUnits(a: string, b: string): number {
  const shortest = Math.min(a.length, b.length)
  for (let i = 0; i < shortest; i++) {
    const difference = a.charCodeAt(i) - b.charCodeAt(i)
    if (difference !== 0) return difference
  }
  return a.length - b.length
}

/** A high surrogate not followed by a low surrogate, or the reverse. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * Serialize `value` as canonical JSON text per RFC 8785:
 *
 * - no whitespace between tokens (§3.2.1);
 * - primitives exactly as ECMAScript `JSON.stringify` emits them, with NaN,
 *   Infinity, and lone surrogates rejected (§3.2.2);
 * - object properties sorted recursively by UTF-16 code units, while array
 *   element order is preserved (§3.2.3).
 *
 * Throws `TypeError` for values outside the JSON data model (`undefined`,
 * `bigint`, symbols, functions, class instances such as `Date` and `Map`) and
 * `RangeError` for `NaN`, `Infinity`, and strings containing lone surrogates.
 * `-0` is serialized as `0`.
 */
export function canonicalJson(value: CanonicalJsonValue): string {
  return serialize(value)
}

function serialize(value: CanonicalJsonValue): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      return serializeNumber(value)
    case 'string':
      return serializeString(value)
    case 'object':
      if (Array.isArray(value)) {
        return `[${value.map((element) => serialize(element)).join(',')}]`
      }
      {
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError(
            `canonical JSON accepts only plain JSON data, got ${describeValue(value)}`,
          )
        }
        return serializeObject(value as { readonly [key: string]: CanonicalJsonValue })
      }
    default:
      throw new TypeError(`canonical JSON accepts only JSON data, got ${typeof value}`)
  }
}

function describeValue(value: object): string {
  return value.constructor?.name ?? typeof value
}

/** ECMAScript `Number::toString` (RFC 8785 §3.2.2.3), minus what JSON forbids. */
function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError('RFC 8785 forbids NaN and Infinity in canonical JSON')
  }
  if (Object.is(value, -0)) return '0'
  return JSON.stringify(value)
}

/** ECMAScript string serialization (RFC 8785 §3.2.2.2). */
function serializeString(value: string): string {
  if (LONE_SURROGATE.test(value)) {
    throw new RangeError('RFC 8785 forbids lone surrogates in canonical JSON strings')
  }
  return JSON.stringify(value)
}

function serializeObject(value: { readonly [key: string]: CanonicalJsonValue }): string {
  const keys = Object.keys(value).sort(compareUtf16CodeUnits)
  const parts: string[] = []
  for (const key of keys) {
    parts.push(`${serializeString(key)}:${serialize(value[key] as CanonicalJsonValue)}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * Structural check for data expressible in the RFC 8785 data model. Rejects
 * `undefined`, non-finite numbers, lone surrogates, and exotic objects (class
 * instances, `Date`, `Map`, …) that plain serialization would silently mangle.
 */
export function isCanonicalJsonValue(value: unknown): value is CanonicalJsonValue {
  if (value === null) return true
  switch (typeof value) {
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'string':
      return !LONE_SURROGATE.test(value)
    case 'object': {
      if (Array.isArray(value)) return value.every(isCanonicalJsonValue)
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) return false
      return Object.values(value).every(isCanonicalJsonValue)
    }
    default:
      return false
  }
}
