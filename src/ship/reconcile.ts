/**
 * Ship final candidate and reconciliation (design.md §11.1–§11.2, ticket #10).
 *
 * The serial path from one sealed `ShippableChange` to a push-ready
 * integration commit. Immediately before constructing the final candidate,
 * Norn re-reads the stable Map snapshot and its OPEN state, the Ticket's
 * revision and OPEN state, membership and blocker relationships, valid
 * Completed Ticket evidence for every blocker, and the latest remote target:
 *
 * - an identical revision continues directly;
 * - a Compatible Map Extension is persisted and adopted **first** — the
 *   Shippable Change retains the historical revision it was gated under;
 * - anything incompatible returns run-scoped `blocked(changed-input)` before
 *   any push (`sharedWrite` is `confirmed` iff this run already shipped an
 *   earlier Ticket).
 *
 * If the target advanced, the candidate is replayed onto it without conflict
 * resolution, worker history is replaced with one canonical integration
 * commit from a fixed template (stable locators only — never worker
 * messages, issue text, or GitHub auto-close keywords), and setup, the
 * complete test list, and a fresh independent review rerun bound to the new
 * base and the complete final tree. If the target did not advance, the Work
 * evidence remains applicable because both its base and its complete tree
 * are unchanged — evidence reuse is decided by the exact base and tree OID
 * pair, never by comparing changed file lists. A final tree equal to the
 * current target tree is a zero-delta finale: no empty commit is created and
 * the current target SHA becomes `integratedSha`.
 *
 * A replay conflict returns ticket-scoped `blocked(integration-conflict)`; a
 * failed integration gate returns ticket-scoped `blocked(ship-gate-failed)`;
 * both carry `sharedWrite: 'none'`. This module never pushes — the push, the
 * Ship Checkpoint's Delivery Record, and the target-lock ordering of §11.3
 * belong to the later Ship stages.
 *
 * Orchestration runs behind injectable seams: the git runners (checked-out
 * workspace operations and exit-code-aware plumbing), the Git delivery-facts
 * seam, the map stable-read, the extension-adoption store, the issue-
 * evidence reader, the Visible Agent Runner, and the Command runner — the
 * same seams the earlier tickets built.
 */
import { blocked, error, ok } from '../core/outcome.ts'
import type { Evidence, Outcome } from '../core/outcome.ts'
import { canonicalJson } from '../core/canonical-json.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'
import { canonicalJsonDigest } from '../core/digest.ts'
import type { Sha256Digest } from '../core/digest.ts'
import { computeMapRevision } from '../core/revision.ts'
import type { MapRevisionPayload } from '../core/revision.ts'
import type { RunConfigAgentRole, RunConfigCommand } from '../config/run-config.ts'
import type { GitCommandRunner, GitFactsCommandRunner } from '../adapters/git-repository.ts'
import { gitCliDeliveryFacts } from '../adapters/git-repository.ts'
import type { GitObjectOid } from '../agents/completion.ts'
import { AGENT_COMPLETION_SCHEMA, GIT_OBJECT_OID_PATTERN } from '../agents/completion.ts'
import type { AgentCompletionContext, ReviewerCompletion } from '../agents/completion.ts'
import { NORN_AGENT_CONTEXT_ENV } from '../agents/completion-extension.ts'
import { planAgentPiArgv } from '../agents/herdr-runner.ts'
import { runAgentInvocation } from '../agents/runner.ts'
import type { AgentSettlementErrorCode, VisibleAgentRunner } from '../agents/runner.ts'
import { evaluateDeliveryEvidence } from '../evidence/delivery.ts'
import type { DeliveryFactsErrorCode, DeliveryTargetFacts } from '../evidence/delivery.ts'
import type { IssueEvidenceReader } from '../evidence/read.ts'
import { classifyMapChange } from '../map/map-extension.ts'
import type { MapRef, TaskMapSnapshot } from '../map/snapshot.ts'
import type { StableSnapshotOutcome } from '../map/stable-read.ts'
import { loadRunState, saveRunState } from '../runstate/run-state-store.ts'
import type {
  AcceptedMapRevision,
  ReviewEvidence,
  ShippableChange,
  TestEvidence,
  TicketRef,
  WorkspaceRef,
} from '../runstate/types.ts'
import type { CommandRunner } from '../work/command-runner.ts'
import type { GateCommandErrorCode, GateCommandListValue, GateDeps } from '../work/gate.ts'
import { runGateCommandList } from '../work/gate.ts'
import { REVIEWER_READ_ONLY_TOOLS, isReadOnlyAgentArgv, modelProvider } from '../work/round-gate.ts'
import type { AgentLaunchPlan, ReviewerLaunchInput, ReviewerLaunchPlanner } from '../work/round-gate.ts'
import { formatGitObjectOid, inspectWorkspace, parseGitObjectOid } from '../work/workspace.ts'
import type { GitObjectFormat, WorkspaceErrorCode } from '../work/workspace.ts'

// ---------------------------------------------------------------------------
// Outcome vocabulary (§9, §11.1–§11.2)
// ---------------------------------------------------------------------------

/** Closed block codes of final-candidate reconciliation. */
export type ShipReconcileBlockCode =
  /** A §11.1 precondition failed: run-scoped, stops the shipping queue. */
  | 'changed-input'
  /** The candidate could not be replayed onto the advanced target (§11.2). */
  | 'integration-conflict'
  /** An integration setup, test, or review gate did not pass (§11.2). */
  | 'ship-gate-failed'
  /** A child reviewer invocation was interrupted before settlement (§17). */
  | 'user-abort'

/** Closed error codes of final-candidate reconciliation; scope is fixed per code (§9). */
export type ShipReconcileErrorCode =
  | AgentSettlementErrorCode
  | GateCommandErrorCode
  | WorkspaceErrorCode
  /** The stable Map read failed on infrastructure — run-scoped. */
  | 'map-read'
  /** The remote target could not be fetched or read — run-scoped. */
  | 'target-read'
  /** Blocker delivery evidence could not be read or evaluated — run-scoped. */
  | 'evidence-read'
  /** Git plumbing (replay, commit-tree, checkout, diff) failed — ticket-scoped. */
  | 'git-failed'
  /** Extension adoption persistence failed — run-scoped (§9). */
  | 'control-store'
  /** A produced candidate failed its independent integration-shape check. */
  | 'integration-shape'
  /** The ship reviewer launch plan exposes write-capable tools (§10.2). */
  | 'reviewer-not-read-only'

