import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { isProcessGroupAlive, terminateProcessGroup } from '../src/agents/process-group.ts'
import {
  controlLockPath,
  locksDir,
  mapLockPath,
  targetLockPath,
} from '../src/config/paths.ts'
import {
  acquireControlLock,
  acquireLock,
  acquireMapLock,
  acquireTargetLock,
  isMapLockHeld,
} from '../src/runstate/locks.ts'

const CHILD = new URL('./fixtures/lock-holder-child.ts', import.meta.url).pathname

function tempRepositoryHome(): string {
  return mkdtempSync(join(tmpdir(), 'norn-locks-'))
}

/** Resolve once the holder child has printed the given marker. */
async function waitForMarker(child: { stdout: NodeJS.ReadableStream | null }, marker: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let output = ''
    const readable = child.stdout
    if (readable === null) {
      rejectPromise(new Error('no stdout'))
      return
    }
    readable.setEncoding('utf8')
    const data = (chunk: string): void => {
      output += chunk
      if (output.includes(marker)) {
        readable.off('data', data)
        resolvePromise(output)
      }
    }
    readable.on('data', data)
    readable.once('end', () => rejectPromise(new Error(`holder exited before "${marker}": ${output.trim()}`)))
  })
}

/** Acquire with retries until a deadline; auto-release guarantees eventual success. */
async function acquireWithRetry(path: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const outcome = await acquireLock(path)
    if (outcome.kind === 'ok') return outcome.value
    if (Date.now() >= deadline) {
      assert.fail(`lock at ${path} was still held after ${timeoutMs}ms`)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  }
}

