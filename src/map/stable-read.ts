/**
 * The stable-read protocol (design.md §7.3): GitHub offers no transactional
 * read across the map issue, its sub-issues, and its dependency edges, so a
 * snapshot is accepted only when two adjacent complete loads agree.
 *
 * Norn performs at most three complete normalized loads. Two adjacent loads
 * that produce the same `mapRevision` and the same map and Ticket states
 * accept the later snapshot's value. A structurally invalid load is subject
 * to the same protocol: two adjacent loads reporting the same complete set of
 * topology findings accept that finding set, because a map torn mid-edit must
 * not be reported on the strength of one read. Loader failures are errors; a
 * loader-reported trustworthy fact (for example `repository-not-found`) is
 * returned immediately; no adjacent agreement after three loads is
 * `blocked(changed-input)`.
 */
import { blocked, error, ok } from '../core/outcome.ts'
import type { Outcome } from '../core/outcome.ts'
import { canonicalJson } from '../core/canonical-json.ts'
import { evaluateTaskMapLoad } from './snapshot.ts'
import { snapshotStableState } from './snapshot.ts'
import type { TaskMapSnapshot, TopologyFinding } from './snapshot.ts'
import type { TaskMapLoadBlockCode, TaskMapLoadErrorCode, TaskMapLoadOutcome } from './loader.ts'

export type StableReadBlockCode = TaskMapLoadBlockCode | 'invalid-map' | 'changed-input'
export type StableReadErrorCode = TaskMapLoadErrorCode

export type StableSnapshotOutcome = Outcome<TaskMapSnapshot, StableReadBlockCode, StableReadErrorCode>

/** The maximum number of complete loads the protocol may perform. */
export const STABLE_READ_MAX_LOADS = 3

/** One evaluated load: either a computed snapshot or its topology findings. */
type EvaluatedLoad =
  | { readonly kind: 'snapshot'; readonly snapshot: TaskMapSnapshot }
  | { readonly kind: 'findings'; readonly findings: readonly TopologyFinding[] }

/** The agreement key of one evaluated load (§7.3: revision plus states). */
function agreementKey(load: EvaluatedLoad): string {
  return load.kind === 'snapshot'
    ? canonicalJson({ snapshot: snapshotStableState(load.snapshot) })
    : canonicalJson({ findings: load.findings })
}

/** Serializable summary of one evaluated load, for divergence evidence. */
function describeLoad(load: EvaluatedLoad): { kind: 'snapshot'; mapRevision: string; mapState: string } | { kind: 'findings'; codes: readonly string[] } {
  return load.kind === 'snapshot'
    ? {
        kind: 'snapshot',
        mapRevision: load.snapshot.mapRevision,
        mapState: load.snapshot.state,
      }
    : { kind: 'findings', codes: load.findings.map((finding) => finding.code) }
}

function accept(load: EvaluatedLoad): StableSnapshotOutcome {
  if (load.kind === 'snapshot') return ok(load.snapshot)
  return blocked({
    scope: 'operation',
    code: 'invalid-map',
    reason: `the Task Map violates ${load.findings.length} topology rule(s): ${load.findings
      .map((finding) => finding.code)
      .join(', ')}`,
    sharedWrite: 'none',
    evidence: [{ findings: load.findings }],
  })
}

/**
 * Run the stable-read protocol over `load`. `load` is called at most
 * `STABLE_READ_MAX_LOADS` times and must return one complete load per call.
 * The outcome is the accepted snapshot (`ok`), a trustworthy non-success
 * (`blocked`), or an infrastructure `error`.
 */
export async function stableReadTaskMap(
  load: () => Promise<TaskMapLoadOutcome>,
): Promise<StableSnapshotOutcome> {
  const evaluated: EvaluatedLoad[] = []
  for (let attempt = 1; attempt <= STABLE_READ_MAX_LOADS; attempt++) {
    const outcome = await load()
    if (outcome.kind === 'error') {
      return error({ scope: 'operation', code: outcome.code, reason: outcome.reason })
    }
    if (outcome.kind === 'blocked') {
      return blocked({
        scope: 'operation',
        code: outcome.code,
        reason: outcome.reason,
        sharedWrite: outcome.sharedWrite,
        evidence: outcome.evidence,
      })
    }
    const evaluation = evaluateTaskMapLoad(outcome.value)
    evaluated.push(
      evaluation.valid
        ? { kind: 'snapshot', snapshot: evaluation.snapshot }
        : { kind: 'findings', findings: evaluation.findings },
    )
    if (attempt >= 2) {
      const previous = evaluated[attempt - 2]!
      const current = evaluated[attempt - 1]!
      if (agreementKey(previous) === agreementKey(current)) return accept(current)
    }
  }
  return blocked({
    scope: 'operation',
    code: 'changed-input',
    reason:
      'no two adjacent loads of the Task Map agreed; the map kept changing while it was being read',
    sharedWrite: 'none',
    evidence: [{ observedLoads: evaluated.map(describeLoad) }],
  })
}