/** The push-ready result of one reconciliation. */
export type FinalCandidate = {
  readonly ticket: TicketRef
  /** The final tree equals the current target tree (§11.2). */
  readonly zeroDelta: boolean
  /** The current target commit the candidate is gated against. */
  readonly baseSha: GitObjectOid
  /** The canonical integration commit, or the current target SHA when zero-delta. */
  readonly integratedSha: GitObjectOid
  /** The complete reconciled final tree. */
  readonly treeOid: GitObjectOid
  /** The canonical integration commit itself, or `null` for a zero-delta finale. */
  readonly integrationCommit: GitObjectOid | null
  /** The map revision the carried review binds — historical when evidence is reused. */
  readonly mapRevision: string
  readonly ticketRevision: string
  /** Reused Work evidence or fresh ship evidence (§10.3, §11.2). */
  readonly tests: readonly TestEvidence[]
  readonly review: ReviewEvidence
  /** The Compatible Map Extension adopted before this candidate, if any. */
  readonly adoptedExtension?: {
    readonly revision: string
    readonly fromRevision: string
    readonly addedTicketIssueIds: readonly string[]
  }
}

export type ShipReconcileOutcome = Outcome<
  FinalCandidate,
  ShipReconcileBlockCode,
  ShipReconcileErrorCode
>

// ---------------------------------------------------------------------------
// Canonical commit metadata (§11.2)
// ---------------------------------------------------------------------------

/**
 * The keywords GitHub substitutes in commit messages to auto-close issues.
 * The canonical commit template must never contain any of them — closing a
 * Ticket is Norn's §11.3 protocol, never a commit-message side effect.
 */
export const GITHUB_AUTO_CLOSE_KEYWORDS: readonly string[] = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
]

const AUTO_CLOSE_PATTERN = new RegExp(`\\b(?:${GITHUB_AUTO_CLOSE_KEYWORDS.join('|')})\\b`, 'i')

/**
 * Whether `text` contains any GitHub auto-close keyword as a whole word.
 * Deliberately conservative: it ignores whether an issue reference follows,
 * so the canonical template cannot even resemble an auto-close instruction.
 */
export function containsAutoCloseKeyword(text: string): boolean {
  return AUTO_CLOSE_PATTERN.test(text)
}

/** The stable locators the canonical commit message is built from. */
export type CanonicalCommitMetadata = {
  readonly ticketNumber: number
  readonly ticketIssueId: string
  readonly mapIssueId: string
  readonly runId: string
}

/**
 * The fixed canonical commit message template (§11.2): stable locators only.
 * Worker messages, issue text, and any other prose are structurally
 * incapable of entering this template, and the rendered message is checked
 * against the auto-close keyword list before it leaves.
 */
export function canonicalCommitMessage(metadata: CanonicalCommitMetadata): string {
  const message =
    `norn: ship ticket #${metadata.ticketNumber}\n` +
    '\n' +
    `map: ${metadata.mapIssueId}\n` +
    `ticket: ${metadata.ticketIssueId}\n` +
    `run: ${metadata.runId}\n`
  if (containsAutoCloseKeyword(message)) {
    throw new TypeError(
      'the canonical commit template must never contain GitHub auto-close keywords (design.md §11.2)',
    )
  }
  return message
}

/** The fixed committer identity of every canonical integration commit. */
export const CANONICAL_COMMIT_IDENTITY = Object.freeze({
  name: 'Norn',
  email: 'norn@delivery.invalid',
} as const)

// ---------------------------------------------------------------------------
// The injected seams
// ---------------------------------------------------------------------------

/**
 * The Git facts one reconciliation needs: the §14 `DeliveryTargetFacts`
 * (used both for blocker completion evidence and for integration-shape
 * verification) plus the target fetch that makes the reads current.
 */
export type ShipFacts = DeliveryTargetFacts & {
  /** Fetch the remote target branch; later reads then see current truth. */
  fetchTarget(branch: string): Promise<Outcome<void, never, DeliveryFactsErrorCode>>
}

/** One Compatible Map Extension to persist and adopt (§7.4, §11.1). */
export type ShipExtensionAdoption = {
  readonly revision: Sha256Digest
  readonly payload: MapRevisionPayload
  readonly fromRevision: Sha256Digest
  readonly addedTicketIssueIds: readonly string[]
}

export type ShipReconcileDeps = {
  /** The git seam for checked-out workspace operations and diffs. */
  readonly git: GitCommandRunner
  /** The exit-code-aware git seam for replay plumbing (`merge-tree`). */
  readonly gitDetailed: GitFactsCommandRunner
  /** The remote target and commit facts seam. */
  readonly facts: ShipFacts
  /** One stable read of the current Task Map snapshot (§7.3). */
  readonly readMap: () => Promise<StableSnapshotOutcome>
  /** Persists a Compatible Map Extension before Ship continues (§7.4, §7.1).
   * `blocked(changed-input)` means another active run claimed an added
   * Ticket under the repository control lock — adoption is prevented and the
   * change is treated as incompatible (§7.4, §16).
   */
  readonly adoptExtension: (
    extension: ShipExtensionAdoption,
  ) => Promise<Outcome<void, 'changed-input', 'control-store'>>
  /** The issue-evidence reader for blocker completion evidence (§14). */
  readonly readIssueEvidence: IssueEvidenceReader['loadIssueEvidence']
  /** The Visible Agent Runner seam for the ship reviewer (§6, §17). */
  readonly runner: VisibleAgentRunner
  /** The Command runner seam for setup and tests (§6, §10.2). */
  readonly commands: CommandRunner
  /** Builds the read-only ship reviewer launch. */
  readonly planReviewer: ReviewerLaunchPlanner
  /** Validates the reviewer plan; defaults to the argv allowlist check. */
  readonly reviewerPlanIsReadOnly?: (plan: AgentLaunchPlan) => boolean
  /** Unique tame invocation IDs for the ship reviewer; unique per launch. */
  readonly newInvocationId: () => string
}

/** Everything one reconciliation needs, beyond its injected seams. */
export type ShipReconcileParams = {
  /** The sealed Work result being shipped (§10.3). */
  readonly change: ShippableChange
  /** The latest accepted lineage entry when Ship starts (§7.4, §13.1). */
  readonly accepted: AcceptedMapRevision
  readonly runId: string
  /** Root of the target repository; git plumbing runs here. */
  readonly repositoryRoot: string
  readonly targetBranch: string
  readonly setup: readonly RunConfigCommand[]
  readonly tests: readonly RunConfigCommand[]
  readonly reviewer: RunConfigAgentRole & { readonly family: string }
  readonly trustedEvidenceAuthorIds: readonly string[]
  /** Run-owned completions area, outside every workspace (§17). */
  readonly completionsDir: string
  /** Whether this run already shipped an earlier Ticket (§11.1). */
  readonly alreadyShipped: boolean
}

// ---------------------------------------------------------------------------
// Production adapters over the built-in seams
// ---------------------------------------------------------------------------

/**
 * The production Git facts adapter: the built-in `git` CLI delivery-facts
 * adapter bound to one repository root and remote. One fetch per
 * reconciliation makes the shape and ancestry decisions current (§13.3, §14).
 */
