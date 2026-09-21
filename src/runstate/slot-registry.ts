/**
 * The repository-wide Work-slot registry (design.md §8, §16).
 *
 * One atomic document under `<repository-home>/locks/work-slots.json` holds
 * every live Work reservation across all active maps, with one authoritative
 * capacity value (concurrent runs share one `configRevision`, hence one
 * `concurrency`). Because Run State and the registry are separate documents,
 * slot acquisition uses a crash-safe handshake rather than a multi-file
 * transaction:
 *
 *   1. the coordinator persists a Work attempt with slot
 *      `awaiting-reservation` in Run State;
 *   2. under the repository control lock the registry reserves the attempt's
 *      unique ID;
 *   3. the coordinator persists `reserved`;
 *   4. only then is a child launched.
 *
 * A reservation stays charged until its attempt outcome is persisted and
 * reconciliation proves every recorded child process group has exited or been
 * terminated: release reads the recorded process-group checkpoints from the
 * persisted Run State and probes each one. A reservation whose recorded
 * groups are still live is refused; a reservation that no run state records
 * at all is releasable because launch intent is always persisted before
 * process creation, so an unrecorded attempt can own no live child.
 */
import { readFileSync } from 'node:fs'

import { blocked, error, ok } from '../core/outcome.ts'
import type { Outcome } from '../core/outcome.ts'
import { decodeLocalProcessHandle } from '../agents/local-runner.ts'
import { isProcessGroupAlive } from '../agents/process-group.ts'
import { workSlotRegistryPath } from '../config/paths.ts'
import { writeDocumentAtomic } from './atomic-write.ts'
import { acquireControlLock } from './locks.ts'
import type { LockBlockCode, LockErrorCode } from './locks.ts'
import { loadRunState } from './run-state-store.ts'
import type { ProcessGroupCheckpoint, RunState } from './types.ts'

export const WORK_SLOT_REGISTRY_SCHEMA = 'norn-slot-registry:v1' as const

/** One live Work reservation, bound to a recorded Work attempt (§16). */
export type WorkSlotReservation = {
  readonly runId: string
  readonly encodedMapIssueId: string
  readonly workAttemptId: string
}

export type WorkSlotRegistry = {
  readonly schema: typeof WORK_SLOT_REGISTRY_SCHEMA
  readonly capacity: number
  readonly reserved: readonly WorkSlotReservation[]
}

export type SlotRegistryErrorCode = 'slot-registry' | 'lock-failed'
export type SlotRegistryBlockCode = LockBlockCode | 'process-groups-live'

export type ReserveOutcome = Outcome<
  { readonly reserved: boolean },
  SlotRegistryBlockCode,
  SlotRegistryErrorCode
>
export type ReleaseOutcome = Outcome<void, SlotRegistryBlockCode, SlotRegistryErrorCode>

/**
 * Probe whether one recorded process group is provably settled. The default
 * decodes built-in local-process handles into POSIX process-group IDs; any
 * other adapter handle cannot be proven settled offline and counts as live.
 * Production callers with a live adapter inject an adapter-aware prober.
 */
export type ProcessGroupLivenessProbe = (checkpoint: ProcessGroupCheckpoint) => boolean

export function defaultProcessGroupLivenessProbe(checkpoint: ProcessGroupCheckpoint): boolean {
  try {
    const pgid = decodeLocalProcessHandle(checkpoint.adapterHandle)
    return isProcessGroupAlive(pgid)
  } catch {
    // Unknown handle format: settlement is not provable, so the group counts
    // as live and the reservation stays charged.
    return true
  }
}

// ---------------------------------------------------------------------------
// Registry document I/O
// ---------------------------------------------------------------------------

function registryToJson(registry: WorkSlotRegistry): string {
  return `${JSON.stringify(registry, null, 2)}\n`
}

