/**
 * The deterministic fake command (test fixture).
 *
 * A plain node script that plays a configured command for the Command
 * runner tests. It is launched as the leader of its own process group and
 * behaves according to `NORN_CMD_MODE`:
 *
 *   echo         write `NORN_CMD_STDOUT`/`NORN_CMD_STDERR` to the two
 *                streams byte-exactly, then exit `NORN_CMD_EXIT` (default 0)
 *   print-env    print which environment names the child process can see
 *   pwd          print the working directory the command runs in
 *   linger       spawn `sleep NORN_CMD_LINGER_SECONDS` in the same process
 *                group, then exit `NORN_CMD_EXIT` while the grandchild lives
 *   hang         sleep for a long time, writing an untracked file after
 *                `NORN_CMD_MUTATE_DELAY_MS` if configured
 *   commit       create an empty commit on the checked-out branch (mutates
 *                HEAD)
 *   untracked    write `NORN_CMD_MUTATE_PATH` (non-ignored untracked file)
 *
 * `NORN_CMD_PGD_FILE`, when set, receives the process-group ID the fixture
 * runs in, so tests can observe whole-group liveness from outside.
 */
import { execFileSync, spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const mode = process.env.NORN_CMD_MODE ?? 'echo'

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function main(): Promise<void> {
  const pgidFile = process.env.NORN_CMD_PGD_FILE
  if (pgidFile !== undefined) {
    // The runner spawns this fixture as a detached group leader, so its pid
    // is the process-group ID.
    await writeFile(pgidFile, `${process.pid}\n`, 'utf8')
  }

  switch (mode) {
    case 'echo': {
      process.stdout.write(process.env.NORN_CMD_STDOUT ?? '')
      process.stderr.write(process.env.NORN_CMD_STDERR ?? '')
      process.exit(Number(process.env.NORN_CMD_EXIT ?? '0'))
    }
    case 'print-env': {
      const visible = [
        'GITHUB_TOKEN',
        'GH_TOKEN',
        'GH_ENTERPRISE_TOKEN',
        'GITHUB_API_TOKEN',
        'GITHUB_COPILOT_TOKEN',
        'GIT_ASKPASS',
        'SSH_ASKPASS',
        'SSH_AUTH_SOCK',
        'GIT_SSH_COMMAND',
        'GIT_CONFIG_COUNT',
        'NORN_CMD_MARKER',
        'PATH',
      ]
      const present: Record<string, boolean> = {}
      for (const name of visible) present[name] = process.env[name] !== undefined
      process.stdout.write(JSON.stringify(present))
      return
    }
    case 'pwd': {
      process.stdout.write(process.cwd())
      return
    }
    case 'linger': {
      const seconds = process.env.NORN_CMD_LINGER_SECONDS ?? '5'
      const grandchild = spawn('sleep', [seconds], { stdio: 'ignore' })
      grandchild.unref()
      // Let the grandchild actually start so it occupies the process group.
      await sleep(150)
      process.exit(Number(process.env.NORN_CMD_EXIT ?? '0'))
    }
    case 'hang': {
      const mutateDelayMs = Number(process.env.NORN_CMD_MUTATE_DELAY_MS ?? '0')
      const mutatePath = process.env.NORN_CMD_MUTATE_PATH
      if (mutateDelayMs > 0 && mutatePath !== undefined) {
        await sleep(mutateDelayMs)
        await writeFile(mutatePath, 'late residue\n', 'utf8')
      }
      await sleep(600_000)
      return
    }
    case 'commit': {
      execFileSync('git', ['commit', '--allow-empty', '--no-gpg-sign', '-m', 'mutation'], {
        stdio: 'ignore',
      })
      return
    }
    case 'untracked': {
      await writeFile(join(process.cwd(), process.env.NORN_CMD_MUTATE_PATH ?? 'residue.txt'), 'residue\n', 'utf8')
      return
    }
    default: {
      console.error(`fake command: unknown NORN_CMD_MODE ${mode}`)
      process.exit(4)
    }
  }
}

main().catch((cause) => {
  console.error('fake command failed:', cause)
  process.exit(6)
})
