import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { canonicalJsonDigest } from '../src/core/digest.ts'
import { parseIssueUrl } from '../src/map/issue-url.ts'
import { computeMapRevision, computeTicketRevision } from '../src/core/revision.ts'
import { isBlocked, isOk } from '../src/core/outcome.ts'
import { REPOSITORY_METADATA_SCHEMA } from '../src/control/control-store.ts'
import { mapLockPath } from '../src/config/paths.ts'
import { renderStatusOutcome, renderStatusTakesMapUrl } from '../src/extension/render.ts'
import { executeStatusCommand } from '../src/extension/status-command.ts'
import { readStatus } from '../src/runner/status.ts'
import type { RunState } from '../src/runstate/types.ts'
import { saveRunState } from '../src/runstate/run-state-store.ts'

const LOCK_CHILD = new URL('./fixtures/lock-holder-child.ts', import.meta.url).pathname
const HOST = 'github.com'
const REPOSITORY_ID = 'R_kgDOB123'
const MAP_ISSUE_ID = 'I_map'
const MAP_URL = 'https://github.com/iefnaf/norn/issues/6'

describe('parseIssueUrl', () => {
  it('accepts the exact full-issue-URL form', () => {
    assert.deepEqual(parseIssueUrl('https://github.com/iefnaf/norn/issues/6'), {
      githubHost: 'github.com',
      owner: 'iefnaf',
      name: 'norn',
      number: 6,
    })
    assert.deepEqual(parseIssueUrl('https://GITHUB.COM/IEFnaf/Norn/issues/1234'), {
      githubHost: 'github.com',
      owner: 'IEFnaf',
      name: 'Norn',
      number: 1234,
    })
    assert.deepEqual(parseIssueUrl('https://ghe.internal:8443/o/r/issues/7'), {
      githubHost: 'ghe.internal:8443',
      owner: 'o',
      name: 'r',
      number: 7,
    })
  })

  it('rejects shorthand and malformed forms', () => {
    assert.equal(parseIssueUrl('#123'), undefined)
    assert.equal(parseIssueUrl('123'), undefined)
    assert.equal(parseIssueUrl(''), undefined)
    assert.equal(parseIssueUrl('https://github.com/iefnaf/norn/issues/6 extra'), undefined)
    assert.equal(parseIssueUrl('http://github.com/iefnaf/norn/issues/6'), undefined)
    assert.equal(parseIssueUrl('https://github.com/iefnaf/norn/pull/6'), undefined)
    assert.equal(parseIssueUrl('https://github.com/iefnaf/norn/issues/6/files'), undefined)
    assert.equal(parseIssueUrl('https://github.com/iefnaf/norn/issues/abc'), undefined)
    assert.equal(parseIssueUrl('https://github.com/iefnaf/norn/issues/0'), undefined)
    assert.equal(parseIssueUrl('https://github.com/iefnaf/norn/issues/6?x=1'), undefined)
    assert.equal(parseIssueUrl('https://github.com/iefnaf/norn/issues/6#fragment'), undefined)
    assert.equal(parseIssueUrl('not a url at all'), undefined)
  })
})

function ticketRevision(issueId: string): string {
  return computeTicketRevision({
    githubHost: HOST,
    repositoryId: REPOSITORY_ID,
    ticketIssueId: issueId,
    title: `Ticket ${issueId}`,
    body: null,
  }).revision
}

function exampleRunState(): RunState {
  const map = computeMapRevision({
    githubHost: HOST,
    repositoryId: REPOSITORY_ID,
    mapIssueId: MAP_ISSUE_ID,
    title: 'Example map',
    body: null,
    members: [
      { ticketIssueId: 'I_A', ticketRevision: ticketRevision('I_A') },
      { ticketIssueId: 'I_B', ticketRevision: ticketRevision('I_B') },
    ],
    dependencies: [{ blockerIssueId: 'I_A', blockedIssueId: 'I_B' }],
  })
  return {
    schema: 'norn-run-state:v1',
    runId: 'run-42',
    map: {
      role: 'map',
      githubHost: HOST,
      repositoryId: REPOSITORY_ID,
      issueId: MAP_ISSUE_ID,
      number: 6,
      url: MAP_URL,
    },
    acceptedMapRevisions: [{ revision: map.revision, payload: map.payload }],
    configRevision: canonicalJsonDigest({ config: 1 }),
    nornVersion: '0.1.0',
    status: 'running',
    wave: 2,
    activeWave: {
      number: 2,
      mapRevision: map.revision,
      target: {
        branch: 'main',
        baseSha: 'sha1:' + '1'.repeat(40),
        baseTreeOid: 'sha1:' + '2'.repeat(40),
      },
      frontierTicketIssueIds: ['I_A'],
      shipQueueTicketIssueIds: ['I_A'],
      nextShipIndex: 0,
    },
    parkedTickets: [],
    tickets: {
      I_A: { phase: 'waiting', wave: 1 },
      I_B: { phase: 'waiting' },
    },
    activeProcesses: [],
  } as unknown as RunState
}

