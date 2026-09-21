/**
 * Work workspace creation and verification through the injectable git seam
 * (design.md §10.1, ticket #7).
 *
 * Canned `GitCommandRunner` results drive the engine: creation at the exact
 * Wave base is verified against the captured tree OID, the repository's
 * object format, the workspace's repository identity, and cleanliness — and
 * every mismatch is a typed error before the workspace counts. The real
 * adapter is exercised against temporary repositories in
 * `test/work-git.test.ts`.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { GitCommandResult, GitCommandRunner } from '../src/adapters/git-repository.ts'
import { isError, isOk } from '../src/core/outcome.ts'

import {
  createMapCompletionWorkspace,
  createTicketWorkspace,
  inspectWorkspace,
} from '../src/work/workspace.ts'
import type { WorkspaceOutcome } from '../src/work/workspace.ts'

const REPOSITORY_ROOT = '/repo'
const REPOSITORY_HOME = '/norn-home/repositories/github.com/R_1'
const COMMON_DIR = '/repo/.git'

const BASE_SHA = `sha1:${'a'.repeat(40)}`
const BASE_SHA_HEX = 'a'.repeat(40)
const BASE_TREE = `sha1:${'b'.repeat(40)}`
const BASE_TREE_HEX = 'b'.repeat(40)

const RUN = { runId: 'run-1', ticketNumber: 7, workAttemptId: 'wa-1' }
const BRANCH = 'norn/run-1/7/wa-1'
const WORKSPACE_PATH = `${REPOSITORY_HOME}/runs/run-1/workspaces/7/wa-1`

function okResult(stdout = ''): GitCommandResult {
  return { ok: true, stdout }
}

function failResult(message = 'fatal: scripted failure'): GitCommandResult {
  return { ok: false, failure: 'git-failed', message }
}

type Call = { readonly args: readonly string[]; readonly cwd: string }

function recorderGit(
  handler: (args: readonly string[], cwd: string) => GitCommandResult,
): { git: GitCommandRunner; calls: Call[] } {
  const calls: Call[] = []
  const git: GitCommandRunner = async (args, cwd) => {
    calls.push({ args, cwd })
    return handler(args, cwd)
  }
  return { git, calls }
}

/**
 * The scripted success path: a sha1 repository whose base commit resolves
 * to the captured tree, creating the branch and worktree at the exact base.
 * Each override replaces one observation.
 */
function successHandler(
  overrides: Record<string, (args: readonly string[], cwd: string) => GitCommandResult> = {},
): (args: readonly string[], cwd: string) => GitCommandResult {
  return (args, cwd) => {
    const key = scriptKey(args, cwd)
    const override = overrides[key]
    if (override !== undefined) return override(args, cwd)

    if (key === 'root:format' || key === 'ws:format') return okResult('sha1\n')
    if (key === `root:tree:${BASE_SHA_HEX}^{tree}`) return okResult(`${BASE_TREE_HEX}\n`)
    if (key === 'root:common' || key === 'ws:common') return okResult(`${COMMON_DIR}\n`)
    if (key === 'root:branch') return okResult('')
    if (key === 'root:worktree') return okResult('')
    if (key === 'ws:head') return okResult(`${BASE_SHA_HEX}\n`)
    if (key === 'ws:headtree') return okResult(`${BASE_TREE_HEX}\n`)
    if (key === 'ws:symbolic') return okResult(`refs/heads/${BRANCH}\n`)
    if (key === 'ws:status') return okResult('')
    return failResult(`unscripted git call: ${args.join(' ')} @ ${cwd}`)
  }
}

function scriptKey(args: readonly string[], cwd: string): string {
  const where = cwd === REPOSITORY_ROOT ? 'root' : 'ws'
  if (args[0] === 'rev-parse') {
    if (args[1] === '--show-object-format') return `${where}:format`
    if (args[1] === '--git-common-dir') return `${where}:common`
    if (args[1] === 'HEAD') return `${where}:head`
    if (args[1] === 'HEAD^{tree}') return `${where}:headtree`
    if (args[1] === '--symbolic-full-name') return `${where}:symbolic`
    return `${where}:tree:${args[1]}`
  }
  if (args[0] === 'branch') return `${where}:branch`
  if (args[0] === 'worktree') return `${where}:worktree`
  if (args[0] === 'status') return `${where}:status`
  return `${where}:unknown`
}

