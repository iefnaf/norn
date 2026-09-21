/**
 * Work workspaces and branches (design.md §10.1, §15).
 *
 * The physical substrate for Work: run-qualified ticket branches and
 * workspaces — and run-owned map-completion workspaces — created under
 * repository home at the exact Wave base. Before a workspace is used, Norn
 * verifies that the base commit resolves to the captured tree OID, that the
 * repository's object format matches the captured OIDs, and after creation
 * that the workspace belongs to the expected repository (the shared common
 * Git directory), keeps that object format, and sits exactly at the base
 * commit and tree.
 *
 * Git operations sit behind the injectable `GitCommandRunner` seam already
 * used by the repository adapter: the built-in runner shells out to the `git`
 * CLI, while tests inject canned results or use temporary repositories.
 *
 * The same seam powers workspace inspection: the protocol-valid command
 * checks of design.md §10.2 read HEAD, the HEAD tree, and `git status
 * --porcelain` — which never lists ignored dependency and cache directories,
 * so such residue may remain without ever counting as evidence.
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import type { GitCommandResult, GitCommandRunner } from '../adapters/git-repository.ts'
import type { GitObjectOid } from '../agents/completion.ts'
import { error, ok } from '../core/outcome.ts'
import type { Evidence, Outcome, OutcomeScope } from '../core/outcome.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'
import type { WorkspaceRef } from '../runstate/types.ts'

import {
  mapCompletionWorkspaceDir,
  ticketBranch,
  ticketWorkspaceDir,
} from './naming.ts'

/** Object formats a Git repository can hash with (design.md §10.3). */
export type GitObjectFormat = 'sha1' | 'sha256'

export type ParsedGitObjectOid = {
  readonly objectFormat: GitObjectFormat
  readonly hex: string
}

/** Split a stored OID such as `sha1:<hex>` into its format and raw hex. */
export function parseGitObjectOid(oid: string): ParsedGitObjectOid | undefined {
  const match = /^(sha1|sha256):([0-9a-f]+)$/.exec(oid)
  if (match === null) return undefined
  const objectFormat = match[1] as GitObjectFormat
  const hex = match[2]!
  return hex.length === (objectFormat === 'sha1' ? 40 : 64)
    ? { objectFormat, hex }
    : undefined
}

/** Render raw hex in the stored OID presentation, or `undefined` if malformed. */
export function formatGitObjectOid(objectFormat: GitObjectFormat, hex: string): GitObjectOid | undefined {
  if (!/^[0-9a-f]+$/.test(hex)) return undefined
  if (hex.length !== (objectFormat === 'sha1' ? 40 : 64)) return undefined
  return `${objectFormat}:${hex}`
}

/** The complete machine-readable state of one workspace (design.md §10.2). */
export type WorkspaceState = {
  /** `HEAD` commit. */
  readonly head: GitObjectOid
  /** Tree OID of the `HEAD` commit. */
  readonly headTree: GitObjectOid
  /** The branch `HEAD` points at, or `null` when detached. */
  readonly symbolicHead: string | null
  readonly objectFormat: GitObjectFormat
  /** Absolute common Git directory: the workspace's repository identity. */
  readonly commonDir: string
  /**
   * `git status --porcelain` lines. Empty exactly when there are no staged
   * or unstaged tracked changes and no non-ignored untracked files; ignored
   * dependency and cache directories never appear here.
   */
  readonly status: readonly string[]
}

export type WorkspaceInspection =
  | { readonly status: 'ok'; readonly state: WorkspaceState }
  | { readonly status: 'git-failed'; readonly message: string }

/**
 * Read the complete workspace state through the git seam. Every field is
 * read independently of any process that ran in the workspace.
 */
export async function inspectWorkspace(
  run: GitCommandRunner,
  path: string,
): Promise<WorkspaceInspection> {
  const objectFormat = await readObjectFormat(run, path)
  if (objectFormat.status !== 'ok') return objectFormat

  const head = await revParse(run, path, 'HEAD')
  if (head.status !== 'ok') return head
  const headTree = await revParse(run, path, 'HEAD^{tree}')
  if (headTree.status !== 'ok') return headTree

  const symbolic = await revParse(run, path, '--symbolic-full-name', 'HEAD')
  if (symbolic.status !== 'ok') return symbolic
  // Git prints the literal `HEAD` when detached instead of a symbolic ref.
  const symbolicHead = symbolic.value === 'HEAD' ? null : symbolic.value

  const common = await run(['rev-parse', '--git-common-dir'], path)
  if (!common.ok) return { status: 'git-failed', message: `git-common-dir: ${common.message}` }

  const status = await run(['status', '--porcelain'], path)
  if (!status.ok) return { status: 'git-failed', message: `status: ${status.message}` }

  const headOid = formatGitObjectOid(objectFormat.value, head.value)
  const headTreeOid = formatGitObjectOid(objectFormat.value, headTree.value)
  if (headOid === undefined || headTreeOid === undefined) {
    return { status: 'git-failed', message: 'git produced a malformed object ID' }
  }

  return {
    status: 'ok',
    state: {
      head: headOid,
      headTree: headTreeOid,
      symbolicHead,
      objectFormat: objectFormat.value,
      commonDir: normalizeDirectory(common.stdout.trim(), path),
      status: splitPorcelain(status.stdout),
    },
  }
}