function parseRegistry(
  text: string,
  violations: string[],
  options: { readonly requireCapacity?: number },
): WorkSlotRegistry | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    violations.push(`work-slots.json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    violations.push('work-slots.json must contain a JSON object')
    return undefined
  }
  const candidate = parsed as Record<string, unknown>
  if (candidate.schema !== WORK_SLOT_REGISTRY_SCHEMA) {
    violations.push(`work-slots.json schema must be "${WORK_SLOT_REGISTRY_SCHEMA}"`)
    return undefined
  }
  if (
    typeof candidate.capacity !== 'number' ||
    !Number.isInteger(candidate.capacity) ||
    candidate.capacity < 1
  ) {
    violations.push('work-slots.json capacity must be an integer >= 1')
    return undefined
  }
  if (options.requireCapacity !== undefined && candidate.capacity !== options.requireCapacity) {
    violations.push(
      `work-slots.json capacity ${candidate.capacity} does not match this run's concurrency ${options.requireCapacity}` +
        ' (concurrent runs must share one configRevision)',
    )
    return undefined
  }
  if (!Array.isArray(candidate.reserved)) {
    violations.push('work-slots.json reserved must be an array')
    return undefined
  }
  const seen = new Set<string>()
  const entries: WorkSlotReservation[] = []
  candidate.reserved.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      violations.push(`work-slots.json reserved[${index}] must be an object`)
      return
    }
    const record = entry as Record<string, unknown>
    if (
      typeof record.runId !== 'string' || record.runId === '' ||
      typeof record.encodedMapIssueId !== 'string' || record.encodedMapIssueId === '' ||
      typeof record.workAttemptId !== 'string' || record.workAttemptId === ''
    ) {
      violations.push(`work-slots.json reserved[${index}] must carry non-empty run, map, and attempt IDs`)
      return
    }
    if (seen.has(record.workAttemptId)) {
      violations.push(`work-slots.json reserves "${record.workAttemptId}" more than once`)
      return
    }
    seen.add(record.workAttemptId)
    entries.push({
      runId: record.runId,
      encodedMapIssueId: record.encodedMapIssueId,
      workAttemptId: record.workAttemptId,
    })
  })
  if (entries.length > candidate.capacity) {
    violations.push(`work-slots.json reserves ${entries.length} slots beyond capacity ${candidate.capacity}`)
    return undefined
  }
  return { schema: WORK_SLOT_REGISTRY_SCHEMA, capacity: candidate.capacity, reserved: entries }
}

/**
 * Read the registry document. `ok(undefined)` when no registry exists yet.
 * `requireCapacity` cross-checks the one authoritative capacity value (§8).
 */
