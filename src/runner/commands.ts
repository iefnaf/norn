/**
 * The `/norn` command surface as typed runner data.
 *
 * The extension is a thin operator adapter (design.md §2.1, §6): it renders
 * what the runner declares here and decides nothing on its own. Subcommand
 * behaviour arrives in later tickets; this module currently covers only the
 * command summary path required by design.md §2.3.
 */

export type NornSubcommandName = 'init' | 'check' | 'run' | 'status' | 'abort'

export type NornSubcommandInfo = {
  readonly name: NornSubcommandName
  /** Exact invocation shape shown to the operator. */
  readonly usage: string
  /** Whether the subcommand addresses a Task Map by full issue URL. */
  readonly takesMapUrl: boolean
  readonly description: string
}

export const NORN_SUBCOMMANDS: readonly NornSubcommandInfo[] = [
  {
    name: 'init',
    usage: '/norn init',
    takesMapUrl: false,
    description:
      'Deterministic setup for the current repository: resolve the stable GitHub repository identity, record explicit operator choices, and write metadata and Run Config under repository home.',
  },
  {
    name: 'check',
    usage: '/norn check <map-url>',
    takesMapUrl: true,
    description:
      'Run the same preflight used by run — repository, configuration, Task Map contract, models, and delivery evidence — reporting every finding without creating a run or any shared write.',
  },
  {
    name: 'run',
    usage: '/norn run <map-url>',
    takesMapUrl: true,
    description:
      'Create or resume one run for the complete Task Map and work it in Waves until a terminal RunReport.',
  },
  {
    name: 'status',
    usage: '/norn status <map-url>',
    takesMapUrl: true,
    description:
      'Read local Run State and ownership for the map without resuming or mutating the run.',
  },
  {
    name: 'abort',
    usage: '/norn abort <map-url>',
    takesMapUrl: true,
    description:
      'Explicitly end a run after confirming its exact run ID; record the decision without rolling back pushed commits or remote evidence.',
  },
]

export type NornCommandSummary = {
  readonly command: 'norn'
  readonly tagline: string
  readonly subcommands: readonly NornSubcommandInfo[]
}

/** Typed data for rendering the bare `/norn` command summary (design.md §2.3). */
export function commandSummary(): NornCommandSummary {
  return {
    command: 'norn',
    tagline: 'Weave the graph. Prove the outcome.',
    subcommands: NORN_SUBCOMMANDS,
  }
}

/**
 * Lexical parse of the text after `/norn`. Argument semantics — such as the
 * full-issue-URL requirement for `<map-url>` — belong to the subcommand
 * implementations, not to this parser.
 */
export type ParsedNornInvocation =
  | { readonly kind: 'summary' }
  | { readonly kind: 'subcommand'; readonly subcommand: NornSubcommandInfo; readonly args: string }
  | { readonly kind: 'unknown'; readonly input: string }

export function parseNornInvocation(raw: string): ParsedNornInvocation {
  const input = raw.trim()
  if (input === '') return { kind: 'summary' }

  const separator = input.search(/\s/)
  const head = separator === -1 ? input : input.slice(0, separator)
  const rest = separator === -1 ? '' : input.slice(separator).trim()

  const subcommand = NORN_SUBCOMMANDS.find((entry) => entry.name === head)
  if (subcommand) return { kind: 'subcommand', subcommand, args: rest }

  return { kind: 'unknown', input }
}