describe('map lock: one live coordinator per Task Map', () => {
  it('excludes a second in-process acquisition and re-allows after release', async () => {
    const home = tempRepositoryHome()
    try {
      const first = await acquireMapLock(home, 'I_map')
      assert.ok(first.kind === 'ok')
      const second = await acquireMapLock(home, 'I_map')
      assert.ok(second.kind === 'blocked')
      if (second.kind === 'blocked') assert.equal(second.code, 'lock-held')
      const released = await first.value.release()
      assert.ok(released.kind === 'ok')
      const third = await acquireMapLock(home, 'I_map')
      assert.ok(third.kind === 'ok')
      await third.value.release()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('excludes a second live coordinator in another process', { timeout: 20_000 }, async () => {
    const home = tempRepositoryHome()
    const lockPath = mapLockPath(home, 'I_map')
    let child: ReturnType<typeof spawn> | undefined
    try {
      child = spawn(process.execPath, [CHILD, 'hold', lockPath], { stdio: ['pipe', 'pipe', 'pipe'] })
      await waitForMarker(child, 'acquired')

      const mine = await acquireMapLock(home, 'I_map')
      assert.ok(mine.kind === 'blocked')
      if (mine.kind === 'blocked') assert.equal(mine.code, 'lock-held')

      // Release cleanly: close the child's stdin, wait for its release.
      child.stdin!.end()
      await waitForMarker(child, 'released ok')
      const next = await acquireMapLock(home, 'I_map')
      assert.ok(next.kind === 'ok')
      await next.value.release()
    } finally {
      child?.kill('SIGKILL')
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('auto-releases when the owning process is killed', { timeout: 20_000 }, async () => {
    const home = tempRepositoryHome()
    const lockPath = mapLockPath(home, 'I_map')
    let child: ReturnType<typeof spawn> | undefined
    try {
      child = spawn(process.execPath, [CHILD, 'hold', lockPath], { stdio: ['pipe', 'pipe', 'pipe'] })
      await waitForMarker(child, 'acquired')

      const mine = await acquireMapLock(home, 'I_map')
      assert.ok(mine.kind === 'blocked', 'live second coordinator must be excluded')

      child.kill('SIGKILL')
      await new Promise<void>((resolvePromise) => child!.once('exit', () => resolvePromise()))
      child = undefined

      // The kernel closed the holder's pipe; the helper exits and the flock
      // drops without any cleanup action from the killed coordinator.
      const reacquired = await acquireWithRetry(lockPath, 5_000)
      await reacquired.release()
    } finally {
      child?.kill('SIGKILL')
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('is never left held by spawned child processes', { timeout: 20_000 }, async () => {
    const home = tempRepositoryHome()
    const lockPath = mapLockPath(home, 'I_map')
    let child: ReturnType<typeof spawn> | undefined
    let heirPgid: number | undefined
    try {
      child = spawn(process.execPath, [CHILD, 'spawn-heir', lockPath], { stdio: ['ignore', 'pipe', 'pipe'] })
      const output = await waitForMarker(child, 'spawned')
      heirPgid = Number(/spawned (\d+)/.exec(output)?.[1])
      // The coordinator exits on its own without releasing; the spawned heir
      // (a detached `sleep` process group) keeps running.
      await new Promise<void>((resolvePromise) => child!.once('exit', () => resolvePromise()))
      child = undefined
      assert.ok(isProcessGroupAlive(heirPgid), 'the heir process group is still alive')

      // The lock must be free even though the heir lives on: children never
      // hold or inherit the coordinator's lock.
      const reacquired = await acquireWithRetry(lockPath, 5_000)
      await reacquired.release()
    } finally {
      if (heirPgid !== undefined) await terminateProcessGroup(heirPgid, { graceMs: 100, killWaitMs: 2_000 })
      child?.kill('SIGKILL')
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('map lock probe', () => {
  it('reports not held when no lock file exists, creating nothing', async () => {
    const home = tempRepositoryHome()
    try {
      assert.equal(await isMapLockHeld(home, 'I_map'), false)
      assert.equal(existsSync(locksDir(home)), false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('reports held while a live coordinator holds the lock, free after it exits', { timeout: 20_000 }, async () => {
    const home = tempRepositoryHome()
    const lockPath = mapLockPath(home, 'I_map')
    let child: ReturnType<typeof spawn> | undefined
    try {
      child = spawn(process.execPath, [CHILD, 'hold', lockPath], { stdio: ['pipe', 'pipe', 'pipe'] })
      await waitForMarker(child, 'acquired')
      assert.equal(await isMapLockHeld(home, 'I_map'), true)

      child.kill('SIGKILL')
      await new Promise<void>((resolvePromise) => child!.once('exit', () => resolvePromise()))
      child = undefined

      const deadline = Date.now() + 5_000
      while (await isMapLockHeld(home, 'I_map')) {
        if (Date.now() >= deadline) assert.fail('lock still reported held after holder death')
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
      }
    } finally {
      child?.kill('SIGKILL')
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('control lock and target lock', () => {
  it('the control lock is short-held and re-acquirable after release', async () => {
    const home = tempRepositoryHome()
    try {
      const first = await acquireControlLock(home)
      assert.ok(first.kind === 'ok')
      const released = await first.value.release()
      assert.ok(released.kind === 'ok')
      const second = await acquireControlLock(home)
      assert.ok(second.kind === 'ok')
      await second.value.release()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('the target lock is per repository and branch', async () => {
    const home = tempRepositoryHome()
    try {
      const main = await acquireTargetLock(home, 'main')
      assert.ok(main.kind === 'ok')
      const develop = await acquireTargetLock(home, 'develop')
      assert.ok(develop.kind === 'ok', 'a different branch is a different lock')
      const mainAgain = await acquireTargetLock(home, 'main')
      assert.ok(mainAgain.kind === 'blocked')
      await develop.value.release()
      await main.value.release()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('lock file placement', () => {
  it('creates every lock file under repository home, never in the working tree', async () => {
    const home = tempRepositoryHome()
    const workingTree = mkdtempSync(join(tmpdir(), 'norn-target-tree-'))
    try {
      const map = await acquireMapLock(home, 'I_map')
      assert.ok(map.kind === 'ok')
      const target = await acquireTargetLock(home, 'main')
      assert.ok(target.kind === 'ok')
      const control = await acquireControlLock(home)
      assert.ok(control.kind === 'ok')

      assert.equal(existsSync(mapLockPath(home, 'I_map')), true)
      assert.equal(existsSync(targetLockPath(home, 'main')), true)
      assert.equal(existsSync(controlLockPath(home)), true)
      assert.deepEqual(readdirSync(locksDir(home)).sort(), [
        'control.lock',
        'map-I_map.lock',
        'target-main.lock',
      ])
      // The target working tree stays untouched.
      assert.deepEqual(readdirSync(workingTree), [])

      await map.value.release()
      await target.value.release()
      await control.value.release()
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(workingTree, { recursive: true, force: true })
    }
  })
})
