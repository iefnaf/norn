/**
 * The protocol-valid command check (design.md §10.2, ticket #7) — first
 * against deterministic fakes for the Command runner and git inspection,
 * then against a real temporary repository with the real git runner and the
 * production command runner.
 *
 * Covers every acceptance criterion: commands run in Run Config order and
 * stop at the first non-pass with framed output digests captured; a command
 * that mutates HEAD, the tree, or cleanliness turns its result into a
 * protocol error rather than feedback; a timeout kills and settles the whole
 * process group before repository inspection; and ignored dependency
 * directories may remain without ever counting as evidence.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import type { GitCommandResult, GitCommandRunner } from '../src/adapters/git-repository.ts'
import { runGit } from '../src/adapters/git-repository.ts'
import { isError, isOk } from '../src/core/outcome.ts'
import type { RunConfigCommand } from '../src/config/run-config.ts'
import { commandOutputDigest } from '../src/work/command-output.ts'
import type { CommandExecution, CommandExecutionRequest, CommandRunner } from '../src/work/command-runner.ts'
import { ProcessGroupCommandRunner } from '../src/work/command-runner.ts'
import { runGateCommand, runGateCommandList } from '../src/work/gate.ts'
import type { GateCommandOutcome } from '../src/work/gate.ts'
import { createTicketWorkspace } from '../src/work/workspace.ts'

const BASE_SHA = `sha1:${'a'.repeat(40)}`
const BASE_TREE = `sha1:${'b'.repeat(40)}`
const WORKSPACE_PATH = '/repo-home/runs/run-1/workspaces/7/wa-1'

const WORKSPACE = { path: WORKSPACE_PATH, expectedHead: BASE_SHA, expectedTreeOid: BASE_TREE }

function command(argv: string[], timeoutMs = 60_000): RunConfigCommand {
  return { argv, timeoutMs }
}

function capture(stdout: string, stderr: string) {
  const stdoutBytes = Buffer.from(stdout)
  const stderrBytes = Buffer.from(stderr)
  return {
    stdout: stdoutBytes,
    stderr: stderrBytes,
    outputDigest: commandOutputDigest(stdoutBytes, stderrBytes),
  }
}

/** A Command runner fake that records every request, scripted per argv. */
function fakeRunner(
  script: (request: CommandExecutionRequest) => CommandExecution | Promise<CommandExecution>,
): { runner: CommandRunner; requests: CommandExecutionRequest[] } {
  const requests: CommandExecutionRequest[] = []
  const runner: CommandRunner = {
    async execute(request) {
      requests.push(request)
      return script(request)
    },
  }
  return { runner, requests }
}

/** A git seam fake that only answers workspace inspection, with state. */
function inspectGit(state: {
  head?: string
  headTree?: string
  status?: string[]
  fail?: boolean
}): { git: GitCommandRunner; calls: { count: number } } {
  const calls = { count: 0 }
  const git: GitCommandRunner = async (args, cwd) => {
    calls.count++
    assert.equal(cwd, WORKSPACE_PATH, `unexpected git cwd: ${cwd}`)
    if (state.fail) return { ok: false, failure: 'git-failed', message: 'scripted failure' }
    if (args[0] === 'rev-parse') {
      if (args[1] === '--show-object-format') return okResult('sha1\n')
      if (args[1] === '--git-common-dir') return okResult('/repo/.git\n')
      if (args[1] === 'HEAD') return okResult(`${state.head ?? BASE_SHA.slice(5)}\n`)
      if (args[1] === 'HEAD^{tree}') return okResult(`${state.headTree ?? BASE_TREE.slice(5)}\n`)
      if (args[1] === '--symbolic-full-name') {
        return okResult('refs/heads/norn/run-1/7/wa-1\n')
      }
    }
    if (args[0] === 'status') return okResult((state.status ?? []).join('\n') + (state.status?.length ? '\n' : ''))
    return { ok: false, failure: 'git-failed', message: `unscripted: ${args.join(' ')}` }
  }
  return { git, calls }
}

function okResult(stdout = ''): GitCommandResult {
  return { ok: true, stdout }
}

