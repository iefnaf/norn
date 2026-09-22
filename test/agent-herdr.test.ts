/**
 * The Herdr production adapter (design.md §6, §17, ticket #8).
 *
 * The pure `plan*` functions are asserted against the exact Herdr 0.9 CLI
 * surface so no Herdr server is needed; the adapter behavior — one tab per
 * invocation, the two-step create-then-start launch with cleanup, liveness,
 * exit waiting, post-settlement release, and terminate — is exercised
 * through an injected fake executor. A live-pane test exists
 * for environments that explicitly opt in with NORN_TEST_HERDR=1 and have
 * the Herdr binary: it drives a real idle Pi pane through launch, liveness,
 * and the timeout→terminate settlement path. CI and machines without Herdr
 * run the fakes only.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  HerdrAgentRunner,
  type HerdrPlan,
  HERDR_SUPPORTED_VERSION_RANGE,
  decodeHerdrHandle,
  encodeHerdrHandle,
  herdrAgentEnvironment,
  herdrAgentName,
  herdrVersionSupported,
  nornAgentContextEnv,
  parseHerdrVersion,
  planAgentPiArgv,
  planHerdrAgentGet,
  planHerdrAgentPrompt,
  planHerdrAgentStart,
  planHerdrAgentWait,
  planHerdrPaneClose,
  planHerdrTabClose,
  planHerdrTabCreate,
  planHerdrTeardown,
  planHerdrVersion,
} from '../src/agents/herdr-runner.ts'
import { canonicalJson } from '../src/core/canonical-json.ts'
import { CompletionStore, agentRecordedAt } from '../src/agents/completion.ts'
import { settleAgentInvocation } from '../src/agents/runner.ts'
import { buildContext, createRunArea } from './helpers/agent-fixtures.ts'

function execRecorder(
  script: Array<{ readonly stdout?: string; readonly reject?: Error }>,
): {
  plans: HerdrPlan[]
  executionTimeouts: Array<number | undefined>
  exec: (plan: HerdrPlan, executionTimeoutMs?: number) => Promise<string>
} {
  const plans: HerdrPlan[] = []
  const executionTimeouts: Array<number | undefined> = []
  let call = 0
  return {
    plans,
    executionTimeouts,
    exec: (plan, executionTimeoutMs) => {
      plans.push(plan)
      executionTimeouts.push(executionTimeoutMs)
      const step = script[Math.min(call, script.length - 1)]
      call += 1
      if (step.reject !== undefined) return Promise.reject(step.reject)
      return Promise.resolve(step.stdout ?? '')
    },
  }
}

const HERDR_VERSION_OK = 'herdr 0.9.0\n'
const TAB_CREATED =
  '{"id":"cli:tab:create","result":{"root_pane":{"cwd":"/ws/att-1","pane_id":"w10:p2"},"tab":{"label":"norn-ag-invocation-1","pane_count":1,"tab_id":"w10:t9"},"type":"tab_created"}}\n'
const TAB_CREATED_NO_PANE =
  '{"id":"cli:tab:create","result":{"tab":{"pane_count":1,"tab_id":"w10:t9"},"type":"tab_created"}}\n'
const AGENT_STARTED =
  '{"id":"cli:agent:start","result":{"agent":{"agent_status":"idle","name":"norn-ag-1","pane_id":"w10:p2"},"argv":["pi"],"type":"agent_started"}}\n'
const AGENT_STARTED_ELSEWHERE =
  '{"id":"cli:agent:start","result":{"agent":{"agent_status":"idle","name":"norn-ag-1","pane_id":"w9:p9"},"argv":["pi"],"type":"agent_started"}}\n'
const AGENT_PROMPTED =
  '{"id":"cli:agent:prompt","result":{"agent":{"agent_status":"working","name":"norn-ag-1","pane_id":"w10:p2"},"type":"agent_prompted"}}\n'
const AGENT_INFO =
  '{"id":"cli:agent:get","result":{"agent":{"agent_status":"working","name":"norn-ag-1","pane_id":"w10:p2"},"type":"agent_info"}}\n'
const AGENT_DONE =
  '{"id":"cli:agent:get","result":{"agent":{"agent_status":"done","name":"norn-ag-1","pane_id":"w10:p2"},"type":"agent_info"}}\n'
const AGENT_GONE =
  '{"error":{"code":"agent_not_found","message":"agent target w10:p2 not found"},"id":"cli:agent:get"}\n'
const AGENT_NOT_RUNNING =
  '{"error":{"code":"agent_not_running","message":"agent is no longer running in the target pane"},"id":"cli:agent:wait"}\n'
const AGENT_WAIT_BLOCKED =
  '{"id":"cli:agent:wait","result":{"agent":{"agent_status":"blocked","name":"norn-ag-1","pane_id":"w10:p2"},"type":"agent_info"}}\n'
const AGENT_WAIT_TIMEOUT =
  '{"error":{"code":"timeout","message":"timed out waiting for agent status"},"id":"cli:agent:wait"}\n'
const PANE_CLOSED = '{"id":"cli:pane:close","result":{"type":"ok"}}\n'
const PANE_CLOSE_FAILED =
  '{"error":{"code":"pane_not_found","message":"pane w10:p2 not found"},"id":"cli:pane:close"}\n'
const TAB_CLOSED = '{"id":"cli:tab:close","result":{"type":"ok"}}\n'
const AGENT_PANE_BUSY =
  '{"error":{"code":"agent_pane_busy","message":"agent target pane w10:p2 is not an available shell"},"id":"cli:agent:start"}\n'
const AGENT_INVOCATION_1_HANDLE = JSON.stringify({
  adapter: 'herdr',
  paneId: 'w10:p2',
  agentName: 'norn-ag-invocation-1',
  tabId: 'w10:t9',
})

describe('herdr CLI plans', () => {
  it('creates a no-focus tab labelled for the invocation with the cwd and environment', () => {
    const plan = planHerdrTabCreate({
      cwd: '/ws/att-1',
      label: 'norn-ag-invocation-1',
      env: [
        { key: 'HTTPS_PROXY', value: 'http://127.0.0.1:7897' },
        { key: 'NORN_AGENT_CONTEXT', value: '{"schema":"…"}' },
      ],
    })

    assert.deepEqual(plan, {
      file: 'herdr',
      args: [
        'tab',
        'create',
        '--cwd',
        '/ws/att-1',
        '--label',
        'norn-ag-invocation-1',
        '--env',
        'HTTPS_PROXY=http://127.0.0.1:7897',
        '--env',
        'NORN_AGENT_CONTEXT={"schema":"…"}',
        '--no-focus',
      ],
    })
  })

  it('closes the owned tab, and keeps closing the pane of a tab-less handle', () => {
    assert.deepEqual(planHerdrTabClose('w10:t9'), {
      file: 'herdr',
      args: ['tab', 'close', 'w10:t9'],
    })
    assert.deepEqual(
      planHerdrTeardown({ paneId: 'w10:p2', agentName: 'norn-ag-1', tabId: 'w10:t9' }),
      planHerdrTabClose('w10:t9'),
    )
    // Handles persisted by the earlier pane-splitting launch carry no tab id.
    assert.deepEqual(
      planHerdrTeardown({ paneId: 'w10:p2', agentName: 'norn-ag-1' }),
      planHerdrPaneClose('w10:p2'),
    )
  })

  it('starts kind pi in the exact pane with only the native Pi argv', () => {
    const plan = planHerdrAgentStart('ag-1', {
      paneId: 'w10:p2',
      argv: ['pi', '--model', 'provider-a/model-x'],
    })

    assert.deepEqual(plan, {
      file: 'herdr',
      args: [
        'agent',
        'start',
        'norn-ag-1',
        '--kind',
        'pi',
        '--pane',
        'w10:p2',
        '--',
        '--model',
        'provider-a/model-x',
      ],
    })
    assert.deepEqual(planHerdrAgentPrompt('w10:p2', 'brief text'), {
      file: 'herdr',
      args: ['agent', 'prompt', 'w10:p2', 'brief text'],
    })
  })

  it('rejects launch argv whose executable is not pi', () => {
    // Herdr 0.9 `agent start` only launches supported agent kinds; the
    // executable comes from `--kind`, never from the argv.
    assert.throws(() => planHerdrAgentStart('ag-1', { paneId: 'w10:p2', argv: [] }), /kind pi/)
    assert.throws(
      () => planHerdrAgentStart('ag-1', { paneId: 'w10:p2', argv: ['node', 'fake-agent.ts'] }),
      /kind pi.*node/,
    )
  })

  it('probes liveness, waits for the agent record to clear, and closes the pane by id', () => {
    assert.deepEqual(planHerdrAgentGet('w10:p2'), {
      file: 'herdr',
      args: ['agent', 'get', 'w10:p2'],
    })
    assert.deepEqual(planHerdrAgentWait('w10:p2', 60_000), {
      file: 'herdr',
      args: ['agent', 'wait', 'w10:p2', '--until', 'blocked', '--timeout', '60000'],
    })
    // An elapsed budget still yields a positive Herdr-side timeout so the
    // CLI evaluates the current state instead of rejecting the argument.
    assert.equal(planHerdrAgentWait('w10:p2', 0).args.at(-1), '1')
    assert.equal(planHerdrAgentWait('w10:p2', 149.9).args.at(-1), '149')
    assert.deepEqual(planHerdrPaneClose('w10:p2'), {
      file: 'herdr',
      args: ['pane', 'close', 'w10:p2'],
    })
    assert.equal(herdrAgentName('ag-7'), 'norn-ag-7')
  })

  it('keeps the readable Herdr agent name up to the exact 32-character boundary', () => {
    // `norn-` plus 27 id characters is exactly Herdr's 32-name budget.
    const fitting = 'a'.repeat(27)
    assert.equal(herdrAgentName(fitting), `norn-${fitting}`)
    assert.equal(herdrAgentName(fitting).length, 32)

    // One character more no longer fits and switches to the compacted form.
    const overflowing = 'a'.repeat(28)
    assert.equal(herdrAgentName(overflowing).length, 32)
    assert.notEqual(herdrAgentName(overflowing), `norn-${overflowing}`)
  })

  it('keeps Herdr agent names valid, bounded, deterministic, and distinct', () => {
    const firstId = `wa-${'a'.repeat(125)}`
    const secondId = `wa-${'a'.repeat(124)}b`
    const first = herdrAgentName(firstId)
    const second = herdrAgentName(secondId)
    assert.equal(first, herdrAgentName(firstId))
    assert.equal(first.length, 32)
    assert.equal(second.length, 32)
    assert.match(first, /^[a-z][a-z0-9_-]{0,31}$/)
    assert.match(second, /^[a-z][a-z0-9_-]{0,31}$/)
    assert.notEqual(first, second)

    // The readable form of one id never collides with the compacted form of
    // another: the compacted form always carries a digest segment.
    assert.notEqual(herdrAgentName(firstId), herdrAgentName(firstId.slice(0, 27)))
  })

  it('compacts ids whose characters Herdr rejects, even when they would fit', () => {
    // Uppercase and '.' are outside Herdr's [a-z0-9_-] grammar, so neither a
    // short nor a boundary-length id may keep its raw readable form.
    const short = herdrAgentName('Ag.1')
    assert.notEqual(short, 'norn-Ag.1')
    assert.match(short, /^[a-z][a-z0-9_-]{0,31}$/)
    assert.ok(short.startsWith('norn-ag-1-'))

    const boundary = herdrAgentName(`Att-1.Worker r${'1'.repeat(10)}`.slice(0, 27))
    assert.match(boundary, /^[a-z][a-z0-9_-]{0,31}$/)
    assert.ok(boundary.length <= 32)

    // A long id full of rejected characters still yields a valid name whose
    // readable prefix survives sanitization.
    const hostile = herdrAgentName('ATT_1!' + '.'.repeat(120))
    assert.match(hostile, /^[a-z][a-z0-9_-]{0,31}$/)
    assert.ok(hostile.length <= 32)

    // Sanitizing alone cannot keep ids distinct ('Ag.1' and 'ag-1' share a
    // prefix); the digest of the full id does.
    assert.notEqual(herdrAgentName('Ag.1'), herdrAgentName('ag-1'))
    assert.equal(herdrAgentName('ag-1'), 'norn-ag-1')

    // Every compacted name stays valid at the maximum id length, and an id
    // that sanitizes to nothing still produces a legal digest-only name.
    assert.match(herdrAgentName('A'.repeat(128)), /^[a-z][a-z0-9_-]{0,31}$/)
    assert.match(herdrAgentName('.'.repeat(128)), /^[a-z][a-z0-9_-]{0,31}$/)
    assert.match(herdrAgentName(''), /^[a-z][a-z0-9_-]{0,31}$/)
  })

  it('keeps distinct compacted names for a fleet of long invocation ids', () => {
    // Uniqueness under the compacted form: many ids sharing a long common
    // prefix must still map to pairwise-distinct valid names.
    const ids = Array.from({ length: 64 }, (_, index) => `att-${'x'.repeat(120)}-${index}`)
    const names = new Set(ids.map((id) => herdrAgentName(id)))
    assert.equal(names.size, ids.length)
    for (const name of names) {
      assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/)
      assert.ok(name.length <= 32)
    }
  })

  it('builds the Pi agent argv from the role launch', () => {
    assert.deepEqual(
      planAgentPiArgv(
        { model: 'provider-a/model-x', thinking: 'medium' },
        { extensionPath: '/norn/src/agents/completion-extension.ts', piSessionId: 'session-9' },
      ),
      [
        'pi',
        '--model',
        'provider-a/model-x',
        '--thinking',
        'medium',
        '--extension',
        '/norn/src/agents/completion-extension.ts',
        '--session-id',
        'session-9',
      ],
    )
  })

  it('carries the launch context as one canonical JSON env entry', async () => {
    const area = await createRunArea('plan')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const entry = nornAgentContextEnv(context as never)
    assert.equal(entry.key, 'NORN_AGENT_CONTEXT')
    assert.deepEqual(JSON.parse(entry.value), context)
  })

  it('adds sorted explicit extras without GitHub tokens, push credentials, or context spoofing', async () => {
    const area = await createRunArea('plan-env')
    const context = buildContext(area, { role: 'reviewer', phase: 'ship' })
    const entries = herdrAgentEnvironment(context as never, {
      NO_PROXY: 'localhost,127.0.0.1',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      NORN_AGENT_CONTEXT: '{"spoofed":true}',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      GITHUB_TOKEN: 'secret',
    })

    assert.deepEqual(entries.map((entry) => entry.key), [
      'HTTPS_PROXY',
      'NO_PROXY',
      'NORN_AGENT_CONTEXT',
    ])
    assert.equal(entries[0]!.value, 'http://127.0.0.1:7897')
    assert.deepEqual(JSON.parse(entries[2]!.value), context)
  })

  it('round-trips adapter handles and rejects malformed ones', () => {
    const handle = encodeHerdrHandle({ paneId: 'w10:p2', agentName: 'norn-ag-1', tabId: 'w10:t9' })
    assert.deepEqual(decodeHerdrHandle(handle), {
      paneId: 'w10:p2',
      agentName: 'norn-ag-1',
      tabId: 'w10:t9',
    })
    // A handle from the earlier pane-splitting launch stays attachable.
    const legacy = encodeHerdrHandle({ paneId: 'w10:p2', agentName: 'norn-ag-1' })
    assert.deepEqual(decodeHerdrHandle(legacy), { paneId: 'w10:p2', agentName: 'norn-ag-1' })
    assert.throws(() => decodeHerdrHandle('not json'))
    assert.throws(() => decodeHerdrHandle('{"adapter":"local-process","pgid":1}'))
    assert.throws(() =>
      decodeHerdrHandle('{"adapter":"herdr","paneId":"w10:p2","agentName":"norn-ag-1","tabId":7}'),
    )
  })
})

describe('herdr version gate', () => {
  /**
   * Norn depends on an operator-installed herdr binary that cannot be pinned
   * as a package dependency, and the pre-1.0 Herdr CLI surface changed within
   * the 0.7 → 0.9 line (issue #31). The gate therefore pins a supported
   * range and proves the local build lies inside it before anything launches.
   */
  it('probes the version with one flag-free call', () => {
    assert.deepEqual(planHerdrVersion(), { file: 'herdr', args: ['--version'] })
  })

  it('reads a version out of herdr --version output and nothing else', () => {
    assert.deepEqual(parseHerdrVersion('herdr 0.9.0\n'), [0, 9, 0])
    assert.deepEqual(parseHerdrVersion('herdr 0.10.0-beta+build'), [0, 10, 0])
    assert.equal(parseHerdrVersion('herdr unknown\n'), undefined)
  })

  it('accepts exactly the 0.9 release line norn was validated against', () => {
    assert.equal(HERDR_SUPPORTED_VERSION_RANGE, '>=0.9.0 <0.10.0')
    assert.equal(herdrVersionSupported([0, 9, 0]), true)
    assert.equal(herdrVersionSupported([0, 9, 99]), true)
    assert.equal(herdrVersionSupported([0, 8, 9]), false)
    assert.equal(herdrVersionSupported([0, 10, 0]), false)
    assert.equal(herdrVersionSupported([1, 0, 0]), false)
  })

  it('rejects a launch on an unsupported herdr before any tab is created', async () => {
    const area = await createRunArea('version')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const { exec, plans } = execRecorder([{ stdout: 'herdr 0.7.4\n' }])
    const runner = new HerdrAgentRunner(exec)

    await assert.rejects(
      () => runner.launch({ context, argv: ['pi'], cwd: area.workspacePath }),
      /herdr 0\.7\.4 is outside norn's supported range >=0\.9\.0 <0\.10\.0/,
    )
    assert.equal(plans.length, 1)
    assert.equal(plans.filter((plan) => plan.args[1] === 'create').length, 0)
  })

  it('rejects a launch when the version itself cannot be read', async () => {
    const area = await createRunArea('version-unreadable')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const unreadable = new HerdrAgentRunner(execRecorder([{ stdout: 'garbage' }]).exec)
    await assert.rejects(
      () => unreadable.launch({ context, argv: ['pi'], cwd: area.workspacePath }),
      /no recognizable version/,
    )

    const missing = new HerdrAgentRunner(
      execRecorder([{ reject: new Error('spawn herdr ENOENT') }]).exec,
    )
    await assert.rejects(
      () => missing.launch({ context, argv: ['pi'], cwd: area.workspacePath }),
      /herdr --version failed/,
    )
  })

  it('probes once per runner, not once per launch', async () => {
    const area = await createRunArea('version-once')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const { exec, plans } = execRecorder([
      { stdout: HERDR_VERSION_OK },
      { stdout: TAB_CREATED },
      { stdout: AGENT_STARTED },
      { stdout: TAB_CREATED },
      { stdout: AGENT_STARTED },
    ])
    const runner = new HerdrAgentRunner(exec)

    await runner.launch({ context, argv: ['pi'], cwd: area.workspacePath })
    await runner.launch({ context, argv: ['pi'], cwd: area.workspacePath })

    assert.equal(plans.filter((plan) => plan.args[0] === '--version').length, 1)
  })
})

