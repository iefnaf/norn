/**
 * Presentation of typed runner data. This file renders; it never decides.
 */
import type { NornCommandSummary, NornSubcommandInfo } from '../runner/commands.ts'
import type { InitOutcome } from '../runner/init.ts'
import type { CheckMapFinding, CheckMapOutcome } from '../runner/check.ts'
import type { TopologyFinding } from '../map/snapshot.ts'
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

/** `/norn check` takes exactly one full GitHub issue URL — no `#123`. */
export function renderCheckTakesOneMapUrl(): string {
  return [
    '/norn check takes exactly one full GitHub issue URL:',
    '  /norn check https://<github-host>/<owner>/<repository>/issues/<number>',
    'Issue-number shorthand such as #123 is not accepted.',
  ].join('\n')
}

function renderTopologyFinding(finding: TopologyFinding): string {
  switch (finding.code) {
    case 'map-has-no-members':
      return 'the map has no direct sub-issues; at least one member Ticket is required'
    case 'map-is-sub-issue':
      return `the map is itself a sub-issue of ${finding.parents.length} other issue(s): ${finding.parents.map((parent) => `#${parent.number}`).join(', ')}`
    case 'map-has-blockers':
      return `the map has native blockers of its own: ${finding.blockers.map((blocker) => `#${blocker.number}`).join(', ')}`
    case 'duplicate-member':
      return `member #${finding.memberRef.number} appears more than once in the map's sub-issue set`
    case 'member-is-map':
      return `member #${finding.memberRef.number} is the map issue itself`
    case 'cross-repository-member':
      return `member #${finding.memberRef.number} belongs to repository ${finding.memberRef.repositoryId}, not the map's repository ${finding.expected.repositoryId}`
    case 'member-has-sub-issues':
      return `member #${finding.memberRef.number} has its own sub-issues — the graph must be flat: ${finding.subIssues.map((sub) => `#${sub.number}`).join(', ')}`
    case 'member-has-other-parent':
      return `member #${finding.memberRef.number} is also a sub-issue of ${finding.otherParents.map((parent) => `#${parent.number}`).join(', ')} — the map must be its only parent`
    case 'member-not-child-of-map':
      return `member #${finding.memberRef.number} does not list the map as a parent issue`
    case 'external-blocker':
      return `member #${finding.memberRef.number} is blocked by #${finding.blockerRef.number}, which is not a direct member of the map`
    case 'member-self-block':
      return `member #${finding.memberRef.number} blocks itself`
    case 'dependency-cycle':
      return `dependency cycle: ${finding.cycleIssueIds.join(' → ')} → ${finding.cycleIssueIds[0] ?? ''}`
  }
}

function renderCheckFinding(finding: CheckMapFinding): string {
  switch (finding.kind) {
    case 'not-a-repository':
      return `${finding.cwd} is not inside a Git repository`
    case 'invalid-map-url':
      return `"${finding.input}" is not a full GitHub issue URL (https://<github-host>/<owner>/<repository>/issues/<number>; #123 shorthand is not accepted)`
    case 'repository-not-found':
      return 'the repository addressed by the map URL was not found on GitHub'
    case 'github-unauthenticated':
      return 'GitHub requires authentication for this host; run gh auth login'
    case 'issue-not-found':
      return 'the issue addressed by the map URL was not found'
    case 'map-repository-mismatch':
      return `the map URL addresses ${finding.mapIdentity}, but the local repository's remotes are: ${finding.localIdentities.length > 0 ? finding.localIdentities.join(', ') : '(none)'}`
    case 'no-config':
      return `repository home ${finding.repositoryHome} has no config.json; run /norn init first`
    case 'invalid-config':
      return `config.json is invalid: ${finding.violations.join('; ')}`
    case 'invalid-map':
      return [
        `the Task Map violates ${finding.findings.length} topology rule(s):`,
        ...finding.findings.map((entry) => `  - ${renderTopologyFinding(entry)}`),
      ].join('\n')
    case 'changed-input':
      return 'the Task Map kept changing across complete reads (changed-input); retry once edits settle'
  }
}

/** Render the typed `/norn check` outcome for the operator. */
export function renderCheckOutcome(outcome: CheckMapOutcome): string {
  if (outcome.kind === 'ok') {
    const { value } = outcome
    const lines = ['Norn check passed.', `Map: ${value.snapshot?.title ?? ''} — ${value.mapUrl}`]
    if (value.repository !== undefined) {
      lines.push(`Repository: ${value.repository.owner}/${value.repository.name} @ ${value.repository.githubHost} (${value.repository.repositoryId})`)
    }
    if (value.config !== undefined) {
      lines.push(`configRevision: ${value.config.configRevision}`)
    }
    if (value.snapshot !== undefined) {
      const snapshot = value.snapshot
      lines.push(`mapRevision: ${snapshot.mapRevision} · ${snapshot.tickets.length} member ticket(s)`)
      for (const ticket of snapshot.tickets) {
        const blockers = ticket.blockedBy.map((ref) => `#${ref.number}`).join(', ')
        lines.push(
          `  #${ticket.ref.number} ${ticket.title} [${ticket.state.toLowerCase()}]${blockers === '' ? '' : ` — blocked by ${blockers}`}`,
        )
      }
    }
    return lines.join('\n')
  }
  if (outcome.kind === 'blocked') {
    const report = outcome.evidence[0] as { findings?: CheckMapFinding[] } | undefined
    const header = `Norn check found ${report?.findings?.length ?? 'several'} finding(s):`
    const lines = report?.findings?.map((finding) => `- ${renderCheckFinding(finding)}`) ?? []
    return [header, ...lines].join('\n')
  }
  return `Norn check error (${outcome.code}): ${outcome.reason}`
}
