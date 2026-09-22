/**
 * The coordinator-defined child-process environment policy (design.md §3,
 * §6, §8).
 *
 * Configured commands receive a coordinator-built environment, while agent
 * panes may receive only the explicit extras in Run Config. Both paths exclude
 * the credentials Norn itself holds: GitHub tokens supplied by the Pi
 * extension at invocation, and push credentials such as the SSH agent socket
 * or a git askpass helper. The exclusion is a policy guardrail that keeps
 * ordinary mistakes from leaking the coordinator's authority into children —
 * not an operating-system security boundary (§3).
 *
 * The sanitizer is pure: the caller passes the source environment as data.
 */

/**
 * Environment names removed verbatim. `GITHUB_TOKEN` and `GH_TOKEN` are the
 * canonical GitHub CLI/API token names; the askpass variables inject
 * credential prompts; `SSH_AUTH_SOCK` exposes the operator's SSH agent (push
 * credentials); `GIT_SSH_COMMAND` can carry an ssh invocation with embedded
 * credentials; `GIT_CONFIG_COUNT` enables the `GIT_CONFIG_KEY_n`/
 * `GIT_CONFIG_VALUE_n` configuration injection, which could set a credential
 * helper.
 */
const DENIED_EXACT_NAMES: ReadonlySet<string> = new Set([
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_PAT',
  'GH_PAT',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_SSH_COMMAND',
  'SSH_AUTH_SOCK',
  'GIT_CONFIG_COUNT',
  'GIT_SSH_ASKPASS',
])

/**
 * Environment names removed by pattern: every GitHub or GitHub CLI token
 * spelling, such as `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`,
 * `GITHUB_API_TOKEN`, or `GITHUB_COPILOT_TOKEN`.
 */
const DENIED_NAME_PATTERNS: readonly RegExp[] = [/^GH_[A-Z0-9_]*_TOKEN$/, /^GITHUB_[A-Z0-9_]*_TOKEN$/]

/** Prefixes removed regardless of suffix: git's `GIT_CONFIG_KEY_n` and
 * `GIT_CONFIG_VALUE_n` pairs enabled by `GIT_CONFIG_COUNT`. */
const DENIED_NAME_PREFIXES: readonly string[] = ['GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_']

/** Whether `name` is one of the credentials excluded from child environments. */
export function isDeniedEnvironmentName(name: string): boolean {
  if (DENIED_EXACT_NAMES.has(name)) return true
  if (DENIED_NAME_PATTERNS.some((pattern) => pattern.test(name))) return true
  return DENIED_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * Build a child environment from `source`: every entry is kept except
 * the denied credential names. The result is a fresh object — never an alias
 * of the source — so callers cannot re-introduce removed entries by mutation.
 */
export function sanitizeCommandEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (isDeniedEnvironmentName(name)) continue
    environment[name] = value
  }
  return environment
}