export function readWorkSlotRegistry(
  repositoryHome: string,
  options: { readonly requireCapacity?: number } = {},
): Outcome<WorkSlotRegistry | undefined, never, 'slot-registry'> {
  let text: string
  try {
    text = readFileSync(workSlotRegistryPath(repositoryHome), 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ok(undefined)
    return slotRegistryError('reading the registry', cause)
  }
  const violations: string[] = []
  const registry = parseRegistry(text, violations, options)
  if (registry === undefined) {
    return slotRegistryError('reading the registry', new Error(violations.join('; ')))
  }
  return ok(registry)
}

function writeRegistry(repositoryHome: string, registry: WorkSlotRegistry): Outcome<void, never, 'slot-registry'> {
  try {
    writeDocumentAtomic(workSlotRegistryPath(repositoryHome), registryToJson(registry))
    return ok(undefined)
  } catch (cause) {
    return slotRegistryError('writing the registry', cause)
  }
}

function slotRegistryError(what: string, cause?: unknown): Outcome<never, never, 'slot-registry'> {
  const detail = cause === undefined ? '' : `: ${cause instanceof Error ? cause.message : String(cause)}`
  return error({
    scope: 'operation',
    code: 'slot-registry',
    reason: `the Work-slot registry failed while ${what}${detail}`,
  })
}

// ---------------------------------------------------------------------------
// The persisted handshake (§16)
// ---------------------------------------------------------------------------

/**
 * Reserve one Work slot for `reservation` under the repository control lock
 * (§16). Idempotent for the same `workAttemptId` — recovery may reacquire an
 * `awaiting-reservation` attempt's own reservation before launch. Returns
 * `reserved: false` when the repository-wide capacity is fully charged; the
 * caller defers or delays Work.
 *
 * Callers must not already hold the control lock; this function takes it.
 */
export async function reserveWorkSlot(
  repositoryHome: string,
  reservation: WorkSlotReservation,
  capacity: number,
): Promise<ReserveOutcome> {
  const lock = await acquireControlLock(repositoryHome)
  if (lock.kind !== 'ok') return lock

  try {
    const existing = await readWorkSlotRegistry(repositoryHome, { requireCapacity: capacity })
    if (existing.kind !== 'ok') return existing
    const registry = existing.value ?? {
      schema: WORK_SLOT_REGISTRY_SCHEMA,
      capacity,
      reserved: [] as WorkSlotReservation[],
    }

    if (registry.reserved.some((entry) => entry.workAttemptId === reservation.workAttemptId)) {
      return ok({ reserved: true }) // reacquisition of the attempt's own slot
    }
    if (registry.reserved.length >= registry.capacity) {
      return ok({ reserved: false })
    }
    const written = await writeRegistry(repositoryHome, {
      ...registry,
      reserved: [...registry.reserved, reservation],
    })
    if (written.kind !== 'ok') return written

    // Prove what is on disk before the caller persists `reserved`.
    const reread = await readWorkSlotRegistry(repositoryHome)
    if (reread.kind !== 'ok') return reread
    if (
      reread.value === undefined ||
      !reread.value.reserved.some((entry) => entry.workAttemptId === reservation.workAttemptId)
    ) {
      return slotRegistryError('verifying the reservation', new Error('the reserved attempt is missing after write'))
    }
    return ok({ reserved: true })
  } finally {
    await lock.value.release()
  }
}

/**
 * Release one Work reservation (§16). The reservation stays charged until
 * reconciliation proves settlement: the persisted Run State for the
 * reservation's map is loaded, every process-group checkpoint recorded for
 * the attempt is probed, and only when all are provably settled is the
 * reservation removed. A reservation no run state records at all is
 * releasable — launch intent is persisted before process creation, so an
 * unrecorded attempt owns no live child. `blocked(process-groups-live)`
 * means at least one recorded group is still live; the caller settles it and
 * retries.
 *
 * Callers must not already hold the control lock; this function takes it.
 */
export async function releaseWorkSlot(
  repositoryHome: string,
  workAttemptId: string,
  options: { readonly probe?: ProcessGroupLivenessProbe } = {},
): Promise<ReleaseOutcome> {
  const probe = options.probe ?? defaultProcessGroupLivenessProbe
  const lock = await acquireControlLock(repositoryHome)
  if (lock.kind !== 'ok') return lock

  try {
    const existing = await readWorkSlotRegistry(repositoryHome)
    if (existing.kind !== 'ok') return existing
    if (existing.value === undefined) return ok(undefined) // nothing reserved
    const registry = existing.value

    const reservation = registry.reserved.find((entry) => entry.workAttemptId === workAttemptId)
    if (reservation === undefined) return ok(undefined) // idempotent release

    const settlement = proveSettlement(repositoryHome, reservation, probe)
    if (settlement.kind !== 'ok') return settlement

    return writeRegistry(repositoryHome, {
      ...registry,
      reserved: registry.reserved.filter((entry) => entry.workAttemptId !== workAttemptId),
    })
  } finally {
    await lock.value.release()
  }
}

/**
 * Establish the settlement proof for one reservation from the persisted Run
 * State: collect every process-group checkpoint recorded for the attempt and
 * require every one to be provably settled.
 */
function proveSettlement(
  repositoryHome: string,
  reservation: WorkSlotReservation,
  probe: ProcessGroupLivenessProbe,
): Outcome<void, 'process-groups-live', 'slot-registry'> {
  const state = loadRunState(repositoryHome, reservation.encodedMapIssueId)
  if (state.kind !== 'ok') {
    return slotRegistryError(
      `reading the recorded run state for map ${reservation.encodedMapIssueId} during settlement`,
    )
  }
  if (state.value === undefined) {
    // No run state records the attempt: by the write-ahead rule a persisted
    // launch intent precedes every child, so nothing can be live for it.
    return ok(undefined)
  }

  const live = collectAttemptCheckpoints(state.value, reservation.workAttemptId).filter((checkpoint) =>
    probe(checkpoint),
  )
  if (live.length > 0) {
    return blocked({
      scope: 'operation',
      code: 'process-groups-live',
      reason:
        `recorded process group(s) for attempt ${reservation.workAttemptId} are still live: ` +
        live.map((entry) => entry.id).join(', '),
      evidence: [{ liveProcessGroupIds: live.map((entry) => entry.id) }],
    })
  }
  return ok(undefined)
}

/** Every recorded process-group checkpoint belonging to one Work attempt. */
export function collectAttemptCheckpoints(
  state: RunState,
  workAttemptId: string,
): readonly ProcessGroupCheckpoint[] {
  const recorded = new Map<string, ProcessGroupCheckpoint>()
  for (const checkpoint of state.activeProcesses) {
    if (checkpoint.workAttemptId === workAttemptId) {
      recorded.set(checkpoint.id, checkpoint)
    }
  }
  for (const ticket of Object.values(state.tickets)) {
    if (ticket.phase !== 'working') continue
    if (ticket.attempt.workAttemptId !== workAttemptId) continue
    for (const groupId of ticket.attempt.processGroupIds) {
      const checkpoint = state.activeProcesses.find((entry) => entry.id === groupId)
      if (checkpoint !== undefined) recorded.set(groupId, checkpoint)
    }
  }
  return [...recorded.values()]
}