describe('runGateCommand classification', () => {
  it('passes a protocol-valid exit zero with the framed digest captured', async () => {
    const { runner } = fakeRunner(() => ({
      status: 'exited',
      exitCode: 0,
      processGroup: { state: 'settled', terminated: false },
      ...capture('out\n', 'err\n'),
    }))
    const { git } = inspectGit({})
    const outcome = await runGateCommand(
      { runner, git },
      { command: command(['npm', 'test']), workspace: WORKSPACE },
    )
    assert.ok(isOk(outcome))
    if (outcome.kind !== 'ok') return
    assert.equal(outcome.value.status, 'pass')
    assert.equal(outcome.value.exitCode, 0)
    assert.deepEqual(outcome.value.argv, ['npm', 'test'])
    assert.equal(outcome.value.outputDigest, commandOutputDigest(Buffer.from('out\n'), Buffer.from('err\n')))
  })

  it('turns a clean non-zero exit into structured feedback', async () => {
    const { runner } = fakeRunner(() => ({
      status: 'exited',
      exitCode: 3,
      processGroup: { state: 'settled', terminated: false },
      ...capture('', 'failing test\n'),
    }))
    const outcome = await runGateCommand(
      { runner, git: inspectGit({}).git },
      { command: command(['npm', 'test']), workspace: WORKSPACE },
    )
    assert.ok(isOk(outcome))
    if (outcome.kind !== 'ok') return
    assert.equal(outcome.value.status, 'feedback')
    assert.equal(outcome.value.cause, 'non-zero-exit')
    assert.equal(outcome.value.exitCode, 3)
  })

  it('turns a settled timeout into structured feedback, never evidence', async () => {
    const { runner } = fakeRunner(() => ({
      status: 'timeout-terminated',
      exitCode: null,
      processGroup: { state: 'settled', terminated: true },
      ...capture('partial', ''),
    }))
    const outcome = await runGateCommand(
      { runner, git: inspectGit({}).git },
      { command: command(['npm', 'test'], 500), workspace: WORKSPACE },
    )
    assert.ok(isOk(outcome))
    if (outcome.kind !== 'ok') return
    assert.equal(outcome.value.status, 'feedback')
    assert.equal(outcome.value.cause, 'timeout-terminated')
  })

  it('reports a launch failure as a protocol error without inspecting the repository', async () => {
    const { runner, requests } = fakeRunner(() => ({ status: 'launch-failed', message: 'ENOENT' }))
    const { git, calls } = inspectGit({})
    const outcome = await runGateCommand(
      { runner, git },
      { command: command(['missing']), workspace: WORKSPACE },
    )
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'command-launch-failed')
    assert.equal(calls.count, 0)
    assert.deepEqual(requests[0]!.cwd, WORKSPACE_PATH)
    assert.deepEqual(requests[0]!.argv, ['missing'])
  })

  it('reports an unsettled group as a protocol error without inspecting the repository', async () => {
    const { runner } = fakeRunner(() => ({
      status: 'settle-failed',
      message: 'process group could not be proven exited after timeout',
      exitCode: null,
    }))
    const { git, calls } = inspectGit({})
    const outcome = await runGateCommand(
      { runner, git },
      { command: command(['npm', 'test']), workspace: WORKSPACE },
    )
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'command-settle-failed')
    assert.equal(calls.count, 0)
  })

  it('reports a failed repository inspection separately', async () => {
    const { runner } = fakeRunner(() => ({
      status: 'exited',
      exitCode: 0,
      processGroup: { state: 'settled', terminated: false },
      ...capture('', ''),
    }))
    const outcome = await runGateCommand(
      { runner, git: inspectGit({ fail: true }).git },
      { command: command(['npm', 'test']), workspace: WORKSPACE },
    )
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'workspace-inspection-failed')
  })
})