describe('HerdrAgentRunner against a scripted CLI', () => {
  it('launches into a fresh tab, then starts kind pi in that tab\'s root pane', async () => {
    const { exec, plans, executionTimeouts } = execRecorder([
      { stdout: HERDR_VERSION_OK },
      { stdout: TAB_CREATED },
      { stdout: AGENT_STARTED },
      { stdout: AGENT_PROMPTED },
    ])
    const runner = new HerdrAgentRunner(exec)
    const area = await createRunArea('scripted')
    const context = buildContext(area, { role: 'worker', phase: 'work' })

    const handle = await runner.launch({
      context,
      argv: ['pi', '--model', 'provider-a/model-x', '--', 'brief text'],
      cwd: area.workspacePath,
      env: { HTTPS_PROXY: 'http://127.0.0.1:7897' },
    })

    assert.equal(handle.kind, 'herdr')
    assert.deepEqual(decodeHerdrHandle(handle.adapterHandle), {
      paneId: 'w10:p2',
      agentName: 'norn-ag-invocation-1',
      tabId: 'w10:t9',
    })

    // Step zero: the one-shot version gate (issue #31) proves the local
    // herdr lies inside the supported range before anything is launched.
    assert.deepEqual(plans[0], planHerdrVersion())
    // Step one: the tab carries the invocation label, cwd, sanitized extras,
    // the coordinator context env, and never steals focus.
    assert.deepEqual(plans[1], {
      file: 'herdr',
      args: [
        'tab',
        'create',
        '--cwd',
        area.workspacePath,
        '--label',
        'norn-ag-invocation-1',
        '--env',
        'HTTPS_PROXY=http://127.0.0.1:7897',
        '--env',
        `NORN_AGENT_CONTEXT=${canonicalJson(context as never)}`,
        '--no-focus',
      ],
    })
    // Step two: kind pi in the tab's root pane, native argv only.
    assert.deepEqual(plans[2], {
      file: 'herdr',
      args: [
        'agent',
        'start',
        'norn-ag-invocation-1',
        '--kind',
        'pi',
        '--pane',
        'w10:p2',
        '--',
        '--model',
        'provider-a/model-x',
      ],
    })
    assert.deepEqual(plans[3], {
      file: 'herdr',
      args: ['agent', 'prompt', 'w10:p2', 'brief text'],
    })
    assert.equal(plans.length, 4)
    // The tab create uses the default CLI budget; the start call's execution
    // budget must exceed Herdr's 30 s agent-readiness window.
    assert.equal(executionTimeouts[0], undefined)
    assert.equal(executionTimeouts[1], undefined)
    assert.ok((executionTimeouts[2] ?? 0) > 30_000)

    const reattached = runner.attach(handle.adapterHandle)
    assert.deepEqual(reattached, handle)
  })

  it('retries agent start while the new tab shell is still initializing', async () => {
    const { exec, plans } = execRecorder([
      { stdout: HERDR_VERSION_OK },
      { stdout: TAB_CREATED },
      { stdout: AGENT_PANE_BUSY },
      { stdout: AGENT_PANE_BUSY },
      { stdout: AGENT_STARTED },
    ])
    // The bounded readiness budget is exercised with a short pause.
    const runner = new HerdrAgentRunner(exec, 10_000, 1, 5_000, 1)
    const area = await createRunArea('scripted')
    const context = buildContext(area, { role: 'worker', phase: 'work' })

    const handle = await runner.launch({ context, argv: ['pi'], cwd: area.workspacePath })

    assert.deepEqual(decodeHerdrHandle(handle.adapterHandle), {
      paneId: 'w10:p2',
      agentName: 'norn-ag-invocation-1',
      tabId: 'w10:t9',
    })
    const starts = plans.filter((plan) => plan.args[1] === 'start')
    assert.equal(starts.length, 3, 'two rejections, then the accepted start')
    assert.deepEqual(starts[0], starts[2]!)
    assert.equal(plans.filter((plan) => plan.args[1] === 'close').length, 0)
  })

  it('gives up when the pane never becomes ready and still closes the tab', async () => {
    const { exec, plans } = execRecorder([
      { stdout: HERDR_VERSION_OK },
      { stdout: TAB_CREATED },
      { stdout: AGENT_PANE_BUSY },
      { stdout: TAB_CLOSED },
    ])
    const runner = new HerdrAgentRunner(exec, 10_000, 1, 0, 1)
    const area = await createRunArea('scripted')
    const context = buildContext(area, { role: 'worker', phase: 'work' })

    await assert.rejects(
      () => runner.launch({ context, argv: ['pi'], cwd: area.workspacePath }),
      /agent_pane_busy/,
    )
    assert.equal(plans.filter((plan) => plan.args[1] === 'start').length, 1)
    assert.deepEqual(plans[3], planHerdrTabClose('w10:t9'))
  })

  it('closes the new tab when the agent start step fails', async () => {
    const area = await createRunArea('scripted')
    const context = buildContext(area, { role: 'worker', phase: 'work' })

    const crashing = execRecorder([
      { stdout: HERDR_VERSION_OK },
      { stdout: TAB_CREATED },
      { reject: new Error('Error: spawn EPIPE') },
      { stdout: TAB_CLOSED },
    ])
    const crashingRunner = new HerdrAgentRunner(crashing.exec)
    await assert.rejects(
      () =>
        crashingRunner.launch({
          context,
          argv: ['pi'],
          cwd: area.workspacePath,
        }),
      /EPIPE/,
    )
    assert.deepEqual(crashing.plans[3], planHerdrTabClose('w10:t9'))

    const misplaced = execRecorder([
      { stdout: HERDR_VERSION_OK },
      { stdout: TAB_CREATED },
      { stdout: AGENT_STARTED_ELSEWHERE },
      { stdout: PANE_CLOSED },
    ])
    const misplacedRunner = new HerdrAgentRunner(misplaced.exec)
    await assert.rejects(
      () =>
        misplacedRunner.launch({
          context,
          argv: ['pi'],
          cwd: area.workspacePath,
        }),
      /instead of the split pane w10:p2/,
    )
    assert.deepEqual(misplaced.plans[3], planHerdrTabClose('w10:t9'))
  })

  it('rejects a tab response without a root pane id and issues no close', async () => {
    const { exec, plans } = execRecorder([{ stdout: HERDR_VERSION_OK }, { stdout: TAB_CREATED_NO_PANE }])
    const runner = new HerdrAgentRunner(exec)
    const area = await createRunArea('scripted')
    const context = buildContext(area, { role: 'worker', phase: 'work' })

    await assert.rejects(
      () =>
        runner.launch({
          context,
          argv: ['pi'],
          cwd: area.workspacePath,
        }),
      /no root pane id/,
    )
    assert.equal(plans.filter((plan) => plan.args[1] === 'close').length, 0)
  })

  it('treats every reported agent record as live, including done', async () => {
    const area = await createRunArea('scripted')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const handle = { kind: 'herdr' as const, adapterHandle: encodeHerdrHandle({ paneId: 'w10:p2', agentName: 'norn-ag-1', tabId: 'w10:t9' }) }

    const working = new HerdrAgentRunner(execRecorder([{ stdout: AGENT_INFO }]).exec)
    assert.equal(await working.isLive(handle), true)

    // Herdr 0.9 reports `done` for idle-after-work in an unseen tab — the
    // process is still running; only a cleared agent record proves exit.
    const finishedTurn = new HerdrAgentRunner(execRecorder([{ stdout: AGENT_DONE }]).exec)
    assert.equal(await finishedTurn.isLive(handle), true)
  })

  it('treats a missing or no-longer-running agent as exited', async () => {
    const handle = { kind: 'herdr' as const, adapterHandle: encodeHerdrHandle({ paneId: 'w10:p2', agentName: 'norn-ag-1', tabId: 'w10:t9' }) }

    const gone = new HerdrAgentRunner(execRecorder([{ stdout: AGENT_GONE }]).exec)
    assert.equal(await gone.isLive(handle), false)

    const notRunning = new HerdrAgentRunner(execRecorder([{ stdout: AGENT_NOT_RUNNING }]).exec)
    assert.equal(await notRunning.isLive(handle), false)
  })

  it('fails closed on unrecognized CLI output', async () => {
    const { exec } = execRecorder([
      { stdout: '{"id":"cli:agent:get","result":{}}' },
      { stdout: 'garbage' },
    ])
    const runner = new HerdrAgentRunner(exec)

    const handle = runner.attach(encodeHerdrHandle({ paneId: 'w9:p1', agentName: 'norn-ag-1', tabId: 'w9:t1' }))
    await assert.rejects(() => runner.isLive(handle), /unrecognized response/)

    const broken = new HerdrAgentRunner(execRecorder([{ stdout: HERDR_VERSION_OK }, { stdout: 'garbage' }]).exec)
    const area = await createRunArea('scripted')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    await assert.rejects(() => broken.launch({ context, argv: ['pi'], cwd: area.workspacePath }), /non-JSON/)
  })

  it('waits for exit with one bounded Herdr wait process', async () => {
    const { exec, plans, executionTimeouts } = execRecorder([
      { stdout: HERDR_VERSION_OK },
      { stdout: TAB_CREATED },
      { stdout: AGENT_STARTED },
      { stdout: AGENT_NOT_RUNNING },
    ])
    const runner = new HerdrAgentRunner(exec)
    const area = await createRunArea('scripted')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const handle = await runner.launch({ context, argv: ['pi'], cwd: area.workspacePath })

    assert.equal(await runner.waitForExit(handle, 60_000), 'exited')
    assert.deepEqual(plans[3], planHerdrAgentWait('w10:p2', 60_000))
    assert.equal(plans.filter((p) => p.args[1] === 'wait').length, 1)
    assert.equal(plans.filter((p) => p.args[1] === 'get').length, 0)
    assert.ok((executionTimeouts[3] ?? 0) > 60_000)
  })

  it('preserves missing-agent and timeout settlement results from Herdr wait', async () => {
    const handle = { kind: 'herdr' as const, adapterHandle: encodeHerdrHandle({ paneId: 'w10:p2', agentName: 'norn-ag-1', tabId: 'w10:t9' }) }

    const gone = new HerdrAgentRunner(execRecorder([{ stdout: AGENT_GONE }]).exec)
    assert.equal(await gone.waitForExit(handle, 150), 'exited')

    const timedOut = new HerdrAgentRunner(execRecorder([{ stdout: AGENT_WAIT_TIMEOUT }]).exec)
    assert.equal(await timedOut.waitForExit(handle, 150), 'timeout')
  })

  it('re-arms the wait after an observed blocked state instead of terminating early', async () => {
    const { exec, plans } = execRecorder([
      { stdout: HERDR_VERSION_OK },
      { stdout: TAB_CREATED },
      { stdout: AGENT_STARTED },
      { stdout: AGENT_WAIT_BLOCKED },
      { stdout: AGENT_WAIT_BLOCKED },
      { stdout: AGENT_WAIT_TIMEOUT },
    ])
    const runner = new HerdrAgentRunner(exec, 10_000, 1)
    const area = await createRunArea('scripted')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const handle = await runner.launch({ context, argv: ['pi'], cwd: area.workspacePath })

    // A parked agent keeps its whole budget: the blocked observation is not
    // an exit proof, and the wait is re-armed until Herdr's budget ends.
    assert.equal(await runner.waitForExit(handle, 40), 'timeout')
    assert.equal(plans.filter((p) => p.args[1] === 'wait').length, 3)

    const unblocked = new HerdrAgentRunner(
      execRecorder([{ stdout: AGENT_WAIT_BLOCKED }, { stdout: AGENT_NOT_RUNNING }]).exec,
      10_000,
      1,
    )
    const parked = { kind: 'herdr' as const, adapterHandle: encodeHerdrHandle({ paneId: 'w10:p2', agentName: 'norn-ag-1', tabId: 'w10:t9' }) }
    assert.equal(await unblocked.waitForExit(parked, 5_000), 'exited')
  })

  it('fails closed on an unrecognized wait response', async () => {
    const runner = new HerdrAgentRunner(
      execRecorder([{ stdout: '{"id":"cli:agent:wait","result":{}}' }]).exec,
    )
    const handle = { kind: 'herdr' as const, adapterHandle: encodeHerdrHandle({ paneId: 'w10:p2', agentName: 'norn-ag-1', tabId: 'w10:t9' }) }
    await assert.rejects(() => runner.waitForExit(handle, 150), /unrecognized response/)
  })

  it('terminates by closing the tab and confirming the agent record cleared', async () => {
    const { exec, plans } = execRecorder([
      { stdout: HERDR_VERSION_OK },
      { stdout: TAB_CREATED },
      { stdout: AGENT_STARTED },
      { stdout: PANE_CLOSED },
      { stdout: AGENT_GONE },
    ])
    const runner = new HerdrAgentRunner(exec)
    const area = await createRunArea('scripted')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const handle = await runner.launch({ context, argv: ['pi'], cwd: area.workspacePath })

    assert.equal(await runner.terminate(handle), 'terminated')
    assert.deepEqual(plans[2], {
      file: 'herdr',
      args: ['agent', 'start', 'norn-ag-invocation-1', '--kind', 'pi', '--pane', 'w10:p2', '--'],
    })
    assert.deepEqual(plans[3], { file: 'herdr', args: ['tab', 'close', 'w10:t9'] })
    assert.deepEqual(plans[4], planHerdrAgentWait('w10:p2', 10_000))

    // A close that fails because the tab is already gone still terminates
    // as long as the agent record is provably cleared.
    const alreadyGone = new HerdrAgentRunner(
      execRecorder([{ stdout: PANE_CLOSE_FAILED }, { stdout: AGENT_GONE }]).exec,
    )
    const stale = { kind: 'herdr' as const, adapterHandle: encodeHerdrHandle({ paneId: 'w10:p2', agentName: 'norn-ag-1', tabId: 'w10:t9' }) }
    assert.equal(await alreadyGone.terminate(stale), 'terminated')

    const stuckRunner = new HerdrAgentRunner(
      execRecorder([
        { stdout: HERDR_VERSION_OK },
        { stdout: TAB_CREATED },
        { stdout: AGENT_STARTED },
        { stdout: PANE_CLOSED },
        { stdout: AGENT_WAIT_TIMEOUT },
      ]).exec,
      200,
    )
    const stuck = await stuckRunner.launch({ context, argv: ['pi'], cwd: area.workspacePath })
    assert.equal(await stuckRunner.terminate(stuck), 'terminate-failed')
  })
})

