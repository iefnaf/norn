/**
 * Presentation of typed runner data. This file renders; it never decides.
 */
import type { NornCommandSummary, NornSubcommandInfo } from '../runner/commands.ts'

export function renderSummary(summary: NornCommandSummary): string {
  const lines: string[] = [`Norn — ${summary.tagline}`, '']
  for (const subcommand of summary.subcommands) {
    lines.push(subcommand.usage)
    lines.push(`  ${subcommand.description}`)
  }
  return lines.join('\n')
}

export function renderUnknown(input: string, summary: NornCommandSummary): string {
  return [
    `Unknown /norn input: ${input === '' ? '(empty)' : input}`,
    '',
    renderSummary(summary),
  ].join('\n')
}

export function renderPending(subcommand: NornSubcommandInfo): string {
  return [
    `${subcommand.usage} is not implemented yet.`,
    subcommand.description,
  ].join('\n')
}