describe('runGateCommand protocol errors on repository mutation', () => {
  async function mutationOutcome(state: {
    head?: string
    headTree?: string
    status?: string[]
  }): Promise<GateCommandOutcome> {
    const { runner } = fakeRunner(() => ({
      status: 'exited',
      exitCode: 0,
      processGroup: { state: 'settled', terminated: false },
      ...capture('', ''),
    }))
    return runGateCommand(
      { runner, git: inspectGit(state).git },
      { command: command(['npm', 'test']), workspace: WORKSPACE },
    )
  }

  it('a HEAD that moved off the expected commit is a protocol error', async () => {
    const outcome = await mutationOutcome({ head: 'f'.repeat(40) })
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'command-protocol')
    assert.match(JSON.stringify(outcome.kind === 'error' ? outcome.evidence : []), /"head"/)
  })

  it('a changed tree OID is a protocol error', async () => {
    const outcome = await mutationOutcome({ headTree: 'e'.repeat(40) })
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'command-protocol')
    assert.match(JSON.stringify(outcome.kind === 'error' ? outcome.evidence : []), /headTree/)
  })

  it('staged changes are a protocol error', async () => {
    const outcome = await mutationOutcome({ status: ['A  staged.txt'] })
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'command-protocol')
    assert.match(JSON.stringify(outcome.kind === 'error' ? outcome.evidence : []), /staged.txt/)
  })

  it('unstaged tracked changes are a protocol error', async () => {
    const outcome = await mutationOutcome({ status: [' M tracked.txt'] })
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'command-protocol')
  })

  it('non-ignored untracked residue is a protocol error', async () => {
    const outcome = await mutationOutcome({ status: ['?? residue/'] })
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'command-protocol')
  })

  it('ignored dependency directories alone never count: the command passes', async () => {
    // Ignored directories never appear in `git status --porcelain`, so an
    // empty status is a pass even while node_modules sits in the workspace.
    const outcome = await mutationOutcome({ status: [] })
    assert.ok(isOk(outcome))
    assert.equal(outcome.kind === 'ok' ? outcome.value.status : '', 'pass')
  })
})

describe('settlement precedes repository inspection', () => {
  it('inspects only after the command runner settles the group', async () => {
    let resolveExecution: (execution: CommandExecution) => void = () => {}
    const executionPromise = new Promise<CommandExecution>((resolvePromise) => {
      resolveExecution = resolvePromise
    })
    const { runner } = fakeRunner(() => executionPromise)
    const { git, calls } = inspectGit({})

    const outcomePromise = runGateCommand(
      { runner, git },
      { command: command(['npm', 'test']), workspace: WORKSPACE },
    )
    await new Promise((resolveTick) => setImmediate(resolveTick))
    assert.equal(calls.count, 0, 'repository was inspected before the process group settled')

    resolveExecution({
      status: 'exited',
      exitCode: 0,
      processGroup: { state: 'settled', terminated: false },
      ...capture('', ''),
    })
    const outcome = await outcomePromise
    assert.ok(isOk(outcome))
    assert.equal(calls.count, 6)
  })
})

describe('runGateCommandList', () => {
  function exited(exitCode: number, stdout = ''): CommandExecution {
    return {
      status: 'exited',
      exitCode,
      processGroup: { state: 'settled', terminated: false },
      ...capture(stdout, ''),
    }
  }

  it('runs commands in Run Config order, stopping at the first non-pass', async () => {
    const executed: string[] = []
    const { runner } = fakeRunner((request) => {
      executed.push(request.argv.join(' '))
      if (request.argv[0] === 'failer') return exited(2, 'boom')
      return exited(0)
    })
    const outcome = await runGateCommandList(
      { runner, git: inspectGit({}).git },
      {
        commands: [command(['setup-a']), command(['setup-b']), command(['failer']), command(['never'])],
        workspace: WORKSPACE,
      },
    )
    assert.ok(isOk(outcome))
    if (outcome.kind !== 'ok') return
    assert.deepEqual(executed, ['setup-a', 'setup-b', 'failer'])
    assert.deepEqual(
      outcome.value.entries.map((entry) => entry.index),
      [0, 1, 2],
    )
    assert.equal(outcome.value.stoppedAtIndex, 2)
    assert.equal(outcome.value.entries[0]!.result.status, 'pass')
    const stopped = outcome.value.entries[2]!.result
    assert.equal(stopped.status, 'feedback')
    assert.equal(stopped.cause, 'non-zero-exit')
  })

  it('captures a framed output digest for every executed command', async () => {
    const { runner } = fakeRunner((request) => exited(0, `output of ${request.argv[0]}`))
    const outcome = await runGateCommandList(
      { runner, git: inspectGit({}).git },
      {
        commands: [command(['one']), command(['two']), command(['three'])],
        workspace: WORKSPACE,
      },
    )
    assert.ok(isOk(outcome))
    if (outcome.kind !== 'ok') return
    assert.equal(outcome.value.stoppedAtIndex, null)
    for (const entry of outcome.value.entries) {
      assert.equal(
        entry.result.outputDigest,
        commandOutputDigest(Buffer.from(`output of ${entry.command.argv[0]}`), Buffer.from('')),
      )
    }
  })

  it('stops immediately when a command is a protocol error', async () => {
    const executed: string[] = []
    const { runner } = fakeRunner((request) => {
      executed.push(request.argv.join(' '))
      return exited(0)
    })
    const outcome = await runGateCommandList(
      { runner, git: inspectGit({ status: ['?? residue.txt'] }).git },
      { commands: [command(['first']), command(['second'])], workspace: WORKSPACE },
    )
    assert.ok(isError(outcome))
    assert.equal(outcome.kind === 'error' ? outcome.code : '', 'command-protocol')
    assert.deepEqual(executed, ['first'])
  })

  it('runs an empty list as a trivial full pass', async () => {
    const { runner } = fakeRunner(() => exited(0))
    const outcome = await runGateCommandList(
      { runner, git: inspectGit({}).git },
      { commands: [], workspace: WORKSPACE },
    )
    assert.ok(isOk(outcome))
    if (outcome.kind !== 'ok') return
    assert.deepEqual(outcome.value.entries, [])
    assert.equal(outcome.value.stoppedAtIndex, null)
  })
})