export function gitCliShipFacts(options: {
  readonly root: string
  readonly remote: string
  readonly run?: GitFactsCommandRunner
}): ShipFacts {
  const adapter = gitCliDeliveryFacts(options.run)
  return {
    fetchTarget: (branch) => adapter.fetchTarget(options.root, options.remote, branch),
    targetSha: (branch) => adapter.targetSha(options.root, options.remote, branch),
    commitFacts: (sha) => adapter.commitFacts(options.root, sha),
    isAncestorOfTarget: (sha, branch) =>
      adapter.isAncestorOfTarget(options.root, options.remote, branch, sha),
  }
}

/**
 * The production extension-adoption store over one Run State document
 * (§7.4, §13.1): appends the verified extension entry to the accepted
 * lineage atomically. `saveRunState` re-verifies the recorded transition
 * (payload re-hash plus the §7.4 member/dependency rules) before any byte is
 * written, so an unclassifiable transition can never persist. The lock-order
 * dance around adoption (release target lock, take the repository control
 * lock) belongs to the §11.3 push stages.
 */
export function runStateAdoptExtension(options: {
  readonly repositoryHome: string
  readonly encodedMapIssueId: string
}): (extension: ShipExtensionAdoption) => Promise<Outcome<void, never, 'control-store'>> {
  return async (extension) => {
    const loaded = loadRunState(options.repositoryHome, options.encodedMapIssueId)
    if (loaded.kind !== 'ok') {
      return adoptionError('loading run state for extension adoption', loaded.code, loaded.reason)
    }
    if (loaded.value === undefined) {
      return adoptionError(
        'loading run state for extension adoption',
        'control-store',
        'no run state exists for this map',
      )
    }
    const state = loaded.value
    const latest = state.acceptedMapRevisions.at(-1)
    if (latest === undefined || latest.revision !== extension.fromRevision) {
      return adoptionError(
        'appending the adopted extension',
        'control-store',
        `the persisted latest accepted revision ${latest?.revision ?? 'none'} is not the extension's base ${extension.fromRevision}`,
      )
    }
    const saved = saveRunState(options.repositoryHome, options.encodedMapIssueId, {
      ...state,
      acceptedMapRevisions: [
        ...state.acceptedMapRevisions,
        {
          revision: extension.revision,
          payload: extension.payload,
          extension: {
            fromRevision: extension.fromRevision,
            addedTicketIssueIds: [...extension.addedTicketIssueIds],
          },
        },
      ],
    })
    if (saved.kind !== 'ok') {
      return adoptionError('persisting the adopted extension', saved.code, saved.reason)
    }
    return ok(undefined)
  }
}

function adoptionError(
  what: string,
  code: 'control-store' | 'state-integrity',
  reason: string,
): Outcome<never, never, 'control-store'> {
  return error({
    scope: 'run',
    code: 'control-store',
    reason: `extension adoption failed while ${what}: ${reason}`,
    sharedWrite: 'none',
    evidence: [{ originalCode: code }],
  })
}

// ---------------------------------------------------------------------------
// The ship reviewer launch (§11.2 step 4, after §10.2's pattern)
// ---------------------------------------------------------------------------

function renderShipReviewerPrompt(input: ReviewerLaunchInput): string {
  const brief = {
    schema: 'norn-ship-review-brief:v1',
    spec: input.spec,
    target: input.target,
    candidate: input.candidate,
    tests: input.tests,
    testOutput: input.testOutput,
  }
  return (
    'You are the independent Norn Reviewer for a reconciled Ship candidate. You have ' +
    'read-only tools. Judge whether the reconciled candidate satisfies the open Ticket ' +
    'against the bound target base and the complete final tree, using the ' +
    'coordinator-generated diff and the ordered ship test evidence. ' +
    (input.candidate.zeroDelta
      ? 'This is a zero-delta finale: the final tree equals the current target tree, so ' +
        'judge the assertion that the existing target already satisfies the Ticket. '
      : '') +
    'Finish with the norn_complete tool: pass, iterate with feedback, or a typed block. ' +
    'Review briefing (JSON):\n' +
    canonicalJson(brief as CanonicalJsonValue) +
    '\nCoordinator-generated diff:\n' +
    input.diff
  )
}

/**
 * The production read-only ship reviewer launch: the configured reviewer
 * model, the completion extension, and the strict §10.2 read-only tool
 * allowlist. Write-capable built-ins are absent, so the reviewer cannot
 * modify the repository it judges.
 */
export function piShipReviewerLaunch(
  input: ReviewerLaunchInput,
  options: {
    readonly model: string
    readonly thinking: string
    readonly extensionPath: string
    readonly piSessionId: string
  },
): AgentLaunchPlan {
  return {
    argv: [
      ...planAgentPiArgv(
        { model: options.model, thinking: options.thinking },
        { extensionPath: options.extensionPath, piSessionId: options.piSessionId },
      ),
      '--tools',
      REVIEWER_READ_ONLY_TOOLS.join(','),
      renderShipReviewerPrompt(input),
    ],
  }
}

// ---------------------------------------------------------------------------
// Final-candidate reconciliation (§11.1–§11.2)
// ---------------------------------------------------------------------------

/** The attempt-owned workspace variant of `WorkspaceRef` (§10.1). */
type TicketWorkspaceRef = Extract<WorkspaceRef, { readonly kind: 'ticket' }>

/** One internally read remote target commit. */
type TargetRead = {
  readonly sha: GitObjectOid
  readonly treeOid: GitObjectOid
}

/** The reconciled candidate before its evidence is assembled. */
type Integration = {
  readonly zeroDelta: boolean
  readonly baseSha: GitObjectOid
  readonly integratedSha: GitObjectOid
  readonly treeOid: GitObjectOid
  readonly integrationCommit: GitObjectOid | null
  /** The commit the gate workspace must sit at (integration commit or target). */
  readonly gateHead: GitObjectOid
}

/**
 * Reconcile one sealed `ShippableChange` into a push-ready `FinalCandidate`
 * (design.md §11.1–§11.2). The §11.1 preconditions are re-read first; a
 * Compatible Map Extension is persisted and adopted before anything else
 * continues; an incompatible change returns run-scoped
 * `blocked(changed-input)` before any push. Fresh gates run exactly when the
 * target advanced — the evidence binding `(baseSha, treeOid)` changed — and
 * never merely because changed file lists happened to look unchanged. This
 * function never pushes.
 */