function ticketParams(): Parameters<typeof createTicketWorkspace>[1] {
  return {
    repositoryRoot: REPOSITORY_ROOT,
    repositoryHome: REPOSITORY_HOME,
    repositoryId: 'R_1',
    runId: RUN.runId,
    ticketNumber: RUN.ticketNumber,
    workAttemptId: RUN.workAttemptId,
    base: { sha: BASE_SHA, treeOid: BASE_TREE },
  }
}

function createTicket(git: GitCommandRunner, scope?: 'ticket' | 'run'): Promise<WorkspaceOutcome> {
  return createTicketWorkspace({ git }, ticketParams(), scope)
}

function errorCodes(outcome: WorkspaceOutcome): string[] {
  return outcome.kind === 'error' ? outcome.evidence.map((entry) => JSON.stringify(entry)) : []
}

describe('createTicketWorkspace on the success path', () => {
  it('creates the run-qualified branch and worktree at the exact base', async () => {
    const { git, calls } = recorderGit(successHandler())
    const outcome = await createTicket(git)
    assert.ok(isOk(outcome))
    if (outcome.kind !== 'ok') return
    assert.deepEqual(outcome.value, {
      kind: 'ticket',
      repositoryId: 'R_1',
      runId: 'run-1',
      path: WORKSPACE_PATH,
      branch: BRANCH,
      workAttemptId: 'wa-1',
    })

    const branchCall = calls.find((call) => call.args[0] === 'branch')
    assert.deepEqual(branchCall?.args, ['branch', BRANCH, BASE_SHA_HEX])
    const worktreeCall = calls.find((call) => call.args[0] === 'worktree')
    assert.deepEqual(worktreeCall?.args, [
      'worktree',
      'add',
      '--checkout',
      WORKSPACE_PATH,
      BRANCH,
    ])
    // The base commit was resolved against the captured tree before
    // anything was created.
    assert.ok(calls.findIndex((c) => c.args[0] === 'branch') > calls.findIndex((c) => c.args[1] === `${BASE_SHA_HEX}^{tree}`))
  })

  it('reads every workspace fact from the workspace itself', async () => {
    const { git, calls } = recorderGit(successHandler())
    await createTicket(git)
    for (const args of [
      ['rev-parse', 'HEAD'],
      ['rev-parse', 'HEAD^{tree}'],
      ['rev-parse', '--symbolic-full-name', 'HEAD'],
      ['status', '--porcelain'],
      ['rev-parse', '--show-object-format'],
    ] as const) {
      assert.ok(
        calls.some((call) => call.cwd === WORKSPACE_PATH && call.args.join(' ') === args.join(' ')),
        `expected ${args.join(' ')} read in the workspace`,
      )
    }
  })

  it('is ticket-scoped by default and honors the enclosing scope', async () => {
    const ticket = await createTicket(recorderGit(successHandler()).git)
    assert.ok(isOk(ticket))

    const failing = recorderGit(successHandler({ 'root:branch': () => failResult() }))
    const ticketFailure = await createTicket(failing.git)
    assert.equal(ticketFailure.kind, 'error')
    assert.equal(ticketFailure.kind === 'error' ? ticketFailure.scope : '', 'ticket')

    const runFailure = await createTicket(
      recorderGit(successHandler({ 'root:branch': () => failResult() })).git,
      'run',
    )
    assert.equal(runFailure.kind === 'error' ? runFailure.scope : '', 'run')
  })
})

