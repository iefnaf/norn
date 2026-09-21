/**
 * Deterministic local-process adapter for the Visible Agent Runner seam.
 *
 * Spawns the agent invocation as the leader of a detached POSIX process group
 * and manages it purely through group signals and group liveness probes. The
 * same settlement engine that governs Herdr launches governs these, so tests
 * run headless against plain node scripts while production opens visible
 * panes — the protocol is identical.
 */
import type { ChildProcess } from 'node:child_process'

import {
  isProcessGroupAlive,
  spawnProcessGroup,
  terminateProcessGroup,
  waitForProcessGroupExit,
} from './process-group.ts'
import type { AgentLaunchRequest, AttachedAgentProcess, VisibleAgentRunner } from './runner.ts'

export const LOCAL_PROCESS_ADAPTER = 'local-process' as const

/** Handle encoding: stable JSON so a recovered coordinator can reattach. */
export function encodeLocalProcessHandle(pgid: number): string {
  return JSON.stringify({ adapter: LOCAL_PROCESS_ADAPTER, pgid })
}

export function decodeLocalProcessHandle(adapterHandle: string): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(adapterHandle)
  } catch {
    throw new Error(`malformed local-process adapter handle: ${adapterHandle}`)
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { adapter?: unknown }).adapter !== LOCAL_PROCESS_ADAPTER ||
    typeof (parsed as { pgid?: unknown }).pgid !== 'number'
  ) {
    throw new Error(`malformed local-process adapter handle: ${adapterHandle}`)
  }
  return (parsed as { pgid: number }).pgid
}

/** Environment every child gets: an allowlist, never a copy of the coordinator's. */
export function childEnvironment(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const base: Record<string, string> = {}
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    const value = process.env[name]
    if (value !== undefined) base[name] = value
  }
  return { ...base, ...extra }
}

export class LocalProcessAgentRunner implements VisibleAgentRunner {
  readonly kind = LOCAL_PROCESS_ADAPTER

  /**
   * Spawned leaders stay referenced so Node keeps reaping them; a dropped
   * `ChildProcess` could leave an unreaped zombie whose pid keeps the process
   * group looking alive to `kill(-pgid, 0)`.
   */
  private readonly children = new Map<number, ChildProcess>()

  async launch(request: AgentLaunchRequest): Promise<AttachedAgentProcess> {
    const child = await spawnProcessGroup(request.argv, {
      cwd: request.cwd,
      env: childEnvironment(request.env),
    })
    const pgid = child.pid as number
    this.children.set(pgid, child)
    child.once('exit', () => this.children.delete(pgid))
    return { kind: this.kind, adapterHandle: encodeLocalProcessHandle(pgid) }
  }

  attach(adapterHandle: string): AttachedAgentProcess {
    decodeLocalProcessHandle(adapterHandle)
    return { kind: this.kind, adapterHandle }
  }

  async isLive(processRef: AttachedAgentProcess): Promise<boolean> {
    return isProcessGroupAlive(decodeLocalProcessHandle(processRef.adapterHandle))
  }

  async waitForExit(
    processRef: AttachedAgentProcess,
    timeoutMs: number,
  ): Promise<'exited' | 'timeout'> {
    const exited = await waitForProcessGroupExit(decodeLocalProcessHandle(processRef.adapterHandle), {
      timeoutMs,
    })
    return exited ? 'exited' : 'timeout'
  }

  async terminate(processRef: AttachedAgentProcess): Promise<'terminated' | 'terminate-failed'> {
    return terminateProcessGroup(decodeLocalProcessHandle(processRef.adapterHandle))
  }
}