describe('runGateCommand scope', () => {
  it('defaults to ticket scope and honors the enclosing operation scope', async () => {
    const pass = () =>
      fakeRunner(() => ({
        status: 'exited',
        exitCode: 0,
        processGroup: { state: 'settled', terminated: false },
        ...capture('', ''),
      }))
    const failure = () =>
      fakeRunner(() => ({
        status: 'exited',
        exitCode: 0,
        processGroup: { state: 'settled', terminated: false },
        ...capture('', ''),
      }))

    const ticket = await runGateCommand(
      { runner: failure().runner, git: inspectGit({ head: 'f'.repeat(40) }).git },
      { command: command(['x']), workspace: WORKSPACE },
    )
    assert.equal(ticket.kind === 'error' ? ticket.scope : '', 'ticket')

    const run = await runGateCommand(
      { runner: failure().runner, git: inspectGit({ head: 'f'.repeat(40) }).git },
      { command: command(['x']), workspace: WORKSPACE, scope: 'run' },
    )
    assert.equal(run.kind === 'error' ? run.scope : '', 'run')

    const okOutcome = await runGateCommand(
      { runner: pass().runner, git: inspectGit({}).git },
      { command: command(['x']), workspace: WORKSPACE },
    )
    assert.ok(isOk(okOutcome))
  })
})

