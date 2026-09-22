/**
 * Presentation of typed runner data. This file renders; it never decides.
 */
import type { NornCommandSummary, NornSubcommandInfo } from '../runner/commands.ts'
import type { InitOutcome } from '../runner/init.ts'
import type { CheckMapFinding, CheckMapOutcome } from '../runner/check.ts'
import type { TopologyFinding } from '../map/snapshot.ts'
import type { DeliveryEvidenceFinding, DeliveryRemedy } from '../evidence/delivery.ts'
import type { StatusOutcome } from '../runner/status.ts'
import type { RunMapOutcome } from '../run/lifecycle.ts'
import type { AbortOutcome } from '../run/abort.ts'
import type { ConfirmedWrite } from '../run/abort.ts'
import type { RunReport, RunState, TicketRunState } from '../runstate/types.ts'
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

function renderDeliveryFinding(finding: DeliveryEvidenceFinding): string {
  switch (finding.code) {
    case 'invalid-envelope':
      return `comment ${finding.commentId}: invalid norn:record envelope — ${finding.reason}`
    case 'invalid-record':
      return `comment ${finding.commentId}: invalid norn-delivery:v1 record — ${finding.problems.join('; ')}`
    case 'delivery-id-mismatch':
      return `comment ${finding.commentId}: deliveryId does not recompute from the sealed record`
    case 'divergent-duplicate':
      return `deliveryId ${finding.deliveryId} appears with divergent content in comments ${finding.commentIds.join(', ')}`
    case 'ambiguous-records':
      return `distinct valid delivery records exist (${finding.deliveryIds.join(', ')}) for the current ticket revision`
    case 'no-valid-record':
      return 'no valid Norn delivery record exists for this closed ticket'
    case 'stale-ticket-revision':
      return `the ticket revision changed since delivery (current ${finding.currentRevision}; recorded ${finding.recordedRevisions.join(', ')})`
    case 'ticket-open':
      return 'the ticket is open but a delivery record exists that satisfies every other predicate'
    case 'identity-mismatch':
      return `the record ${finding.detail === 'map' ? 'names a different map' : finding.detail === 'ticket' ? 'names a different ticket' : finding.detail === 'repository' ? 'names a different repository' : 'names a different target branch'} (expected ${finding.expected}, recorded ${finding.recorded})`
    case 'author-mismatch':
      return `the record comment author (${finding.commentAuthorId ?? 'none'}) does not equal the recorded actor ${finding.actorId}`
    case 'untrusted-author':
      return `the recorded actor ${finding.actorId} is not in trustedEvidenceAuthorIds`
    case 'missing-closing-event':
      return 'the timeline shows no current closing event for this closed ticket'
    case 'record-not-in-timeline':
      return `comment ${finding.commentId} does not appear in the issue timeline`
    case 'record-after-close':
      return `the delivery record comment follows the current closing event ${finding.closingEventId}`
    case 'invalid-gate':
      return `the sealed evidence gate is invalid — ${finding.problems.join('; ')}`
    case 'reviewer-gate-mismatch':
      return 'the passing review does not exactly match the gate reviewer'
    case 'review-binding-mismatch':
      return `the review binds a different ${finding.detail} than the record`
    case 'tests-gate-mismatch':
      return `the ordered test evidence does not realize the sealed gate tests — ${finding.problems.join('; ')}`
    case 'wrong-integration-shape':
      return `the integrated commit has the wrong shape — ${finding.detail}`
    case 'integrated-commit-absent':
      return `the integrated commit ${finding.integratedSha} is absent from the fetched history`
    case 'not-target-ancestor':
      return `the integrated commit ${finding.integratedSha} is not an ancestor of the current target branch (${finding.targetSha})`
  }
}

