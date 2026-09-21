/**
 * The Command runner over real processes (design.md §6, §8, §10.2,
 * ticket #7).
 *
 * Fake commands — plain node scripts from `test/fixtures/fake-command.ts` —
 * are launched through the production adapter as leaders of their own
 * process groups. Covers: pass on exit 0 before timeout, clean non-zero
 * exit, wall-clock timeout with complete process-group termination and
 * settlement before any result, whole-group budgets that outlive the
 * leader, byte-exact captured output with its framed digest, the gate
 * workspace as working directory, launch failures, and a child environment
 * that demonstrably excludes GitHub tokens and push credentials.
 */
import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { isProcessGroupAlive } from '../src/agents/process-group.ts'
import { commandOutputDigest } from '../src/work/command-output.ts'
import { ProcessGroupCommandRunner } from '../src/work/command-runner.ts'

const fakeCommandPath = fileURLToPath(new URL('./fixtures/fake-command.ts', import.meta.url))

function fakeCommand(
  mode: string,
  env: Record<string, string> = {},
): { argv: string[]; env: Record<string, string> } {
  return { argv: [process.execPath, fakeCommandPath], env: { NORN_CMD_MODE: mode, ...env } }
}

/**
 * The coordinator-defined environment of one fixture launch: the runner
 * sanitizes whatever the coordinator would hand it.
 */
function fixtureEnvironment(
  command: { env: Record<string, string> },
): () => Record<string, string> {
  return () => ({ PATH: process.env.PATH ?? '/bin', ...command.env })
}

function runner(environment?: () => Record<string, string | undefined>): ProcessGroupCommandRunner {
  return new ProcessGroupCommandRunner({
    environment,
    terminate: { graceMs: 300, killWaitMs: 2_000 },
    streamCloseGraceMs: 2_000,
  })
}

async function tempDir(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `norn-command-${label}-`))
}