describe('createTicketWorkspace rejects a base that does not match the captured facts', () => {
  it('fails with base-tree-mismatch before creating anything', async () => {
    const { git, calls } = recorderGit(
      successHandler({ [`root:tree:${BASE_SHA_HEX}^{tree}`]: () => okResult(`${'c'.repeat(40)}\n`) }),
    )
    const outcome = await createTicket(git)
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'base-tree-mismatch')
    assert.match(errorCodes(outcome).join(' '), /expectedTreeOid/)
    assert.equal(calls.filter((call) => call.args[0] === 'branch' || call.args[0] === 'worktree').length, 0)
  })

  it('fails with object-format-mismatch when the repository hashes differently', async () => {
    const outcome = await createTicket(
      recorderGit(successHandler({ 'root:format': () => okResult('sha256\n') })).git,
    )
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'object-format-mismatch')
    assert.match(errorCodes(outcome).join(' '), /repositoryObjectFormat/)
  })

  it('fails with object-format-mismatch on malformed captured OIDs', async () => {
    const malformed = ticketParams()
    const outcome = await createTicketWorkspace(
      { git: recorderGit(successHandler()).git },
      { ...malformed, base: { sha: 'sha1:deadbeef', treeOid: BASE_TREE } },
    )
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'object-format-mismatch')
  })
})

describe('createTicketWorkspace verifies the created workspace before use', () => {
  async function verificationFailure(
    overrides: Parameters<typeof successHandler>[0],
  ): Promise<{ codes: string; calls: Call[] }> {
    const { git, calls } = recorderGit(successHandler(overrides))
    const outcome = await createTicket(git)
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'workspace-verification-failed')
    return { codes: errorCodes(outcome).join(' '), calls }
  }

  it('rejects a workspace whose HEAD left the exact base', async () => {
    const failure = await verificationFailure({
      'ws:head': () => okResult(`${'d'.repeat(40)}\n`),
    })
    assert.match(failure.codes, /"head":\{"expected"/)
  })

  it('rejects a workspace whose tree OID changed', async () => {
    const failure = await verificationFailure({
      'ws:headtree': () => okResult(`${'e'.repeat(40)}\n`),
    })
    assert.match(failure.codes, /headTree/)
  })

  it('rejects a workspace not on the attempt-owned branch', async () => {
    const failure = await verificationFailure({
      'ws:symbolic': () => okResult('refs/heads/other\n'),
    })
    assert.match(failure.codes, /symbolicHead/)
  })

  it('rejects a detached ticket workspace', async () => {
    const failure = await verificationFailure({
      'ws:symbolic': () => okResult('HEAD\n'),
    })
    assert.match(failure.codes, /symbolicHead/)
  })

  it('rejects a workspace with a different object format', async () => {
    const failure = await verificationFailure({
      'ws:format': () => okResult('sha256\n'),
      'ws:head': () => okResult(`${'f'.repeat(64)}\n`),
      'ws:headtree': () => okResult(`${'9'.repeat(64)}\n`),
    })
    assert.match(failure.codes, /objectFormat/)
  })

  it('rejects a workspace belonging to another repository', async () => {
    const failure = await verificationFailure({
      'ws:common': () => okResult('/elsewhere/.git\n'),
    })
    assert.match(failure.codes, /commonDir/)
  })

  it('rejects an unclean workspace', async () => {
    const failure = await verificationFailure({
      'ws:status': () => okResult('?? residue.txt\n'),
    })
    assert.match(failure.codes, /status/)
  })
})

describe('createTicketWorkspace maps git failures to typed errors', () => {
  it('reports a failed branch creation as git-failed', async () => {
    const outcome = await createTicket(
      recorderGit(successHandler({ 'root:branch': () => failResult('fatal: branch exists') })).git,
    )
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'git-failed')
    assert.match(errorCodes(outcome).join(' '), /branch/)
  })

  it('reports a failed worktree creation as git-failed', async () => {
    const outcome = await createTicket(
      recorderGit(successHandler({ 'root:worktree': () => failResult('fatal: bad path') })).git,
    )
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'git-failed')
    assert.match(errorCodes(outcome).join(' '), /worktree-add/)
  })

  it('reports a failed read as git-failed', async () => {
    const outcome = await createTicket(
      recorderGit(successHandler({ 'root:format': () => failResult() })).git,
    )
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'git-failed')
  })

  it('reports a failed workspace inspection as git-failed', async () => {
    const outcome = await createTicket(
      recorderGit(successHandler({ 'ws:status': () => failResult() })).git,
    )
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'git-failed')
  })
})