describe('post-settlement cleanup', () => {
  /**
   * A settled invocation must leave nothing behind. Once the agent process
   * has exited on its own, the settlement engine releases the adapter's
   * visible surface — here the invocation's whole Herdr tab — without
   * letting that cleanup change the outcome.
   */
  async function workerSidecar(area: Awaited<ReturnType<typeof createRunArea>>) {
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const written = await new CompletionStore(context.completionsDir).write(
      context,
      {
        discriminant: 'candidate',
        claimedCommit: `sha1:${'a'.repeat(40)}`,
        claimedTreeOid: `sha1:${'b'.repeat(40)}`,
      },
      agentRecordedAt(),
    )
    assert.notEqual(written.status, 'conflict')
    return context
  }

  it('closes the invocation tab after the agent exits on its own', async () => {
    const area = await createRunArea('release')
    const context = await workerSidecar(area)
    const { exec, plans } = execRecorder([{ stdout: AGENT_NOT_RUNNING }, { stdout: TAB_CLOSED }])
    const runner = new HerdrAgentRunner(exec)
    const handle = runner.attach(AGENT_INVOCATION_1_HANDLE)

    const settlement = await settleAgentInvocation(runner, handle, context, 5_000, 'ticket')

    assert.equal(settlement.kind, 'ok')
    assert.deepEqual(plans[0], planHerdrAgentWait('w10:p2', 5_000))
    assert.deepEqual(plans[1], planHerdrTabClose('w10:t9'))
  })

  it('keeps a settled outcome when cleanup cannot close the tab', async () => {
    const area = await createRunArea('release-failed')
    const context = await workerSidecar(area)
    const failing = new HerdrAgentRunner(
      execRecorder([{ stdout: AGENT_NOT_RUNNING }, { reject: new Error('herdr: unavailable') }]).exec,
    )

    const settlement = await settleAgentInvocation(
      failing,
      failing.attach(AGENT_INVOCATION_1_HANDLE),
      context,
      5_000,
      'ticket',
    )

    assert.equal(settlement.kind, 'ok')
  })

  it('releases a legacy tab-less handle by closing its pane', async () => {
    const { exec, plans } = execRecorder([{ stdout: PANE_CLOSED }])
    const runner = new HerdrAgentRunner(exec)
    const handle = runner.attach(
      encodeHerdrHandle({ paneId: 'w10:p2', agentName: 'norn-ag-1' }),
    )

    await runner.release(handle)
    assert.deepEqual(plans[0], planHerdrPaneClose('w10:p2'))
  })

  it('never lets an unreadable handle throw out of cleanup', async () => {
    const { exec, plans } = execRecorder([{ stdout: TAB_CLOSED }])
    const runner = new HerdrAgentRunner(exec)
    await runner.release({ kind: 'herdr', adapterHandle: '{"adapter":"local-process","pgid":1}' })
    assert.equal(plans.length, 0)
  })
})

