/**
 * Map issue URL parsing (design.md §2.2): commands that address a Task Map
 * accept the full GitHub issue URL
 * `https://<github-host>/<owner>/<repository>/issues/<number>` — never the
 * `#123` shorthand. The parsed locator drives repository resolution and Task
 * Map loading; issue-number shorthand, `pull/` paths, and non-HTTPS forms are
 * rejected before any read.
 */

/** One parsed `<map-url>`: a repository locator plus the issue number. */
export type MapIssueLocator = {
  /** Lowercase ASCII host with the default HTTPS port omitted (§7.3). */
  readonly githubHost: string
  readonly owner: string
  readonly name: string
  /** Positive issue number; a display locator, not identity (§7.2). */
  readonly number: number
}

/**
 * Normalize an issue-reference host exactly as §7.3 defines reference
 * identity: the lowercase ASCII host with the default HTTPS port omitted.
 */
export function normalizeIssueHost(host: string): string {
  const lowercase = host.toLowerCase()
  return lowercase.endsWith(':443') ? lowercase.slice(0, -':443'.length) : lowercase
}

const ISSUE_PATH = /^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/?$/

/**
 * Parse one full GitHub issue URL. Accepts exactly the §2.2 form — an
 * `https` URL with no query and no fragment whose path is
 * `/owner/repository/issues/<number>` with an optional trailing slash — and
 * returns `undefined` for anything else, including `#123` shorthand,
 * `/pull/<number>` paths, `http://` forms, and URLs with credentials.
 */
export function parseIssueUrl(input: string): MapIssueLocator | undefined {
  const trimmed = input.trim()
  if (trimmed === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:') return undefined
  if (parsed.username !== '' || parsed.password !== '') return undefined
  if (parsed.search !== '' || parsed.hash !== '') return undefined
  const match = ISSUE_PATH.exec(parsed.pathname)
  if (match === null) return undefined
  const port = parsed.port === '' ? '' : `:${parsed.port}`
  return {
    githubHost: normalizeIssueHost(`${parsed.hostname}${port}`),
    owner: match[1]!,
    name: match[2]!,
    number: Number(match[3]),
  }
}