const DELIVERY_REMEDY_LABELS: Readonly<Record<DeliveryRemedy, string>> = {
  'reopen-for-fresh-work': 'reopen the ticket for fresh Work',
  'remove-from-map': 'remove the cancelled ticket from the map',
  'restore-recorded-facts': 'restore the recorded facts',
  'reclose-ticket': 'reclose the ticket',
  'change-ticket-specification': 'change the ticket specification before new Work',
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
    case 'model-unavailable':
      return `the ${finding.role} model "${finding.model}" is not in the authenticated model catalog`
    case 'model-family-conflict':
      return `worker (${finding.workerModel}) and reviewer (${finding.reviewerModel}) must resolve to different provider families (both are "${finding.family}")`
    case 'delivery-evidence': {
      const onlyOpenRecord =
        finding.ticketState === 'OPEN' &&
        finding.findings.length === 1 &&
        finding.findings[0]!.code === 'ticket-open'
      const header = onlyOpenRecord
        ? `member #${finding.ticket.number} is open but carries otherwise-valid delivery evidence; it is blocked, not silently re-worked:`
        : `member #${finding.ticket.number} [${finding.ticketState.toLowerCase()}] fails delivery-evidence validation:`
      const lines = [header]
      for (const violation of finding.findings) {
        lines.push(`  - ${renderDeliveryFinding(violation)}`)
      }
      lines.push(
        `  operator remedies: ${finding.remedies.map((remedy) => DELIVERY_REMEDY_LABELS[remedy]).join('; or ')}`,
      )
      return lines.join('\n')
    }
    case 'state-not-resumable':
      return `existing run state (${finding.runId}) is not resumable by this invocation: ${finding.mismatches.join(' and ')} differ; restore them or abort the run before starting a new one`
    case 'ticket-claimed-by-active-run':
      return `member ticket(s) ${finding.ticketIssueIds.join(', ')} are already claimed by active run ${finding.runId} (map #${finding.mapNumber})`
    case 'incompatible-active-run':
      return `active run ${finding.runId} (map #${finding.mapNumber}) uses a different ${finding.mismatches.join(' and ')}; all concurrent runs in a repository must share them`
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

/** `/norn status` takes exactly one full map URL. */
export function renderStatusTakesMapUrl(): string {
  return [
    '/norn status takes exactly one full GitHub issue URL:',
    '/norn status https://<host>/<owner>/<repository>/issues/<number>',
  ].join('\n')
}

function formatTicketLine(issueId: string, ticket: TicketRunState): string {
  switch (ticket.phase) {
    case 'waiting':
      return `  ${issueId}: waiting${ticket.wave === undefined ? '' : ` (last wave ${ticket.wave})`}`
    case 'working':
      return `  ${issueId}: working in wave ${ticket.wave} (attempt ${ticket.attempt.workAttemptId}, round ${ticket.attempt.round}, slot ${ticket.attempt.slot})`
    case 'parked':
      return `  ${issueId}: parked in wave ${ticket.wave} (${ticket.outcome.kind} ${ticket.outcome.code})`
    case 'shippable':
      return `  ${issueId}: shippable from wave ${ticket.wave} (tree ${ticket.change.candidateTreeOid})`
    case 'shipping':
      return `  ${issueId}: shipping (stage ${ticket.checkpoint.stage}, push attempts ${ticket.checkpoint.pushAttempts}, ${ticket.checkpoint.zeroDelta ? 'zero-delta' : 'new commit'})`
    case 'completed':
      return `  ${issueId}: completed (delivery ${ticket.deliveryId}, integrated ${ticket.integratedSha})`
  }
}

function renderRunState(state: RunState): string[] {
  const lines: string[] = [
    `Run: ${state.runId} — ${state.status}`,
    `Norn version: ${state.nornVersion} · configRevision: ${state.configRevision}`,
  ]

  const lineage = state.acceptedMapRevisions
  const first = lineage[0]
  const last = lineage.at(-1)
  lines.push(
    `Accepted Map revisions: ${lineage.length} (initial ${first?.revision ?? '—'} → current ${last?.revision ?? '—'})`,
  )
  for (const entry of lineage.slice(1)) {
    lines.push(
      `  extension ${entry.revision} <- ${entry.extension?.fromRevision ?? '—'} (+${(entry.extension?.addedTicketIssueIds ?? []).join(', ')})`,
    )
  }

  if (state.activeWave === undefined) {
    lines.push(`Current Wave: none (last wave number ${state.wave})`)
  } else {
    const wave = state.activeWave
    lines.push(
      `Current Wave: ${wave.number} on ${wave.mapRevision} at ${wave.target.branch}@${wave.target.baseSha} (next ship index ${wave.nextShipIndex} of ${wave.shipQueueTicketIssueIds.length})`,
    )
    if (wave.frontierTicketIssueIds.length > 0) {
      lines.push(`  frontier: ${wave.frontierTicketIssueIds.join(', ')}`)
    }
    if (wave.shipQueueTicketIssueIds.length > 0) {
      lines.push(`  ship queue: ${wave.shipQueueTicketIssueIds.join(', ')}`)
    }
  }

  if (state.mapCompletion !== undefined) {
    const completion = state.mapCompletion
    lines.push(
      `Map completion in progress: stage ${completion.stage} at ${completion.completionSha} (attempt ${completion.completionAttemptId}, revision ${completion.mapRevision})`,
    )
  }

  const tickets = Object.entries(state.tickets)
  if (tickets.length > 0) {
    lines.push(`Tickets (${tickets.length}):`)
    for (const [issueId, ticket] of tickets) lines.push(formatTicketLine(issueId, ticket))
  } else {
    lines.push('Tickets: none recorded')
  }

  if (state.parkedTickets.length > 0) {
    lines.push(`Parked: ${state.parkedTickets.map((ref) => ref.issueId).join(', ')}`)
  }

  const report = state.report
  if (report === undefined) {
    lines.push('Terminal report: none yet (the run has not reached a terminal state)')
    lines.push('Retained workspace: none')
  } else {
    lines.push(
      `Terminal report: ${report.label}${report.code === undefined ? '' : ` (${report.code})`} · sharedWrite ${report.sharedWrite}${report.completionSha === undefined ? '' : ` · completionSha ${report.completionSha}`}`,
    )
    if (report.retainedWorkspace !== undefined) {
      lines.push(`Retained workspace: ${report.retainedWorkspace.path}`)
    } else {
      lines.push('Retained workspace: none')
    }
    if (report.warnings.length > 0) {
      lines.push(`Warnings: ${report.warnings.join(' | ')}`)
    }
  }
  return lines
}

/** Render the typed `/norn status` outcome: persisted local facts only. */
export function renderStatusOutcome(outcome: StatusOutcome): string {
  if (outcome.kind === 'ok') {
    const { value } = outcome
    const lines = [
      `Norn status — ${value.requested.githubHost}/${value.requested.owner}/${value.requested.name}#${value.requested.number}`,
      'Local truth only: GitHub issues, Ticket states, and the target branch are not consulted; current remote facts may differ.',
      `Repository home: ${value.repositoryHome}`,
      `Map lock: ${value.mapLockHeldByLiveCoordinator ? 'held by a live coordinator' : 'not held'}`,
    ]
    if (value.runState === undefined) {
      lines.push('Run State: none exists for this map under repository home.')
    } else {
      lines.push(...renderRunState(value.runState))
      if (!isSha256Digest(value.runState.configRevision)) {
        lines.push('warning: configRevision is not digest-shaped')
      }
    }
    return lines.join('\n')
  }
  if (outcome.kind === 'blocked') {
    return `Norn status blocked (${outcome.code}): ${outcome.reason}`
  }
  return `Norn status error (${outcome.code}): ${outcome.reason}`
}

/** `/norn run` takes exactly one full map URL. */
export function renderRunTakesOneMapUrl(): string {
  return [
    '/norn run takes exactly one full GitHub issue URL:',
    '/norn run https://<host>/<owner>/<repository>/issues/<number>',
  ].join('\n')
}

/** `/norn abort` takes exactly one full map URL. */
export function renderAbortTakesOneMapUrl(): string {
  return [
    '/norn abort takes exactly one full GitHub issue URL:',
    '/norn abort https://<host>/<owner>/<repository>/issues/<number>',
  ].join('\n')
}

function renderConfirmedWrite(write: ConfirmedWrite): string {
  const detail =
    write.kind === 'integration'
      ? `ticket ${write.ticketIssueId} · ${write.stage} · ${write.integratedSha} · by ${write.provenBy}`
      : write.kind === 'map-close'
        ? `close event ${write.eventId}`
        : `record comment ${write.commentId}`
  return `  ${write.kind}: ${detail}`
}

/** Render the typed `/norn abort` outcome: the recorded lifecycle decision. */
export function renderAbortOutcome(outcome: AbortOutcome): string {
  if (outcome.kind === 'blocked') {
    return `Norn abort blocked (${outcome.code}): ${outcome.reason}`
  }
  if (outcome.kind === 'error') {
    const recoverable = outcome.sharedWrite !== 'none'
    return [
      `Norn abort error (${outcome.code}): ${outcome.reason}`,
      recoverable
        ? `sharedWrite ${outcome.sharedWrite}: the run remains "running" and recoverable — retry /norn abort or /norn run once the facts are provable; a new run cannot start from ambiguous state`
        : 'sharedWrite none',
    ].join('\n')
  }
  const value = outcome.value
  if (value.kind === 'passed') {
    return [
      `Norn abort — finalized map completion wins: run ${value.runId} terminalized passed.`,
      `completionSha ${value.report.completionSha ?? '—'} · sharedWrite confirmed`,
      'Remote evidence is intact; the next /norn run starts a fresh run ID.',
    ].join('\n')
  }
  const lines = [
    `Norn abort — run ${value.runId} is recorded aborted (Run State retained).`,
    `Settled process groups: ${value.settledProcessGroupIds.length} · released Work slots: ${value.releasedSlots.length}`,
    `sharedWrite: ${value.sharedWrite} — pushed commits and remote evidence are never rolled back.`,
  ]
  if (value.confirmedWrites.length > 0) {
    lines.push(`Confirmed shared writes (${value.confirmedWrites.length}):`)
    for (const write of value.confirmedWrites) lines.push(renderConfirmedWrite(write))
  }
  if (value.warnings.length > 0) {
    lines.push(`Warnings: ${value.warnings.join(' | ')}`)
  }
  lines.push('The next /norn run starts a fresh run ID and never reuses this run\'s unshipped Work.')
  return lines.join('\n')
}

function renderReportTickets(report: RunReport): string[] {
  const lines: string[] = []
  for (const entry of report.tickets) {
    lines.push(
      `  #${entry.ticket.number} [${entry.state}${entry.code === undefined ? '' : ` (${entry.code})`}]`,
    )
  }
  return lines
}

/** Render the typed `/norn run` outcome: the terminal RunReport for the operator. */
export function renderRunOutcome(outcome: RunMapOutcome): string {
  if (outcome.kind === 'error') {
    const recoverable = outcome.sharedWrite !== 'none'
    return [
      `Norn run error (${outcome.code}): ${outcome.reason}`,
      recoverable
        ? `sharedWrite ${outcome.sharedWrite}: the run remains "running" and resumable — the next compatible /norn run resumes the same run ID`
        : 'sharedWrite none: the run recorded a terminal error report',
    ].join('\n')
  }
  const report: RunReport | undefined =
    outcome.kind === 'ok' ? outcome.value : (outcome.evidence[0] as RunReport | undefined)
  if (report === undefined || typeof report.runId !== 'string') {
    return outcome.kind === 'ok'
      ? 'Norn run passed.'
      : `Norn run blocked (${(outcome as { readonly code: string }).code}): ${(outcome as { readonly reason: string }).reason}`
  }
  const lines = [
    `Norn run ${report.label}${report.code === undefined ? '' : ` (${report.code})`} — run ${report.runId}`,
    `Map revisions: ${report.initialMapRevision} → ${report.finalMapRevision} (${report.acceptedExtensions.length} accepted extension(s))`,
    `sharedWrite: ${report.sharedWrite}${report.completionSha === undefined ? '' : ` · completionSha ${report.completionSha}`}`,
    `Tickets (${report.tickets.length}):`,
    ...renderReportTickets(report),
  ]
  if (report.retainedWorkspace !== undefined) {
    lines.push(`Retained workspace: ${report.retainedWorkspace.path}`)
  }
  if (report.warnings.length > 0) {
    lines.push(`Warnings: ${report.warnings.join(' | ')}`)
  }
  if (outcome.kind === 'blocked') {
    lines.push(`Reason: ${outcome.reason}`)
  }
  return lines.join('\n')
}