describe('a command that exits zero before timeout passes', () => {
  it('captures byte-exact output with its framed digest', async () => {
    const cwd = await tempDir('pass')
    try {
      const stdout = 'line one\nline two\n'
      const stderr = 'warning \u00e9\n'
      const command = fakeCommand('echo', { NORN_CMD_STDOUT: stdout, NORN_CMD_STDERR: stderr })
      const execution = await runner(fixtureEnvironment(command)).execute({
        argv: command.argv,
        cwd,
        timeoutMs: 10_000,
      })
      assert.equal(execution.status, 'exited')
      if (execution.status !== 'exited') return
      assert.equal(execution.exitCode, 0)
      assert.equal(execution.processGroup.terminated, false)
      assert.equal(Buffer.from(execution.stdout).toString('utf8'), stdout)
      assert.equal(Buffer.from(execution.stderr).toString('utf8'), stderr)
      assert.equal(
        execution.outputDigest,
        commandOutputDigest(Buffer.from(stdout), Buffer.from(stderr)),
      )
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('runs with the requested working directory', async () => {
    const cwd = await tempDir('cwd')
    try {
      const command = fakeCommand('pwd')
      const execution = await runner(fixtureEnvironment(command)).execute({
        argv: command.argv,
        cwd,
        timeoutMs: 10_000,
      })
      assert.equal(execution.status, 'exited')
      // The child reports the resolver's view of the symlinked temp root.
      assert.equal(Buffer.from(execution.stdout).toString('utf8'), realpathSync(cwd))
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('a clean non-zero exit', () => {
  it('reports the exit code with the group settled', async () => {
    const cwd = await tempDir('nonzero')
    try {
      const command = fakeCommand('echo', { NORN_CMD_EXIT: '7' })
      const execution = await runner(fixtureEnvironment(command)).execute({
        argv: command.argv,
        cwd,
        timeoutMs: 10_000,
      })
      assert.equal(execution.status, 'exited')
      assert.equal(execution.status === 'exited' ? execution.exitCode : null, 7)
      assert.equal(execution.status === 'exited' ? execution.processGroup.state : '', 'settled')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('a command that cannot start', () => {
  it('reports launch-failed without inspecting anything', async () => {
    const cwd = await tempDir('launch')
    try {
      const execution = await runner().execute({
        argv: ['norn-missing-executable-xyz', '--flag'],
        cwd,
        timeoutMs: 10_000,
      })
      assert.equal(execution.status, 'launch-failed')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('rejects an empty argv and a non-positive timeout', async () => {
    const cwd = await tempDir('argv')
    try {
      const empty = await runner().execute({ argv: [], cwd, timeoutMs: 10_000 })
      assert.equal(empty.status, 'launch-failed')
      const zero = await runner().execute({ argv: ['true'], cwd, timeoutMs: 0 })
      assert.equal(zero.status, 'launch-failed')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('a wall-clock timeout', () => {
  it('terminates and settles the complete process group before returning', async () => {
    const cwd = await tempDir('timeout')
    const pgidFile = join(cwd, 'pgid')
    try {
      const command = fakeCommand('hang', { NORN_CMD_PGD_FILE: pgidFile })
      const execution = await runner(fixtureEnvironment(command)).execute({
        argv: command.argv,
        cwd,
        timeoutMs: 400,
      })
      assert.equal(execution.status, 'timeout-terminated')
      assert.equal(
        execution.status === 'timeout-terminated' ? execution.processGroup.terminated : false,
        true,
      )

      const pgid = Number(await readFile(pgidFile, 'utf8'))
      assert.ok(Number.isInteger(pgid) && pgid > 0)
      assert.equal(isProcessGroupAlive(pgid), false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('kills the whole group before a late side effect can land', async () => {
    const cwd = await tempDir('late')
    const residue = join(cwd, 'late-residue.txt')
    try {
      const command = fakeCommand('hang', {
        NORN_CMD_MUTATE_DELAY_MS: '600',
        NORN_CMD_MUTATE_PATH: residue,
      })
      const execution = await runner(fixtureEnvironment(command)).execute({
        argv: command.argv,
        cwd,
        timeoutMs: 200,
      })
      assert.equal(execution.status, 'timeout-terminated')
      // The group was terminated and settled before the file could be
      // written: no residue from a settled timeout.
      assert.equal(existsSync(residue), false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('the wall-clock budget covers the complete process group', () => {
  it('reports a timeout when a grandchild outlives the exited leader', async () => {
    const cwd = await tempDir('linger-timeout')
    const pgidFile = join(cwd, 'pgid')
    try {
      const command = fakeCommand('linger', {
        NORN_CMD_LINGER_SECONDS: '30',
        NORN_CMD_PGD_FILE: pgidFile,
      })
      const startedAt = Date.now()
      const execution = await runner(fixtureEnvironment(command)).execute({
        argv: command.argv,
        cwd,
        timeoutMs: 700,
      })
      assert.equal(execution.status, 'timeout-terminated')
      if (execution.status === 'timeout-terminated') {
        // The leader itself exited zero; the group budget is what elapsed.
        assert.equal(execution.exitCode, 0)
        assert.ok(Date.now() - startedAt >= 600)
      }
      const pgid = Number(await readFile(pgidFile, 'utf8'))
      assert.equal(isProcessGroupAlive(pgid), false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('waits for a grandchild that exits within the budget', async () => {
    const cwd = await tempDir('linger-settle')
    try {
      const command = fakeCommand('linger', { NORN_CMD_LINGER_SECONDS: '0.4' })
      const execution = await runner(fixtureEnvironment(command)).execute({
        argv: command.argv,
        cwd,
        timeoutMs: 15_000,
      })
      assert.equal(execution.status, 'exited')
      assert.equal(execution.status === 'exited' ? execution.exitCode : null, 0)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('the coordinator-defined child environment', () => {
  it('excludes GitHub tokens and push credentials the coordinator holds', async () => {
    const cwd = await tempDir('env')
    try {
      const command = fakeCommand('print-env')
      const coordinatorEnv: Record<string, string> = {
        PATH: process.env.PATH ?? '/bin',
        NORN_CMD_MARKER: 'kept',
        GITHUB_TOKEN: 'gh-secret',
        GH_TOKEN: 'gh-secret',
        GH_ENTERPRISE_TOKEN: 'ghe-secret',
        GITHUB_API_TOKEN: 'api-secret',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        GIT_ASKPASS: '/usr/bin/askpass',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: 'store',
        ...command.env,
      }
      const execution = await runner(() => coordinatorEnv).execute({
        argv: command.argv,
        cwd,
        timeoutMs: 10_000,
      })
      assert.equal(execution.status, 'exited')
      const visible = JSON.parse(Buffer.from(execution.stdout).toString('utf8')) as Record<
        string,
        boolean
      >
      for (const name of [
        'GITHUB_TOKEN',
        'GH_TOKEN',
        'GH_ENTERPRISE_TOKEN',
        'GITHUB_API_TOKEN',
        'SSH_AUTH_SOCK',
        'GIT_ASKPASS',
        'GIT_CONFIG_COUNT',
      ]) {
        assert.equal(visible[name], false, name)
      }
      assert.equal(visible.NORN_CMD_MARKER, true)
      assert.equal(visible.PATH, true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('sanitizes the coordinator process environment by default', async () => {
    const cwd = await tempDir('env-default')
    const previous = process.env.GITHUB_TOKEN
    process.env.GITHUB_TOKEN = 'coordinator-secret'
    try {
      const command = fakeCommand('print-env')
      const execution = await new ProcessGroupCommandRunner({
        terminate: { graceMs: 300, killWaitMs: 2_000 },
        environment: () => ({ ...process.env, ...command.env }),
      }).execute({ argv: command.argv, cwd, timeoutMs: 10_000 })
      assert.equal(execution.status, 'exited')
      const visible = JSON.parse(Buffer.from(execution.stdout).toString('utf8')) as Record<
        string,
        boolean
      >
      assert.equal(visible.GITHUB_TOKEN, false)
      assert.equal(visible.PATH, true)
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = previous
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('a silent command', () => {
  it('frames empty streams', async () => {
    const cwd = await tempDir('silent')
    try {
      const command = fakeCommand('echo', {})
      const execution = await runner(fixtureEnvironment(command)).execute({
        argv: command.argv,
        cwd,
        timeoutMs: 10_000,
      })
      assert.equal(execution.status, 'exited')
      assert.deepEqual(execution.stdout, new Uint8Array(0))
      assert.deepEqual(execution.stderr, new Uint8Array(0))
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
