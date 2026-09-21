/**
 * Revision text normalization (design.md §7.3): the one canonical form every
 * revision-relevant GitHub text field takes before it is hashed or shown to an
 * agent, so a revision identity never depends on line endings, Unicode
 * normalization form, or insignificant outer whitespace.
 */

/**
 * Normalize one complete revision text field exactly as design.md §7.3
 * specifies:
 *
 * 1. CRLF and lone CR become LF;
 * 2. the text is normalized to Unicode NFC;
 * 3. only leading and trailing spaces, tabs, and LF characters are removed.
 *
 * A `null` GitHub issue body becomes the empty string. Interior bytes —
 * including all Markdown-significant whitespace — remain significant.
 */
export function normalizeRevisionText(raw: string | null): string {
  const lfOnly = raw === null ? '' : raw.replace(/\r\n|\r/g, '\n')
  const nfc = lfOnly.normalize('NFC')
  return nfc.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '')
}