async function readObjectFormat(
  run: GitCommandRunner,
  path: string,
): Promise<{ readonly status: 'ok'; readonly value: GitObjectFormat } | { readonly status: 'git-failed'; readonly message: string }> {
  const result = await run(['rev-parse', '--show-object-format'], path)
  if (!result.ok) {
    return { status: 'git-failed', message: `show-object-format: ${result.message}` }
  }
  const value = result.stdout.trim()
  if (value !== 'sha1' && value !== 'sha256') {
    return { status: 'git-failed', message: `unknown object format "${value}"` }
  }
  return { status: 'ok', value }
}

async function revParse(
  run: GitCommandRunner,
  path: string,
  ...what: readonly string[]
): Promise<{ readonly status: 'ok'; readonly value: string } | { readonly status: 'git-failed'; readonly message: string }> {
  const result = await run(['rev-parse', ...what], path)
  if (!result.ok) return { status: 'git-failed', message: `rev-parse ${what.join(' ')}: ${result.message}` }
  const value = result.stdout.trim()
  if (value === '') {
    return { status: 'git-failed', message: `rev-parse ${what.join(' ')} produced no output` }
  }
  return { status: 'ok', value }
}

function splitPorcelain(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line !== '')
}

/** Resolve to a canonical absolute directory; tolerate paths that do not exist. */
function normalizeDirectory(path: string, cwd: string): string {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/** Closed error codes for workspace creation and verification. */
export type WorkspaceErrorCode =
  | 'invalid-workspace-name'
  | 'git-failed'
  | 'object-format-mismatch'
  | 'base-tree-mismatch'
  | 'workspace-verification-failed'

export type WorkspaceOutcome = Outcome<WorkspaceRef, never, WorkspaceErrorCode>

/** The dependencies every workspace operation runs through. */
export type WorkspaceDeps = {
  /** The injectable git seam; the built-in runner shells out to `git`. */
  readonly git: GitCommandRunner
}

/** Everything needed to create one attempt-owned ticket workspace. */
export type CreateTicketWorkspaceParams = {
  /** Root of the target repository the operator invoked Norn in. */
  readonly repositoryRoot: string
  /** Repository home under Norn home (design.md §2.2). */
  readonly repositoryHome: string
  /** Stable GitHub repository ID keying the repository home. */
  readonly repositoryId: string
  readonly runId: string
  readonly ticketNumber: number
  readonly workAttemptId: string
  /** The exact Wave base captured for the attempt (design.md §10.1). */
  readonly base: {
    readonly sha: GitObjectOid
    readonly treeOid: GitObjectOid
  }
}

/**
 * Create the attempt-owned branch and workspace exactly at the Wave base
 * (design.md §10.1) and verify them before the workspace is used:
 * the base commit resolves to the captured tree OID, the repository's
 * object format matches the captured OIDs, and the created workspace
 * belongs to the expected repository, keeps that object format, sits on the
 * attempt-owned branch, and is exactly at the base commit and tree.
 */
export async function createTicketWorkspace(
  deps: WorkspaceDeps,
  params: CreateTicketWorkspaceParams,
  scope: OutcomeScope = 'ticket',
): Promise<WorkspaceOutcome> {
  const branch = ticketBranch(params.runId, params.ticketNumber, params.workAttemptId)
  const path = ticketWorkspaceDir(
    params.repositoryHome,
    params.runId,
    params.ticketNumber,
    params.workAttemptId,
  )
  if (branch === undefined || path === undefined) {
    return workspaceError(scope, 'invalid-workspace-name', [
      { runId: params.runId, ticketNumber: params.ticketNumber, workAttemptId: params.workAttemptId },
    ])
  }

  const prepared = await prepareBase(deps, params.repositoryRoot, params.base)
  if (prepared.kind !== 'ok') return workspaceError(scope, prepared.code, prepared.evidence)

  const created = await runWrite(deps.git, params.repositoryRoot, [
    'branch',
    branch,
    prepared.hex,
  ])
  if (created !== undefined) return workspaceError(scope, 'git-failed', [{ operation: 'branch', failure: created }])

  const worktree = await runWrite(deps.git, params.repositoryRoot, [
    'worktree',
    'add',
    '--checkout',
    path,
    branch,
  ])
  if (worktree !== undefined) {
    return workspaceError(scope, 'git-failed', [{ operation: 'worktree-add', failure: worktree }])
  }

  const verified = await verifyWorkspace(deps, path, {
    expectedSymbolicHead: `refs/heads/${branch}`,
    expectedHead: params.base.sha,
    expectedTreeOid: params.base.treeOid,
    expectedObjectFormat: prepared.objectFormat,
    expectedCommonDir: prepared.commonDir,
  })
  if (verified !== undefined) return workspaceError(scope, verified.code, verified.evidence)

  return ok({
    kind: 'ticket',
    repositoryId: params.repositoryId,
    runId: params.runId,
    path,
    branch,
    workAttemptId: params.workAttemptId,
  })
}

/** Everything needed to create one run-owned map-completion workspace. */
export type CreateMapCompletionWorkspaceParams = {
  readonly repositoryRoot: string
  readonly repositoryHome: string
  readonly repositoryId: string
  readonly runId: string
  readonly completionAttemptId: string
  /** The remote target commit read for the completion attempt (§15). */
  readonly completion: {
    readonly sha: GitObjectOid
    readonly treeOid: GitObjectOid
  }
}

/**
 * Create the run-owned map-completion workspace checked out exactly at the
 * completion commit (design.md §15): no attempt-owned branch, a detached
 * worktree under `workspaces/map/`, verified against the captured tree OID,
 * repository identity, object format, and cleanliness before use.
 */
export async function createMapCompletionWorkspace(
  deps: WorkspaceDeps,
  params: CreateMapCompletionWorkspaceParams,
  scope: OutcomeScope = 'operation',
): Promise<WorkspaceOutcome> {
  const path = mapCompletionWorkspaceDir(
    params.repositoryHome,
    params.runId,
    params.completionAttemptId,
  )
  if (path === undefined) {
    return workspaceError(scope, 'invalid-workspace-name', [
      {
        runId: params.runId,
        completionAttemptId: params.completionAttemptId,
      },
    ])
  }

  const prepared = await prepareBase(deps, params.repositoryRoot, params.completion)
  if (prepared.kind !== 'ok') return workspaceError(scope, prepared.code, prepared.evidence)

  const worktree = await runWrite(deps.git, params.repositoryRoot, [
    'worktree',
    'add',
    '--detach',
    path,
    prepared.hex,
  ])
  if (worktree !== undefined) {
    return workspaceError(scope, 'git-failed', [{ operation: 'worktree-add', failure: worktree }])
  }

  const verified = await verifyWorkspace(deps, path, {
    expectedSymbolicHead: null,
    expectedHead: params.completion.sha,
    expectedTreeOid: params.completion.treeOid,
    expectedObjectFormat: prepared.objectFormat,
    expectedCommonDir: prepared.commonDir,
  })
  if (verified !== undefined) return workspaceError(scope, verified.code, verified.evidence)

  return ok({
    kind: 'map-completion',
    repositoryId: params.repositoryId,
    runId: params.runId,
    path,
    completionAttemptId: params.completionAttemptId,
  })
}

type PreparedBase =
  | {
      readonly kind: 'ok'
      readonly hex: string
      readonly objectFormat: GitObjectFormat
      readonly commonDir: string
    }
  | { readonly kind: 'error'; readonly code: WorkspaceErrorCode; readonly evidence: Evidence[] }

/**
 * Resolve the base commit against the captured tree OID and repository
 * facts before anything is created (design.md §10.1): the commit must
 * resolve to exactly `treeOid`, and the repository's object format must
 * match the format of every captured OID.
 */
async function prepareBase(
  deps: WorkspaceDeps,
  repositoryRoot: string,
  base: { readonly sha: GitObjectOid; readonly treeOid: GitObjectOid },
): Promise<PreparedBase> {
  const parsedSha = parseGitObjectOid(base.sha)
  const parsedTree = parseGitObjectOid(base.treeOid)
  if (parsedSha === undefined || parsedTree === undefined) {
    return {
      kind: 'error',
      code: 'object-format-mismatch',
      evidence: [{ baseSha: base.sha, baseTreeOid: base.treeOid, problem: 'malformed object ID' }],
    }
  }

  const objectFormat = await readObjectFormat(deps.git, repositoryRoot)
  if (objectFormat.status !== 'ok') {
    return { kind: 'error', code: 'git-failed', evidence: [{ failure: objectFormat.message }] }
  }
  if (
    objectFormat.value !== parsedSha.objectFormat ||
    objectFormat.value !== parsedTree.objectFormat
  ) {
    return {
      kind: 'error',
      code: 'object-format-mismatch',
      evidence: [
        {
          repositoryObjectFormat: objectFormat.value,
          baseShaFormat: parsedSha.objectFormat,
          baseTreeOidFormat: parsedTree.objectFormat,
        },
      ],
    }
  }

  const resolvedTree = await revParse(deps.git, repositoryRoot, `${parsedSha.hex}^{tree}`)
  if (resolvedTree.status !== 'ok') {
    return { kind: 'error', code: 'git-failed', evidence: [{ failure: resolvedTree.message }] }
  }
  const resolvedTreeOid = formatGitObjectOid(objectFormat.value, resolvedTree.value)
  if (resolvedTreeOid === undefined || resolvedTreeOid !== base.treeOid) {
    return {
      kind: 'error',
      code: 'base-tree-mismatch',
      evidence: [
        {
          baseSha: base.sha,
          expectedTreeOid: base.treeOid,
          resolvedTreeOid: resolvedTreeOid ?? resolvedTree.value,
        },
      ],
    }
  }

  const common = await deps.git(['rev-parse', '--git-common-dir'], repositoryRoot)
  if (!common.ok) {
    return { kind: 'error', code: 'git-failed', evidence: [{ failure: common.message }] }
  }

  return {
    kind: 'ok',
    hex: parsedSha.hex,
    objectFormat: objectFormat.value,
    commonDir: normalizeDirectory(common.stdout.trim(), repositoryRoot),
  }
}

type WorkspaceExpectations = {
  readonly expectedSymbolicHead: string | null
  readonly expectedHead: GitObjectOid
  readonly expectedTreeOid: GitObjectOid
  readonly expectedObjectFormat: GitObjectFormat
  readonly expectedCommonDir: string
}

/**
 * Verify a freshly created workspace against every §10.1 requirement.
 * Returns `undefined` when every expectation holds, otherwise the error code
 * to report plus canonical evidence describing the violations. A failed
 * inspection is a git failure, not a verification mismatch.
 */
async function verifyWorkspace(
  deps: WorkspaceDeps,
  path: string,
  expectations: WorkspaceExpectations,
): Promise<{ code: WorkspaceErrorCode; evidence: Evidence[] } | undefined> {
  const inspection = await inspectWorkspace(deps.git, path)
  if (inspection.status !== 'ok') {
    return {
      code: 'git-failed',
      evidence: [{ failure: inspection.message, operation: 'inspect-workspace' }],
    }
  }
  const state = inspection.state

  const violations: Record<string, CanonicalJsonValue> = {}
  if (state.symbolicHead !== expectations.expectedSymbolicHead) {
    violations.symbolicHead = {
      expected: expectations.expectedSymbolicHead,
      actual: state.symbolicHead,
    }
  }
  if (state.head !== expectations.expectedHead) {
    violations.head = { expected: expectations.expectedHead, actual: state.head }
  }
  if (state.headTree !== expectations.expectedTreeOid) {
    violations.headTree = { expected: expectations.expectedTreeOid, actual: state.headTree }
  }
  if (state.objectFormat !== expectations.expectedObjectFormat) {
    violations.objectFormat = {
      expected: expectations.expectedObjectFormat,
      actual: state.objectFormat,
    }
  }
  if (normalizeDirectory(state.commonDir, path) !== expectations.expectedCommonDir) {
    violations.commonDir = {
      expected: expectations.expectedCommonDir,
      actual: normalizeDirectory(state.commonDir, path),
    }
  }
  if (state.status.length !== 0) {
    violations.status = state.status
  }
  if (Object.keys(violations).length === 0) return undefined
  return { code: 'workspace-verification-failed', evidence: [violations] }
}

/** Run one write operation; returns the failure message or `undefined`. */
async function runWrite(
  git: GitCommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<string | undefined> {
  const result: GitCommandResult = await git(args, cwd)
  return result.ok ? undefined : result.message
}

function workspaceError(
  scope: OutcomeScope,
  code: WorkspaceErrorCode,
  evidence: Evidence[],
): WorkspaceOutcome {
  return error({
    scope,
    code,
    reason: `workspace creation failed: ${code}`,
    sharedWrite: 'none',
    evidence,
  })
}
