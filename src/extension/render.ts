/**
 * Presentation of typed runner data. This file renders; it never decides.
 */
import type { NornCommandSummary, NornSubcommandInfo } from '../runner/commands.ts'
import type { InitOutcome } from '../runner/init.ts'
import { isSha256Digest } from '../core/digest.ts'

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

/** `/norn init` accepts no arguments; everything is chosen interactively. */
export function renderInitTakesNoArguments(): string {
  return [
    '/norn init takes no arguments.',
    'It resolves the current repository and asks for every choice explicitly.',
  ].join('\n')
}

/** Render the typed `/norn init` outcome for the operator. */
export function renderInitOutcome(outcome: InitOutcome): string {
  if (outcome.kind === 'ok') {
    const { value } = outcome
    const lines = [
      value.replacedExistingConfig
        ? 'Norn Run Config replaced.'
        : 'Norn repository initialized.',
      `Repository: ${value.repository.owner}/${value.repository.name} @ ${value.repository.githubHost} (${value.repository.repositoryId})`,
      `Repository home: ${value.repositoryHome}`,
      `Target branch: ${value.config.targetBranch}`,
      `Worker: ${value.config.worker.model} (thinking ${value.config.worker.thinking})`,
      `Reviewer: ${value.config.reviewer.model} (thinking ${value.config.reviewer.thinking})`,
      `Concurrency: ${value.config.concurrency} · maxWorkRounds: ${value.config.maxWorkRounds} · maxPushRetries: ${value.config.maxPushRetries}`,
      `Tests: ${value.config.tests.map((test) => test.argv.join(' ')).join(' ; ')}`,
      `configRevision: ${value.configRevision}`,
    ]
    if (!isSha256Digest(value.configRevision)) {
      lines.push('warning: configRevision is not digest-shaped')
    }
    return lines.join('\n')
  }
  if (outcome.kind === 'blocked') {
    return `Norn init blocked (${outcome.code}): ${outcome.reason}`
  }
  return `Norn init error (${outcome.code}): ${outcome.reason}`
}
