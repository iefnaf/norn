/**
 * Test fixture: a child process that holds locks through the real lock
 * module, so tests can exercise cross-process exclusion, auto-release on
 * coordinator death, and non-inheritance by spawned children.
 *
 * Modes (argv[2]):
 *   hold <lockPath>          acquire, report "acquired", hold until stdin
 *                            closes or 30s elapse, then release and exit.
 *   spawn-heir <lockPath>    acquire, spawn a detached `sleep` process group
 *                            (a child that must never hold the lock), report
 *                            "spawned <pgid>", then exit the coordinator
 *                            without releasing — the lock must auto-release
 *                            while the heir is still alive.
 */
import { spawnProcessGroup } from '../../src/agents/process-group.ts'
import { acquireLock } from '../../src/runstate/locks.ts'

async function main(): Promise<void> {
  const mode = process.argv[2]
  const lockPath = process.argv[3]
  if (mode === undefined || lockPath === undefined) {
    process.stderr.write('usage: lock-holder-child.ts <hold|spawn-heir> <lockPath>\n')
    process.exit(2)
  }

  const lock = await acquireLock(lockPath)
  if (lock.kind !== 'ok') {
    process.stdout.write(`contended\n`)
    process.exit(3)
  }
  process.stdout.write(`acquired\n`)

  if (mode === 'spawn-heir') {
    const child = await spawnProcessGroup(['sleep', '30'])
    process.stdout.write(`spawned ${child.pid}\n`)
    // Exit the coordinator without releasing: the spawned heir keeps running.
    // The exit must be explicit — the held lock's holder pipe would otherwise
    // keep this process alive, which is exactly the semantics under test.
    process.exit(0)
  }

  // hold: wait until the parent closes stdin (or 30s) and then release.
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 30_000)
    process.stdin.on('end', () => {
      clearTimeout(timer)
      resolvePromise()
    })
    process.stdin.on('data', () => {
      /* keep stdin referenced until close */
    })
    process.stdin.resume()
  })
  const released = await lock.value.release()
  process.stdout.write(`released ${released.kind}\n`)
}

main().catch((cause) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`)
  process.exit(4)
})