export async function reconcileFinalCandidate(
  deps: ShipReconcileDeps,
  params: ShipReconcileParams,
): Promise<ShipReconcileOutcome> {
  const change = params.change
  if (change.workspace.kind !== 'ticket') {
    return shipError(
      'ticket',
      'integration-shape',
      'the sealed change does not carry an attempt-owned ticket workspace',
      [{ workspaceKind: change.workspace.kind }],
    )
  }
  const ticketWorkspace: TicketWorkspaceRef = change.workspace
  const format = parseGitObjectOid(change.baseSha)?.objectFormat
  if (
    format === undefined ||
    parseGitObjectOid(change.candidateCommit) === undefined ||
    parseGitObjectOid(change.candidateTreeOid) === undefined
  ) {
    return shipError('ticket', 'integration-shape', 'the sealed change carries malformed Git OIDs', [
      {
        baseSha: change.baseSha,
        candidateCommit: change.candidateCommit,
        candidateTreeOid: change.candidateTreeOid,
      },
    ])
  }

  // --- §11.1: re-read the stable Map snapshot ------------------------------

  const mapRead = await deps.readMap()
  if (mapRead.kind === 'error') {
    return shipError('run', 'map-read', mapRead.reason, [...mapRead.evidence])
  }
  if (mapRead.kind === 'blocked') {
    // An unstable read or a structurally invalid map is a changed input: a
    // previously valid map that became invalid is an incompatible change (§7.4).
    return changedInput(params, [
      { stage: 'map-read', code: mapRead.code, reason: mapRead.reason },
      ...mapRead.evidence,
    ])
  }
  const snapshot = mapRead.value
  if (snapshot.state !== 'OPEN') {
    return changedInput(params, [
      { stage: 'map-state', mapState: snapshot.state, mapRevision: snapshot.mapRevision },
    ])
  }

  // --- §11.1: classify against the latest accepted snapshot -----------------

  const acceptedSnapshot = acceptedSnapshotFrom(params.accepted, snapshot.ref)
  const classification = classifyMapChange(acceptedSnapshot, snapshot)
  let latestRevision = params.accepted.revision
  let adoptedExtension: FinalCandidate['adoptedExtension']
  if (classification.kind === 'incompatible') {
    return changedInput(params, [
      { stage: 'map-classification', kind: 'incompatible', reasons: classification.reasons },
    ])
  }
  if (classification.kind === 'compatible-extension') {
    // Persisted and adopted FIRST: nothing else in this Ship proceeds against
    // the extended map before the lineage entry is durable (§7.4, §11.1).
    const payload = snapshotMapPayload(snapshot)
    if (payload.revision !== snapshot.mapRevision) {
      return shipError('run', 'map-read', 'the current snapshot does not re-hash to its revision', [
        { mapRevision: snapshot.mapRevision },
      ])
    }
    const persisted = await deps.adoptExtension({
      revision: snapshot.mapRevision,
      payload: payload.payload,
      fromRevision: params.accepted.revision,
      addedTicketIssueIds: classification.addedTicketIssueIds,
    })
    if (persisted.kind === 'blocked') {
      // §7.4/§16: another active run claimed an added Ticket under the
      // repository control lock — the change is treated as incompatible.
      return changedInput(params, [
        { stage: 'extension-adoption', reason: persisted.reason },
        ...persisted.evidence,
      ])
    }
    if (persisted.kind !== 'ok') {
      return shipError('run', 'control-store', persisted.reason, [...persisted.evidence])
    }
    adoptedExtension = {
      revision: snapshot.mapRevision,
      fromRevision: params.accepted.revision,
      addedTicketIssueIds: classification.addedTicketIssueIds,
    }
    latestRevision = snapshot.mapRevision
  }

  // --- §11.1: the shipped Ticket's specification, membership, blockers, state

  const ticketIssueId = change.ticket.issueId
  const ticket = snapshot.tickets.find((entry) => entry.ref.issueId === ticketIssueId)
  if (ticket === undefined) {
    return changedInput(params, [
      { stage: 'ticket-membership', ticketIssueId, present: false },
    ])
  }
  if (ticket.state !== 'OPEN') {
    return changedInput(params, [{ stage: 'ticket-state', ticketIssueId, state: ticket.state }])
  }
  if (ticket.ticketRevision !== change.ticketRevision) {
    return changedInput(params, [
      {
        stage: 'ticket-revision',
        ticketIssueId,
        sealed: change.ticketRevision,
        current: ticket.ticketRevision,
      },
    ])
  }
  const acceptedBlockers = blockerIdsOf(params.accepted.payload, ticketIssueId)
  const currentBlockers = new Set(ticket.blockedBy.map((ref) => ref.issueId))
  if (!sameIdSet(acceptedBlockers, currentBlockers)) {
    return changedInput(params, [
      {
        stage: 'ticket-blockers',
        ticketIssueId,
        sealed: [...acceptedBlockers].sort(),
        current: [...currentBlockers].sort(),
      },
    ])
  }

  // --- §11.1: valid Completed Ticket evidence for every blocker -------------

  for (const blockerRef of ticket.blockedBy) {
    const blocker = snapshot.tickets.find((entry) => entry.ref.issueId === blockerRef.issueId)
    if (blocker === undefined) {
      return changedInput(params, [
        { stage: 'blocker-membership', blockerIssueId: blockerRef.issueId, present: false },
      ])
    }
    const blockerOutcome = await evaluateBlockerCompletion(deps, params, blocker)
    if (blockerOutcome !== undefined) return blockerOutcome
  }

  // --- §11.1: the latest remote target --------------------------------------

  const target = await readTarget(deps, params, format)
  if (target.kind !== 'ok') return target.outcome
  const targetAdvanced = target.sha !== change.baseSha

  // --- §11.2: the final candidate -------------------------------------------

  if (!targetAdvanced) {
    // Both the reviewed base and the complete reviewed tree are unchanged, so
    // the Work evidence remains applicable; worker history still collapses to
    // one canonical commit unless the finale is zero-delta (§11.2).
    const zeroDelta = change.candidateTreeOid === target.treeOid
    if (zeroDelta) {
      return ok(
        finalizeCandidate(
          change,
          {
            zeroDelta: true,
            baseSha: target.sha,
            integratedSha: target.sha,
            treeOid: change.candidateTreeOid,
            integrationCommit: null,
            gateHead: target.sha,
          },
          change.tests,
          change.review,
          adoptedExtension,
        ),
      )
    }
    const commit = await createCanonicalCommit(deps, params, target.sha, change.candidateTreeOid)
    if (commit.outcome !== undefined) return commit.outcome
    return ok(
      finalizeCandidate(
        change,
        {
          zeroDelta: false,
          baseSha: target.sha,
          integratedSha: commit.commit,
          treeOid: change.candidateTreeOid,
          integrationCommit: commit.commit,
          gateHead: commit.commit,
        },
        change.tests,
        change.review,
        adoptedExtension,
      ),
    )
  }

  // The target advanced: replay without conflict resolution, then re-gate
  // against the new base and the complete final tree (§11.2).
  const replay = await replayCandidate(deps, params, target)
  if (replay.kind === 'conflict') {
    return blocked({
      scope: 'ticket',
      code: 'integration-conflict',
      reason:
        `the candidate for ticket #${change.ticket.number} conflicts when replayed onto the ` +
        `advanced target ${target.sha}`,
      sharedWrite: 'none',
      evidence: [
        {
          baseSha: change.baseSha,
          targetSha: target.sha,
          candidateCommit: change.candidateCommit,
          conflictedPaths: [...replay.conflictedPaths],
        },
      ],
    })
  }
  if (replay.outcome !== undefined) return replay.outcome

  const finalTree = replay.treeOid
  const zeroDelta = finalTree === target.treeOid
  let integration: Integration
  if (zeroDelta) {
    integration = {
      zeroDelta: true,
      baseSha: target.sha,
      integratedSha: target.sha,
      treeOid: finalTree,
      integrationCommit: null,
      gateHead: target.sha,
    }
  } else {
    const commit = await createCanonicalCommit(deps, params, target.sha, finalTree)
    if (commit.outcome !== undefined) return commit.outcome
    integration = {
      zeroDelta: false,
      baseSha: target.sha,
      integratedSha: commit.commit,
      treeOid: finalTree,
      integrationCommit: commit.commit,
      gateHead: commit.commit,
    }
  }

  // §11.2 steps 2–5, in the sealed attempt workspace at the final tree.
  const gates = await runFreshGates(deps, params, ticketWorkspace, snapshot, ticket, target, {
    integration,
    latestRevision,
  })
  if (gates.kind !== 'ok') return gates.outcome
  return ok(finalizeCandidate(change, integration, gates.tests, gates.review, adoptedExtension))
}