describe('createTicketWorkspace rejects unsafe names', () => {
  it('refuses to run git for unsafe components', async () => {
    const { git, calls } = recorderGit(successHandler())
    const bad = await createTicketWorkspace(
      { git },
      { ...ticketParams(), runId: '../escape' },
    )
    assert.ok(isError(bad))
    assert.equal(bad.kind === 'error' ? bad.code : '', 'invalid-workspace-name')
    assert.equal(calls.length, 0)

    const zero = await createTicketWorkspace({ git }, { ...ticketParams(), ticketNumber: 0 })
    assert.equal(zero.kind === 'error' ? zero.code : '', 'invalid-workspace-name')

    const attempt = await createTicketWorkspace({ git }, { ...ticketParams(), workAttemptId: 'WA/1' })
    assert.equal(attempt.kind === 'error' ? attempt.code : '', 'invalid-workspace-name')
    assert.equal(calls.length, 0)
  })
})

describe('createMapCompletionWorkspace', () => {
  const COMPLETION_ATTEMPT = 'mc-3'
  const COMPLETION_PATH = `${REPOSITORY_HOME}/runs/run-1/workspaces/map/mc-3`

  it('creates a detached worktree at the exact completion commit', async () => {
    const detachedHandler = (args: readonly string[], cwd: string): GitCommandResult => {
      const key = scriptKey(args, cwd)
      if (key === 'ws:symbolic') return okResult('HEAD\n')
      // The map-completion path creates no branch.
      if (args[0] === 'branch') return failResult('no branch expected')
      return successHandler()(args, cwd)
    }
    const { git, calls } = recorderGit(detachedHandler)
    const outcome = await createMapCompletionWorkspace(
      { git },
      {
        repositoryRoot: REPOSITORY_ROOT,
        repositoryHome: REPOSITORY_HOME,
        repositoryId: 'R_1',
        runId: 'run-1',
        completionAttemptId: COMPLETION_ATTEMPT,
        completion: { sha: BASE_SHA, treeOid: BASE_TREE },
      },
    )
    assert.ok(isOk(outcome))
    if (outcome.kind !== 'ok') return
    assert.deepEqual(outcome.value, {
      kind: 'map-completion',
      repositoryId: 'R_1',
      runId: 'run-1',
      path: COMPLETION_PATH,
      completionAttemptId: COMPLETION_ATTEMPT,
    })
    const worktreeCall = calls.find((call) => call.args[0] === 'worktree')
    assert.deepEqual(worktreeCall?.args.slice(0, 4), ['worktree', 'add', '--detach', COMPLETION_PATH])
    assert.equal(calls.some((call) => call.args[0] === 'branch'), false)
  })

  it('rejects unsafe completion-attempt names without touching git', async () => {
    const { git, calls } = recorderGit(successHandler())
    const outcome = await createMapCompletionWorkspace(
      { git },
      {
        repositoryRoot: REPOSITORY_ROOT,
        repositoryHome: REPOSITORY_HOME,
        repositoryId: 'R_1',
        runId: 'run-1',
        completionAttemptId: 'MC/3',
        completion: { sha: BASE_SHA, treeOid: BASE_TREE },
      },
    )
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'invalid-workspace-name')
    assert.equal(calls.length, 0)
  })
})

describe('inspectWorkspace', () => {
  it('maps raw git output into the complete workspace state', async () => {
    const { git } = recorderGit(successHandler())
    const inspection = await inspectWorkspace(git, WORKSPACE_PATH)
    assert.equal(inspection.status, 'ok')
    if (inspection.status !== 'ok') return
    assert.deepEqual(inspection.state, {
      head: BASE_SHA,
      headTree: BASE_TREE,
      symbolicHead: `refs/heads/${BRANCH}`,
      objectFormat: 'sha1',
      commonDir: COMMON_DIR,
      status: [],
    })
  })

  it('reports git failures without inventing state', async () => {
    const { git } = recorderGit(() => failResult())
    const inspection = await inspectWorkspace(git, WORKSPACE_PATH)
    assert.equal(inspection.status, 'git-failed')
  })
})
