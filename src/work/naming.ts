/**
 * Run-qualified branch and workspace names (design.md §10.1).
 *
 * Every Work attempt owns exactly one branch and one workspace, qualified by
 * the run ID, the ticket number, and the work-attempt ID, so a later run — or
 * an aborted attempt — can never collide with or silently reuse them:
 *
 * ```text
 * branch:    norn/<run-id>/<ticket-number>/<work-attempt-id>
 * workspace: <repository-home>/runs/<run-id>/workspaces/<ticket-number>/<work-attempt-id>
 * ```
 *
 * Map-completion workspaces carry the completion-attempt ID instead, under
 * `workspaces/map/`, and are checked out at the exact completion commit
 * without owning a branch (design.md §15).
 *
 * Pure path and ref construction: no I/O. Each constructor returns
 * `undefined` when a component would produce an unsafe name — the caller
 * turns that into a typed error before touching git.
 */
import { join } from 'node:path'

/** The one branch namespace Norn owns inside the target repository. */
export const WORK_BRANCH_PREFIX = 'norn'

/**
 * Shape every run, attempt, and invocation identifier must have to become a
 * single git ref component or directory name: tame lowercase alphanumerics
 * and dashes, no leading dash (option confusion), no slashes, no `..`, no
 * `.lock` suffix, bounded length.
 */
export const RUN_QUALIFIED_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/

export function isRunQualifiedName(value: unknown): value is string {
  return typeof value === 'string' && RUN_QUALIFIED_NAME_PATTERN.test(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * The attempt-owned branch created exactly at the Wave base (design.md
 * §10.1): `norn/<run-id>/<ticket-number>/<work-attempt-id>`.
 */
export function ticketBranch(
  runId: string,
  ticketNumber: number,
  workAttemptId: string,
): string | undefined {
  if (!isRunQualifiedName(runId) || !isPositiveInteger(ticketNumber)) return undefined
  if (!isRunQualifiedName(workAttemptId)) return undefined
  return `${WORK_BRANCH_PREFIX}/${runId}/${ticketNumber}/${workAttemptId}`
}

/**
 * The run-owned workspace directory under repository home (design.md §2.2,
 * §10.1): `<repository-home>/runs/<run-id>/workspaces/<ticket-number>/<work-attempt-id>`.
 * Norn creates nothing but attempt-local data here; Run State never lives in
 * a workspace.
 */
export function ticketWorkspaceDir(
  repositoryHome: string,
  runId: string,
  ticketNumber: number,
  workAttemptId: string,
): string | undefined {
  if (!isRunQualifiedName(runId) || !isPositiveInteger(ticketNumber)) return undefined
  if (!isRunQualifiedName(workAttemptId)) return undefined
  return join(repositoryHome, 'runs', runId, 'workspaces', String(ticketNumber), workAttemptId)
}

/**
 * The run-owned map-completion workspace directory (design.md §15):
 * `<repository-home>/runs/<run-id>/workspaces/map/<completion-attempt-id>`.
 */
export function mapCompletionWorkspaceDir(
  repositoryHome: string,
  runId: string,
  completionAttemptId: string,
): string | undefined {
  if (!isRunQualifiedName(runId) || !isRunQualifiedName(completionAttemptId)) return undefined
  return join(repositoryHome, 'runs', runId, 'workspaces', 'map', completionAttemptId)
}