// ---------------------------------------------------------------------------
// §11.1 helpers
// ---------------------------------------------------------------------------

/** Evaluate one blocker's Completed Ticket evidence; a value means: return it.
 *
 * Exported so the §11.3 push stages revalidate blocker completion evidence
 * (§11.1, §13.3 step 2) through exactly the same rules as reconciliation. */
export async function evaluateBlockerCompletion(
  deps: ShipReconcileDeps,
  params: ShipReconcileParams,
  blocker: TaskMapSnapshot['tickets'][number],
): Promise<ShipReconcileOutcome | undefined> {
  const read = await deps.readIssueEvidence({
    githubHost: blocker.ref.githubHost,
    number: blocker.ref.number,
    url: blocker.ref.url,
  })
  if (read.kind === 'error') {
    return shipError('run', 'evidence-read', read.reason, [
      { blockerIssueId: blocker.ref.issueId },
      ...read.evidence,
    ])
  }
  if (read.kind === 'blocked') {
    return changedInput(params, [
      {
        stage: 'blocker-evidence-read',
        blockerIssueId: blocker.ref.issueId,
        code: read.code,
        reason: read.reason,
      },
    ])
  }
  const evaluation = await evaluateDeliveryEvidence({
    map: {
      issueId: params.accepted.payload.mapIssueId,
      repositoryId: params.accepted.payload.repositoryId,
    },
    ticket: {
      issueId: blocker.ref.issueId,
      state: blocker.state,
      ticketRevision: blocker.ticketRevision,
    },
    targetBranch: params.targetBranch,
    trustedEvidenceAuthorIds: params.trustedEvidenceAuthorIds,
    evidence: read.value,
    facts: deps.facts,
  })
  if (evaluation.status === 'error') {
    return shipError('run', 'evidence-read', evaluation.reason, [
      { blockerIssueId: blocker.ref.issueId, code: evaluation.code },
    ])
  }
  if (evaluation.status !== 'completed') {
    return changedInput(params, [
      {
        stage: 'blocker-completion',
        blockerIssueId: blocker.ref.issueId,
        status: evaluation.status,
        findings: evaluation.status === 'no-record' ? [] : [...evaluation.findings],
      },
    ])
  }
  return undefined
}

/** Fetch and read the current remote target commit and its tree (§11.1). */
async function readTarget(
  deps: ShipReconcileDeps,
  params: ShipReconcileParams,
  format: GitObjectFormat,
): Promise<
  | ({ readonly kind: 'ok' } & TargetRead)
  | { readonly kind: 'error'; readonly outcome: ShipReconcileOutcome }
> {
  const failure = (reason: string, evidence: readonly Evidence[] = []) => ({
    kind: 'error' as const,
    outcome: shipError('run', 'target-read', reason, evidence),
  })
  const fetched = await deps.facts.fetchTarget(params.targetBranch)
  if (fetched.kind !== 'ok') return failure(fetched.reason, [...fetched.evidence])
  const shaRead = await deps.facts.targetSha(params.targetBranch)
  if (shaRead.kind !== 'ok') return failure(shaRead.reason, [...shaRead.evidence])
  const sha = normalizeOid(format, shaRead.value)
  if (sha === undefined) {
    return failure(`the target SHA is not a ${format} object ID`, [{ targetSha: shaRead.value }])
  }
  const commitRead = await deps.facts.commitFacts(stripOid(sha))
  if (commitRead.kind !== 'ok') return failure(commitRead.reason, [...commitRead.evidence])
  if (commitRead.value === undefined) {
    return failure(`the target commit ${sha} is absent after the fetch`, [{ targetSha: sha }])
  }
  const treeOid = normalizeOid(format, commitRead.value.treeOid)
  if (treeOid === undefined) {
    return failure(`the target commit ${sha} carries a tree that is not a ${format} object ID`)
  }
  return { kind: 'ok', sha, treeOid }
}

/**
 * Synthesize the snapshot shape the §7.4 classifier consumes from one
 * accepted lineage entry (§13.1 stores the canonical payload, not the full
 * snapshot). Display locators are unused by classification and borrow the
 * current snapshot's values. Exported so the §11.3 push stages classify the
 * current snapshot against the same accepted-lineage view.
 */
export function acceptedSnapshotFrom(entry: AcceptedMapRevision, currentRef: MapRef): TaskMapSnapshot {
  const payload = entry.payload
  const mapRef: MapRef = {
    role: 'map',
    githubHost: payload.githubHost,
    repositoryId: payload.repositoryId,
    issueId: payload.mapIssueId,
    number: currentRef.number,
    url: currentRef.url,
  }
  const tickets: TaskMapSnapshot['tickets'] = payload.members.map((member) => {
    const ticketRef: TicketRef = {
      role: 'ticket',
      githubHost: payload.githubHost,
      repositoryId: payload.repositoryId,
      issueId: member.ticketIssueId,
      number: 0,
      url: currentRef.url,
    }
    return {
      ref: ticketRef,
      title: '',
      body: '',
      state: 'OPEN' as const,
      blockedBy: payload.dependencies
        .filter((edge) => edge.blockedIssueId === member.ticketIssueId)
        .map((edge) => ({ ...ticketRef, issueId: edge.blockerIssueId })),
      // The payload stores member revisions as plain strings; they are
      // digests by construction (§7.3) and the classifier only compares them.
      ticketRevision: member.ticketRevision as Sha256Digest,
    }
  })
  return {
    ref: mapRef,
    title: payload.title,
    body: payload.body,
    state: 'OPEN',
    mapRevision: entry.revision,
    tickets,
  }
}

/**
 * The Map revision payload of a snapshot, recomputed exactly as §7.3 defines
 * it — the value an accepted lineage entry persists. Exported so callers
 * (and tests) build lineage entries and extension adoptions consistently.
 */