describe('gate commands against a real repository', () => {
  const fakeCommandPath = fileURLToPath(new URL('./fixtures/fake-command.ts', import.meta.url))

  function fakeCommand(mode: string, timeoutMs = 10_000): RunConfigCommand {
    return { argv: [process.execPath, fakeCommandPath], timeoutMs }
  }

  type RealWorkspace = {
    readonly path: string
    readonly expectedHead: string
    readonly expectedTreeOid: string
    readonly cleanup: () => void
  }

  async function realWorkspace(label: string, ignoreNodeModules = false): Promise<RealWorkspace> {
    const scratch = mkdtempSync(join(tmpdir(), `norn-gate-${label}-`))
    const root = join(scratch, 'repo')
    execFileSync('git', ['init', '--quiet', '-b', 'main', root])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'norn@example.invalid'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Norn Test'])
    if (ignoreNodeModules) writeFileSync(join(root, '.gitignore'), 'node_modules/\n', 'utf8')
    writeFileSync(join(root, 'README.md'), '# temp\n', 'utf8')
    execFileSync('git', ['-C', root, 'add', '.'])
    execFileSync('git', ['-C', root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'init'])
    const baseSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const baseTree = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD^{tree}'], {
      encoding: 'utf8',
    }).trim()

    const workspace = await createTicketWorkspace(
      { git: runGit },
      {
        repositoryRoot: root,
        repositoryHome: join(scratch, 'repo-home'),
        repositoryId: 'R_1',
        runId: 'run-1',
        ticketNumber: 7,
        workAttemptId: 'wa-1',
        base: { sha: `sha1:${baseSha}`, treeOid: `sha1:${baseTree}` },
      },
    )
    if (!isOk(workspace)) throw new Error(`workspace creation failed: ${workspace.kind}`)
    const path = realpathSync(workspace.value.path)
    return {
      path,
      expectedHead: `sha1:${baseSha}`,
      expectedTreeOid: `sha1:${baseTree}`,
      cleanup: () => rmSync(scratch, { recursive: true, force: true }),
    }
  }

  function realRunner(env: Record<string, string>): ProcessGroupCommandRunner {
    return new ProcessGroupCommandRunner({
      environment: () => ({ PATH: process.env.PATH ?? '/bin', ...env }),
      terminate: { graceMs: 300, killWaitMs: 2_000 },
      streamCloseGraceMs: 2_000,
    })
  }

  it('runs the complete configured list in order and passes', async () => {
    const workspace = await realWorkspace('real-pass')
    try {
      const deps = {
        runner: realRunner({ NORN_CMD_MODE: 'echo' }),
        git: runGit,
      }
      const outcome = await runGateCommandList(deps, {
        commands: [fakeCommand('echo'), fakeCommand('echo')],
        workspace,
      })
      assert.ok(isOk(outcome))
      if (outcome.kind !== 'ok') return
      assert.equal(outcome.value.stoppedAtIndex, null)
      assert.equal(outcome.value.entries.length, 2)
      assert.equal(outcome.value.entries.every((entry) => entry.result.status === 'pass'), true)
    } finally {
      workspace.cleanup()
    }
  })

  it('a command that commits mutates HEAD into a protocol error', async () => {
    const workspace = await realWorkspace('real-commit')
    try {
      const outcome = await runGateCommand(
        { runner: realRunner({ NORN_CMD_MODE: 'commit' }), git: runGit },
        { command: fakeCommand('commit'), workspace },
      )
      assert.ok(isError(outcome))
      assert.equal(outcome.kind === 'error' ? outcome.code : '', 'command-protocol')
      assert.match(JSON.stringify(outcome.kind === 'error' ? outcome.evidence : []), /"head"/)
    } finally {
      workspace.cleanup()
    }
  })

  it('a command that leaves non-ignored residue is a protocol error', async () => {
    const workspace = await realWorkspace('real-residue')
    try {
      const outcome = await runGateCommand(
        { runner: realRunner({ NORN_CMD_MODE: 'untracked', NORN_CMD_MUTATE_PATH: 'residue.txt' }), git: runGit },
        { command: fakeCommand('untracked'), workspace },
      )
      assert.ok(isError(outcome))
      assert.equal(outcome.kind === 'error' ? outcome.code : '', 'command-protocol')
      assert.match(JSON.stringify(outcome.kind === 'error' ? outcome.evidence : []), /residue.txt/)
    } finally {
      workspace.cleanup()
    }
  })

  it('a settled timeout is feedback, and its late mutation never lands', async () => {
    const workspace = await realWorkspace('real-timeout')
    const residue = join(workspace.path, 'late-residue.txt')
    try {
      const outcome = await runGateCommand(
        {
          runner: realRunner({
            NORN_CMD_MODE: 'hang',
            NORN_CMD_MUTATE_DELAY_MS: '600',
            NORN_CMD_MUTATE_PATH: residue,
          }),
          git: runGit,
        },
        { command: fakeCommand('hang', 200), workspace },
      )
      assert.ok(isOk(outcome))
      if (outcome.kind !== 'ok') return
      assert.equal(outcome.value.status, 'feedback')
      assert.equal(outcome.value.cause, 'timeout-terminated')
      // The group was killed and settled before the write could land, so
      // the repository inspection found no residue and no protocol error.
      assert.equal(existsSync(residue), false)
    } finally {
      workspace.cleanup()
    }
  })

  it('ignored dependency directories may remain and never count as evidence', async () => {
    const workspace = await realWorkspace('real-ignored', true)
    try {
      // Leave an ignored dependency directory in the workspace, then run a
      // passing command: the residue is invisible to the protocol check.
      const nodeModules = join(workspace.path, 'node_modules', 'left-pad')
      const { mkdirSync } = await import('node:fs')
      mkdirSync(nodeModules, { recursive: true })
      writeFileSync(join(nodeModules, 'index.js'), '// cache\n', 'utf8')

      const outcome = await runGateCommand(
        { runner: realRunner({ NORN_CMD_MODE: 'echo' }), git: runGit },
        { command: fakeCommand('echo'), workspace },
      )
      assert.ok(isOk(outcome))
      if (outcome.kind !== 'ok') return
      assert.equal(outcome.value.status, 'pass')
      // Nothing about the ignored directory became evidence.
      assert.equal(JSON.stringify(outcome.value).includes('node_modules'), false)
    } finally {
      workspace.cleanup()
    }
  })
})