describe('live Herdr pane lifecycle (opt-in)', () => {
  /**
   * Herdr 0.9 `agent start` launches supported agent kinds only, so the old
   * fake-node-agent settlement is no longer reachable through this adapter.
   * The live boundary instead drives a real idle Pi pane — no prompt is ever
   * submitted, so no model is called — through the production two-step
   * launch, liveness, and the settlement engine's timeout→terminate path,
   * proving the pane is closed and the record cleared afterwards.
   */
  it('launches a real pi pane, observes liveness, and settles timeout by terminating it', { skip: process.env.NORN_TEST_HERDR !== '1' }, async () => {
    const area = await createRunArea('live')
    const context = buildContext(area, {
      role: 'worker',
      phase: 'work',
      invocationId: `ag-live-${Date.now()}`,
    })

    const runner = new HerdrAgentRunner()
    const handle = await runner.launch({
      context,
      argv: ['pi'],
      cwd: area.workspacePath,
    })
    assert.equal(await runner.isLive(handle), true)

    // An idle Pi pane never exits on its own: the budget elapses, the
    // settlement engine terminates the pane, and the invocation settles as
    // a typed agent-timeout with the process group proven gone.
    const settlement = await settleAgentInvocation(runner, handle, context, 2_000, 'ticket')
    assert.equal(settlement.kind, 'error')
    if (settlement.kind === 'error') {
      assert.equal(settlement.code, 'agent-timeout')
    }
    assert.equal(await runner.isLive(handle), false)
  })
})