export function snapshotMapPayload(
  snapshot: TaskMapSnapshot,
): { revision: Sha256Digest; payload: MapRevisionPayload } {
  const result = computeMapRevision({
    githubHost: snapshot.ref.githubHost,
    repositoryId: snapshot.ref.repositoryId,
    mapIssueId: snapshot.ref.issueId,
    title: snapshot.title,
    body: snapshot.body,
    members: snapshot.tickets.map((ticket) => ({
      ticketIssueId: ticket.ref.issueId,
      ticketRevision: ticket.ticketRevision,
    })),
    dependencies: snapshot.tickets.flatMap((ticket) =>
      ticket.blockedBy.map((blocker) => ({
        blockerIssueId: blocker.issueId,
        blockedIssueId: ticket.ref.issueId,
      })),
    ),
  })
  return result
}

/** The complete blocker ID set one payload records for `ticketIssueId`. */
function blockerIdsOf(payload: MapRevisionPayload, ticketIssueId: string): Set<string> {
  return new Set(
    payload.dependencies
      .filter((edge) => edge.blockedIssueId === ticketIssueId)
      .map((edge) => edge.blockerIssueId),
  )
}

function sameIdSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) {
    if (!b.has(id)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// §11.2 helpers: replay, the canonical commit, fresh gates
// ---------------------------------------------------------------------------

type ReplayResult =
  | ({ readonly kind: 'replayed'; readonly treeOid: GitObjectOid } & { readonly outcome?: undefined })
  | ({ readonly kind: 'conflict'; readonly conflictedPaths: readonly string[] } & { readonly outcome?: undefined })
  | { readonly kind: 'git-error'; readonly outcome: ShipReconcileOutcome }

/**
 * Replay the candidate onto the advanced target without resolving conflicts
 * (§11.2): one three-way merge of the candidate against the target with the
 * sealed base as the merge base, computed by `merge-tree` plumbing that
 * never touches a working tree. Exit status 1 is a conflict — the conflicted
 * paths are reported and nothing is resolved.
 */
async function replayCandidate(
  deps: ShipReconcileDeps,
  params: ShipReconcileParams,
  target: TargetRead,
): Promise<ReplayResult> {
  const change = params.change
  const merge = await deps.gitDetailed(
    [
      'merge-tree',
      '--write-tree',
      '--name-only',
      `--merge-base=${stripOid(change.baseSha)}`,
      stripOid(target.sha),
      stripOid(change.candidateCommit),
    ],
    params.repositoryRoot,
  )
  if (merge.ok) {
    const treeHex = merge.stdout.split('\n', 1)[0]?.trim() ?? ''
    const objectFormat = parseGitObjectOid(change.baseSha)?.objectFormat
    const treeOid =
      objectFormat === undefined ? undefined : formatGitObjectOid(objectFormat, treeHex)
    if (treeOid === undefined) {
      return {
        kind: 'git-error',
        outcome: shipError('ticket', 'git-failed', 'merge-tree produced no merged tree', [
          { stdout: merge.stdout },
        ]),
      }
    }
    return { kind: 'replayed', treeOid }
  }
  if (merge.exitCode === 1) {
    // With `--name-only`, the conflicted paths occupy the lines between the
    // tree and the first empty line; the trailing informational messages are
    // not paths.
    const lines = (merge.stdout ?? '').split('\n')
    const conflictedPaths: string[] = []
    for (const line of lines.slice(1)) {
      if (line === '') break
      conflictedPaths.push(line)
    }
    return { kind: 'conflict', conflictedPaths }
  }
  return {
    kind: 'git-error',
    outcome: shipError('ticket', 'git-failed', `replaying the candidate failed: ${merge.message}`, [
      { exitCode: merge.exitCode ?? null, operation: 'merge-tree' },
    ]),
  }
}

type CreatedCommit =
  | { readonly commit: GitObjectOid; readonly outcome?: undefined }
  | { readonly commit?: undefined; readonly outcome: ShipReconcileOutcome }

/**
 * Create the one canonical integration commit by `commit-tree` plumbing:
 * parent is the current target, tree is the final tree, and the message is
 * the fixed template (§11.2). The created commit is then independently
 * re-read and must have exactly one parent equal to the target and the exact
 * final tree — the no-merge rule — before it may be used.
 */
async function createCanonicalCommit(
  deps: ShipReconcileDeps,
  params: ShipReconcileParams,
  targetSha: GitObjectOid,
  treeOid: GitObjectOid,
): Promise<CreatedCommit> {
  const change = params.change
  const message = canonicalCommitMessage({
    ticketNumber: change.ticket.number,
    ticketIssueId: change.ticket.issueId,
    mapIssueId: params.accepted.payload.mapIssueId,
    runId: params.runId,
  })
  const created = await deps.git(
    [
      '-c',
      `user.name=${CANONICAL_COMMIT_IDENTITY.name}`,
      '-c',
      `user.email=${CANONICAL_COMMIT_IDENTITY.email}`,
      'commit-tree',
      stripOid(treeOid),
      '-p',
      stripOid(targetSha),
      '-m',
      message,
    ],
    params.repositoryRoot,
  )
  if (!created.ok) {
    return {
      outcome: shipError('ticket', 'git-failed', `creating the canonical commit failed: ${created.message}`, [
        { operation: 'commit-tree' },
      ]),
    }
  }
  const parsedBase = parseGitObjectOid(targetSha)
  if (parsedBase === undefined) {
    return {
      outcome: shipError('ticket', 'integration-shape', 'the target OID is malformed', [
        { targetSha },
      ]),
    }
  }
  const commitOid = formatGitObjectOid(parsedBase.objectFormat, created.stdout.trim())
  if (commitOid === undefined) {
    return {
      outcome: shipError('ticket', 'git-failed', 'commit-tree produced a malformed object ID', [
        { stdout: created.stdout },
      ]),
    }
  }

  // Independent re-read: exactly one parent equal to the target, exact final tree.
  const facts = await deps.facts.commitFacts(stripOid(commitOid))
  if (facts.kind !== 'ok') {
    return {
      outcome: shipError('ticket', 'git-failed', `verifying the canonical commit failed: ${facts.reason}`, [
        ...facts.evidence,
      ]),
    }
  }
  if (facts.value === undefined) {
    return {
      outcome: shipError('ticket', 'integration-shape', 'the created canonical commit is absent', [
        { commit: commitOid },
      ]),
    }
  }
  const parents = facts.value.parents.map((parent) => normalizeOid(parsedBase.objectFormat, parent))
  const parentTree = normalizeOid(parsedBase.objectFormat, facts.value.treeOid)
  if (parents.length !== 1 || parents[0] !== targetSha || parentTree !== treeOid) {
    return {
      outcome: shipError('ticket', 'integration-shape', 'the canonical commit failed the integration-shape check', [
        {
          commit: commitOid,
          expectedParent: targetSha,
          expectedTree: treeOid,
          parents: parents.map((parent) => parent ?? null),
          tree: parentTree ?? null,
        },
      ]),
    }
  }
  return { commit: commitOid }
}

/** Everything the fresh gates bind, beyond the integration itself. */
type FreshGateContext = {
  readonly integration: Integration
  readonly latestRevision: string
}

type FreshGateResult =
  | {
      readonly kind: 'ok'
      readonly tests: readonly TestEvidence[]
      readonly review: ReviewEvidence
    }
  | { readonly kind: 'error'; readonly outcome: ShipReconcileOutcome }

/**
 * §11.2 steps 2–5 against an advanced target: seat the sealed attempt
 * workspace at the final tree, run setup and the complete test list with the
 * §10.2 protocol-valid checks, verify, run one fresh independent read-only
 * reviewer bound to the new base, the complete final tree, and the ordered
 * ship test evidence, and verify once more. The reviewer's specification
 * carries the latest accepted `mapRevision` — a Compatible Map Extension
 * adopted before this Ship advances the final review's binding (§11.2).
 */
async function runFreshGates(
  deps: ShipReconcileDeps,
  params: ShipReconcileParams,
  ticketWorkspace: TicketWorkspaceRef,
  snapshot: TaskMapSnapshot,
  ticket: TaskMapSnapshot['tickets'][number],
  target: TargetRead,
  context: FreshGateContext,
): Promise<FreshGateResult> {
  const change = params.change
  const workspacePath = ticketWorkspace.path
  const integration = context.integration

  // --- seat the workspace at the final tree ---------------------------------

  const sealed = await inspectWorkspace(deps.git, workspacePath)
  if (sealed.status !== 'ok') {
    return gateError('git-failed', { failure: sealed.message, operation: 'inspect-workspace' })
  }
  const branchRef = `refs/heads/${ticketWorkspace.branch}`
  if (
    sealed.state.symbolicHead !== branchRef ||
    sealed.state.head !== change.candidateCommit ||
    sealed.state.status.length !== 0
  ) {
    return gateError('workspace-verification-failed', {
      expectedSymbolicHead: branchRef,
      expectedHead: change.candidateCommit,
      actual: {
        symbolicHead: sealed.state.symbolicHead,
        head: sealed.state.head,
        status: sealed.state.status,
      },
    })
  }
  const checkout = await deps.git(
    ['checkout', '--detach', '--quiet', stripOid(integration.gateHead)],
    workspacePath,
  )
  if (!checkout.ok) {
    return gateError('git-failed', { operation: 'checkout', failure: checkout.message })
  }
  const seated = await verifyGateWorkspace(deps, workspacePath, integration.gateHead, integration.treeOid)
  if (seated !== undefined) return { kind: 'error', outcome: seated }

  // --- §11.2 step 2: setup, then the complete test list ----------------------

  const gateDeps: GateDeps = { runner: deps.commands, git: deps.git }
  const gateWorkspace = {
    path: workspacePath,
    expectedHead: integration.gateHead,
    expectedTreeOid: integration.treeOid,
  }
  const setup = await runGateCommandList(gateDeps, {
    commands: params.setup,
    workspace: gateWorkspace,
    scope: 'ticket',
  })
  if (setup.kind !== 'ok') return { kind: 'error', outcome: setup }
  const setupFailure = firstNonPass(setup.value)
  if (setupFailure !== undefined) {
    return { kind: 'error', outcome: shipGateFailed('setup', setupFailure.index, setupFailure.result) }
  }
  const tests = await runGateCommandList(gateDeps, {
    commands: params.tests,
    workspace: gateWorkspace,
    scope: 'ticket',
  })
  if (tests.kind !== 'ok') return { kind: 'error', outcome: tests }
  const testFailure = firstNonPass(tests.value)
  if (testFailure !== undefined) {
    return { kind: 'error', outcome: shipGateFailed('tests', testFailure.index, testFailure.result) }
  }

  // --- §11.2 step 3: verify the commit, tree, and cleanliness again ---------

  const verified = await verifyGateWorkspace(deps, workspacePath, integration.gateHead, integration.treeOid)
  if (verified !== undefined) return { kind: 'error', outcome: verified }

  // --- §11.2 step 4: one fresh independent read-only reviewer ---------------

  const diff = await coordinatorDiff(deps.git, workspacePath, integration.baseSha, integration.gateHead)
  if (diff === undefined) {
    return gateError('git-failed', {
      operation: 'diff',
      baseSha: integration.baseSha,
      head: integration.gateHead,
    })
  }
  const shipTests = buildShipTests(tests.value, integration.baseSha, integration.treeOid)
  const reviewerInput: ReviewerLaunchInput = {
    spec: {
      mapTitle: snapshot.title,
      mapBody: snapshot.body,
      mapRevision: context.latestRevision,
      ticketTitle: ticket.title,
      ticketBody: ticket.body,
      ticketRevision: change.ticketRevision,
    },
    target: {
      branch: params.targetBranch,
      baseSha: integration.baseSha,
      baseTreeOid: target.treeOid,
    },
    candidate: {
      commit: integration.gateHead,
      treeOid: integration.treeOid,
      zeroDelta: integration.zeroDelta,
    },
    diff,
    tests: shipTests,
    testOutput: reviewerTestOutput(tests.value),
  }
  const plan = deps.planReviewer(reviewerInput)
  const planIsReadOnly =
    deps.reviewerPlanIsReadOnly ?? ((candidate: AgentLaunchPlan) => isReadOnlyAgentArgv(candidate.argv))
  if (!planIsReadOnly(plan)) {
    return gateError('reviewer-not-read-only', { argv: plan.argv })
  }

  const invocationId = deps.newInvocationId()
  const agentContext: AgentCompletionContext = {
    schema: AGENT_COMPLETION_SCHEMA,
    invocationId,
    runId: params.runId,
    role: 'reviewer',
    phase: 'ship',
    map: {
      githubHost: snapshot.ref.githubHost,
      repositoryId: snapshot.ref.repositoryId,
      issueId: snapshot.ref.issueId,
    },
    ticket: {
      githubHost: change.ticket.githubHost,
      repositoryId: change.ticket.repositoryId,
      issueId: change.ticket.issueId,
      number: change.ticket.number,
    },
    workspace: { kind: 'ticket', path: workspacePath },
    piSessionId: `${invocationId}-pi`,
    completionsDir: params.completionsDir,
  }
  const settlement = await runAgentInvocation(deps.runner, {
    context: agentContext,
    argv: plan.argv,
    cwd: workspacePath,
    env: { ...(plan.env ?? {}), [NORN_AGENT_CONTEXT_ENV]: canonicalJson(agentContext as CanonicalJsonValue) },
    timeoutMs: params.reviewer.timeoutMs,
    scope: 'ticket',
  })
  if (settlement.kind !== 'ok') return { kind: 'error', outcome: settlement }
  const verdict = settlement.value.completion as ReviewerCompletion
  if (verdict.discriminant !== 'pass') {
    return {
      kind: 'error',
      outcome: shipGateFailed('review', null, {
        verdict: verdict.discriminant,
        ...(verdict.discriminant === 'iterate' ? { feedback: verdict.feedback } : {}),
        ...(verdict.discriminant === 'block' ? { code: verdict.code, reason: verdict.reason } : {}),
      }),
    }
  }

  // --- §11.2 step 5: verify the commit, tree, and cleanliness once more -----

  const reverified = await verifyGateWorkspace(deps, workspacePath, integration.gateHead, integration.treeOid)
  if (reverified !== undefined) return { kind: 'error', outcome: reverified }

  const review: ReviewEvidence = {
    phase: 'ship',
    provider: modelProvider(params.reviewer.model),
    model: params.reviewer.model,
    family: params.reviewer.family,
    thinking: params.reviewer.thinking,
    verdict: 'pass',
    mapRevision: context.latestRevision,
    ticketRevision: change.ticketRevision,
    baseSha: integration.baseSha,
    treeOid: integration.treeOid,
    testEvidenceDigest: canonicalJsonDigest(shipTests as CanonicalJsonValue),
  }
  return { kind: 'ok', tests: shipTests, review }

  function gateError(code: ShipReconcileErrorCode, detail: Evidence): FreshGateResult {
    return {
      kind: 'error',
      outcome: shipError('ticket', code, `the reconciled candidate failed its gates: ${code}`, [detail]),
    }
  }

  function shipGateFailed(
    gate: 'setup' | 'tests' | 'review',
    index: number | null,
    detail: CanonicalJsonValue,
  ): ShipReconcileOutcome {
    return blocked({
      scope: 'ticket',
      code: 'ship-gate-failed',
      reason:
        `the ${gate} gate of the reconciled candidate for ticket #${change.ticket.number} did not pass`,
      sharedWrite: 'none',
      evidence: [{ gate, ...(index === null ? {} : { index }), detail }],
    })
  }
}

/** One ordered ship `TestEvidence` entry per passing configured test (§10.3). */
function buildShipTests(
  list: GateCommandListValue,
  baseSha: GitObjectOid,
  treeOid: GitObjectOid,
): TestEvidence[] {
  return list.entries.map((entry) => {
    if (entry.result.status !== 'pass') {
      throw new Error('ship test evidence may only be built from a complete passing list')
    }
    return {
      phase: 'ship' as const,
      testIndex: entry.index,
      argv: [...entry.command.argv],
      timeoutMs: entry.command.timeoutMs,
      baseSha,
      treeOid,
      exitCode: 0 as const,
      outputDigest: entry.result.outputDigest,
    }
  })
}

/** The captured output of every passing ship test, for the reviewer (§10.2). */
function reviewerTestOutput(list: GateCommandListValue): ReviewerLaunchInput['testOutput'] {
  return list.entries.map((entry) => {
    if (entry.result.status !== 'pass') {
      throw new Error('reviewer output may only be built from a complete passing list')
    }
    return {
      testIndex: entry.index,
      argv: [...entry.command.argv],
      stdout: Buffer.from(entry.result.stdout).toString('utf8'),
      stderr: Buffer.from(entry.result.stderr).toString('utf8'),
      outputDigest: entry.result.outputDigest,
    }
  })
}

/** The first non-pass of a stopped command list, when the list stopped early. */
function firstNonPass(
  list: GateCommandListValue,
): { readonly index: number; readonly result: { readonly cause: string; readonly exitCode: number | null } } | undefined {
  if (list.stoppedAtIndex === null) return undefined
  const entry = list.entries[list.stoppedAtIndex]
  if (entry === undefined || entry.result.status === 'pass') return undefined
  return { index: entry.index, result: { cause: entry.result.cause, exitCode: entry.result.exitCode } }
}

/**
 * The §11.2 workspace verification: HEAD, tree OID, and cleanliness at the
 * expected commit. Returns the error outcome when a check fails.
 */
async function verifyGateWorkspace(
  deps: ShipReconcileDeps,
  path: string,
  expectedHead: GitObjectOid,
  expectedTreeOid: GitObjectOid,
): Promise<ShipReconcileOutcome | undefined> {
  const inspection = await inspectWorkspace(deps.git, path)
  if (inspection.status !== 'ok') {
    return shipError('ticket', 'workspace-inspection-failed', inspection.message, [])
  }
  const state = inspection.state
  if (state.head !== expectedHead || state.headTree !== expectedTreeOid || state.status.length !== 0) {
    return shipError('ticket', 'workspace-verification-failed', 'the gate workspace changed unexpectedly', [
      {
        expectedHead,
        expectedTreeOid,
        actual: { head: state.head, headTree: state.headTree, status: state.status },
      },
    ])
  }
  return undefined
}

/** The coordinator-generated base-to-final diff; `undefined` on git failure. */
async function coordinatorDiff(
  git: GitCommandRunner,
  path: string,
  base: GitObjectOid,
  head: GitObjectOid,
): Promise<string | undefined> {
  const result = await git(['diff', '--no-color', stripOid(base), stripOid(head)], path)
  return result.ok ? result.stdout : undefined
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function finalizeCandidate(
  change: ShippableChange,
  integration: Integration,
  tests: readonly TestEvidence[],
  review: ReviewEvidence,
  adoptedExtension: FinalCandidate['adoptedExtension'],
): FinalCandidate {
  return {
    ticket: change.ticket,
    zeroDelta: integration.zeroDelta,
    baseSha: integration.baseSha,
    integratedSha: integration.integratedSha,
    treeOid: integration.treeOid,
    integrationCommit: integration.integrationCommit,
    mapRevision: review.mapRevision,
    ticketRevision: review.ticketRevision,
    tests,
    review,
    ...(adoptedExtension === undefined ? {} : { adoptedExtension }),
  }
}

/** The run-scoped `blocked(changed-input)` of §11.1, before any push. */
function changedInput(params: ShipReconcileParams, evidence: readonly Evidence[]): ShipReconcileOutcome {
  return blocked({
    scope: 'run',
    code: 'changed-input',
    reason:
      'the trustworthy facts the Ship of this Ticket depends on changed; no push occurred ' +
      '(design.md §11.1)',
    sharedWrite: params.alreadyShipped ? 'confirmed' : 'none',
    evidence: [...evidence],
  })
}

function shipError(
  scope: 'ticket' | 'run',
  code: ShipReconcileErrorCode,
  reason: string,
  evidence: readonly Evidence[],
): ShipReconcileOutcome {
  return error({ scope, code, reason, sharedWrite: 'none', evidence: [...evidence] })
}

/** Strip an object OID to raw hex; identity when already raw. */
function stripOid(oid: GitObjectOid): string {
  const parsed = parseGitObjectOid(oid)
  return parsed === undefined ? oid : parsed.hex
}

/** Normalize a facts-seam value (raw hex or formatted OID) to a formatted OID. */
function normalizeOid(format: GitObjectFormat, value: string): GitObjectOid | undefined {
  if (GIT_OBJECT_OID_PATTERN.test(value)) return value
  return formatGitObjectOid(format, value)
}