/** A Norn home with an initialized repository and an optional run state. */
function setupNornHome(options: { readonly withRunState: boolean }): string {
  const nornHome = mkdtempSync(join(tmpdir(), 'norn-status-home-'))
  const home = join(nornHome, 'repositories', 'github.com', REPOSITORY_ID)
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'metadata.json'),
    `${JSON.stringify(
      {
        schema: REPOSITORY_METADATA_SCHEMA,
        githubHost: HOST,
        repositoryId: REPOSITORY_ID,
        owner: 'iefnaf',
        name: 'norn',
        defaultBranch: 'main',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  if (options.withRunState) {
    const saved = saveRunState(home, MAP_ISSUE_ID, exampleRunState())
    if (saved.kind !== 'ok') throw new Error(saved.reason)
  }
  return nornHome
}

describe('readStatus', () => {
  it('reports the persisted facts without creating or mutating anything', async () => {
    const nornHome = setupNornHome({ withRunState: true })
    try {
      const before = readdirSnapshot(nornHome)
      const outcome = await readStatus({ nornHome }, MAP_URL)
      assert.ok(isOk(outcome), outcome.kind === 'error' ? outcome.reason : '')
      if (outcome.kind !== 'ok') return
      assert.equal(outcome.value.repositoryHome, join(nornHome, 'repositories', 'github.com', REPOSITORY_ID))
      assert.equal(outcome.value.runState?.runId, 'run-42')
      assert.equal(outcome.value.runState?.status, 'running')
      assert.equal(outcome.value.runState?.wave, 2)
      assert.equal(outcome.value.mapLockHeldByLiveCoordinator, false)
      assert.deepEqual(readdirSnapshot(nornHome), before)
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
    }
  })

  it('blocks an invalid map URL without touching Norn home', async () => {
    const nornHome = setupNornHome({ withRunState: false })
    try {
      const outcome = await readStatus({ nornHome }, '#6')
      assert.ok(isBlocked(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'invalid-map-url')
        assert.equal(outcome.scope, 'operation')
      }
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
    }
  })

  it('blocks when no repository home is initialized for the URL', async () => {
    const nornHome = setupNornHome({ withRunState: false })
    try {
      const outcome = await readStatus({ nornHome }, 'https://github.com/other/repo/issues/6')
      assert.ok(isBlocked(outcome))
      if (outcome.kind === 'blocked') {
        assert.equal(outcome.code, 'no-repository-home')
        assert.match(outcome.reason, /\/norn init/)
      }
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
    }
  })

  it('blocks when repository metadata is ambiguous', async () => {
    const nornHome = setupNornHome({ withRunState: false })
    try {
      const duplicate = join(nornHome, 'repositories', 'github.com', 'R_other')
      mkdirSync(duplicate, { recursive: true })
      writeFileSync(
        join(duplicate, 'metadata.json'),
        `${JSON.stringify({
          schema: REPOSITORY_METADATA_SCHEMA,
          githubHost: HOST,
          repositoryId: 'R_other',
          owner: 'iefnaf',
          name: 'norn',
          defaultBranch: 'main',
        })}\n`,
        'utf8',
      )
      const outcome = await readStatus({ nornHome }, MAP_URL)
      assert.ok(isBlocked(outcome))
      if (outcome.kind === 'blocked') assert.equal(outcome.code, 'ambiguous-repository-home')
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
    }
  })

  it('reports no run state when none exists for the map', async () => {
    const nornHome = setupNornHome({ withRunState: false })
    try {
      const outcome = await readStatus({ nornHome }, MAP_URL)
      assert.ok(isOk(outcome))
      if (outcome.kind === 'ok') {
        assert.equal(outcome.value.runState, undefined)
        assert.equal(outcome.value.mapLockHeldByLiveCoordinator, false)
      }
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
    }
  })

  it('surfaces an aborted run with its retained state and no report (§2.3, #16)', async () => {
    const nornHome = setupNornHome({ withRunState: true })
    try {
      // The operator aborted run-42: status reports the retained lifecycle
      // decision — never a terminal report, never a resume or mutation.
      const home = join(nornHome, 'repositories', 'github.com', REPOSITORY_ID)
      const aborted = { ...exampleRunState(), status: 'aborted' as const }
      const saved = saveRunState(home, MAP_ISSUE_ID, aborted)
      assert.equal(saved.kind, 'ok')

      const outcome = await readStatus({ nornHome }, MAP_URL)
      assert.ok(isOk(outcome))
      if (outcome.kind !== 'ok') return
      assert.equal(outcome.value.runState?.runId, 'run-42')
      assert.equal(outcome.value.runState?.status, 'aborted')
      assert.equal(outcome.value.runState?.report, undefined)

      const rendered = renderStatusOutcome(outcome)
      assert.match(rendered, /Run: run-42 — aborted/)
      assert.match(rendered, /Terminal report: none yet/)
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
    }
  })

  it('reports ownership while a live coordinator holds the map lock, then release', { timeout: 20_000 }, async () => {
    const nornHome = setupNornHome({ withRunState: true })
    const home = join(nornHome, 'repositories', 'github.com', REPOSITORY_ID)
    const lockPath = mapLockPath(home, MAP_ISSUE_ID)
    let child: ReturnType<typeof spawn> | undefined
    try {
      child = spawn(process.execPath, [LOCK_CHILD, 'hold', lockPath], { stdio: ['pipe', 'pipe', 'pipe'] })
      await new Promise<void>((resolvePromise, rejectPromise) => {
        let output = ''
        child!.stdout!.setEncoding('utf8')
        child!.stdout!.on('data', (chunk: string) => {
          output += chunk
          if (output.includes('acquired')) resolvePromise()
        })
        child!.stdout!.once('end', () => rejectPromise(new Error(`holder exited early: ${output.trim()}`)))
        child!.once('exit', () => rejectPromise(new Error(`holder exited early: ${output.trim()}`)))
      })

      const outcome = await readStatus({ nornHome }, MAP_URL)
      assert.ok(isOk(outcome))
      if (outcome.kind === 'ok') {
        assert.equal(outcome.value.mapLockHeldByLiveCoordinator, true)
        assert.equal(outcome.value.runState?.runId, 'run-42')
      }

      child.stdin!.end()
      await new Promise<void>((resolvePromise) => child!.once('exit', () => resolvePromise()))
      child = undefined
      const after = await readStatus({ nornHome }, MAP_URL)
      assert.ok(isOk(after))
      if (after.kind === 'ok') assert.equal(after.value.mapLockHeldByLiveCoordinator, false)
    } finally {
      child?.kill('SIGKILL')
      rmSync(nornHome, { recursive: true, force: true })
    }
  })
})

function readdirSnapshot(root: string): string[] {
  const entries: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      entries.push(path.slice(root.length))
      if (entry.isDirectory()) walk(path)
    }
  }
  if (existsSync(root)) walk(root)
  return entries.sort()
}

describe('renderStatusOutcome', () => {
  it('renders persisted facts with an explicit local-truth separation line', async () => {
    const nornHome = setupNornHome({ withRunState: true })
    try {
      const outcome = await readStatus({ nornHome }, MAP_URL)
      assert.ok(isOk(outcome))
      const text = renderStatusOutcome(outcome)
      assert.match(text, /Norn status — github\.com\/iefnaf\/norn#6/)
      assert.match(text, /Local truth only/)
      assert.match(text, /not consulted/)
      assert.match(text, /Map lock: not held/)
      assert.match(text, /Run: run-42 — running/)
      assert.match(text, /Current Wave: 2/)
      assert.match(text, /ship queue: I_A/)
      assert.match(text, /Tickets \(2\)/)
      assert.match(text, /I_A: waiting/)
      assert.match(text, /Terminal report: none yet/)
      assert.match(text, /Retained workspace: none/)
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
    }
  })

  it('renders the no-run-state case and blocked outcomes', async () => {
    const nornHome = setupNornHome({ withRunState: false })
    try {
      const none = await readStatus({ nornHome }, MAP_URL)
      assert.ok(isOk(none))
      assert.match(renderStatusOutcome(none), /Run State: none exists for this map/)

      const blockedOutcome = await readStatus({ nornHome }, 'nope')
      assert.ok(isBlocked(blockedOutcome))
      const text = renderStatusOutcome(blockedOutcome)
      assert.match(text, /Norn status blocked \(invalid-map-url\)/)
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
    }
  })

  it('renders a pending in-run rework on its waiting ticket', async () => {
    const nornHome = setupNornHome({ withRunState: false })
    try {
      const state = exampleRunState() as unknown as Record<string, unknown>
      state.reworks = {
        I_A: {
          cycles: 1,
          conflict: {
            code: 'integration-conflict',
            reason: 'the candidate conflicts when replayed onto the advanced target',
            evidence: [{ conflictedPaths: ['shared.txt'] }],
          },
        },
      }
      const home = join(nornHome, 'repositories', 'github.com', REPOSITORY_ID)
      const saved = saveRunState(home, MAP_ISSUE_ID, state as unknown as RunState)
      assert.ok(saved.kind === 'ok', saved.kind === 'error' ? saved.reason : '')
      const outcome = await readStatus({ nornHome }, MAP_URL)
      assert.ok(isOk(outcome))
      assert.match(
        renderStatusOutcome(outcome),
        /I_A: waiting \(last wave 1\) — rework 1 pending after integration-conflict/,
      )
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
    }
  })

  it('renders a terminal report with its label and retained workspace', async () => {
    const nornHome = setupNornHome({ withRunState: false })
    try {
      const state = exampleRunState() as unknown as Record<string, unknown>
      const home = join(nornHome, 'repositories', 'github.com', REPOSITORY_ID)
      const mapRevision = (state.acceptedMapRevisions as Array<{ revision: string }>)[0]!.revision
      state.status = 'terminal'
      state.report = {
        label: 'blocked',
        code: 'changed-input',
        runId: 'run-42',
        initialMapRevision: mapRevision,
        finalMapRevision: mapRevision,
        acceptedExtensions: [],
        tickets: [],
        sharedWrite: 'confirmed',
        warnings: ['workspace cleanup failed'],
        retainedWorkspace: {
          kind: 'ticket',
          repositoryId: REPOSITORY_ID,
          runId: 'run-42',
          path: '/norn/runs/run-42/workspaces/7/wa-1',
          branch: 'norn/run-42/7/wa-1',
          workAttemptId: 'wa-1',
        },
      }
      const saved = saveRunState(home, MAP_ISSUE_ID, state as unknown as RunState)
      assert.ok(saved.kind === 'ok', saved.kind === 'error' ? saved.reason : '')
      const outcome = await readStatus({ nornHome }, MAP_URL)
      assert.ok(isOk(outcome))
      const text = renderStatusOutcome(outcome)
      assert.match(text, /Run: run-42 — terminal/)
      assert.match(text, /Terminal report: blocked \(changed-input\) · sharedWrite confirmed/)
      assert.match(text, /Retained workspace: \/norn\/runs\/run-42\/workspaces\/7\/wa-1/)
      assert.match(text, /Warnings: workspace cleanup failed/)
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
    }
  })
})

describe('executeStatusCommand', () => {
  function notifyCapture() {
    const notifications: Array<{ message: string; level: string }> = []
    return {
      notifications,
      ui: {
        notify(message: string, level?: 'info' | 'warning' | 'error') {
          notifications.push({ message, level: level ?? 'info' })
        },
      },
    }
  }

  it('renders the runner outcome through the extension seam', async () => {
    const nornHome = setupNornHome({ withRunState: true })
    try {
      const { notifications, ui } = notifyCapture()
      await executeStatusCommand(MAP_URL, ui, { nornHome })
      assert.equal(notifications.length, 1)
      assert.equal(notifications[0]!.level, 'info')
      assert.match(notifications[0]!.message, /run-42/)
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
    }
  })

  it('renders blocked outcomes as warnings', async () => {
    const nornHome = mkdtempSync(join(tmpdir(), 'norn-status-empty-'))
    try {
      const { notifications, ui } = notifyCapture()
      await executeStatusCommand(MAP_URL, ui, { nornHome })
      assert.equal(notifications[0]!.level, 'warning')
      assert.match(notifications[0]!.message, /no-repository-home/)
    } finally {
      rmSync(nornHome, { recursive: true, force: true })
    }
  })
})

describe('renderStatusTakesMapUrl', () => {
  it('explains the accepted invocation shape', () => {
    const text = renderStatusTakesMapUrl()
    assert.match(text, /\/norn status takes exactly one/)
    assert.match(text, /issues\/<number>/)
  })
})
