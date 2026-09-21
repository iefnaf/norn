/**
 * The Herdr production adapter (design.md §6, §17, ticket #8).
 *
 * The pure `plan*` functions are asserted against the exact Herdr CLI
 * surface so no Herdr server is needed; the adapter behavior (launch parse,
 * liveness, exit polling, terminate) is exercised through an injected fake
 * executor. A live-pane test exists for environments that explicitly opt in
 * with NORN_TEST_HERDR=1 and have the Herdr binary — CI and machines without
 * Herdr run the fakes only.
 */
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { HerdrAgentRunner, type HerdrPlan, decodeHerdrHandle, encodeHerdrHandle, herdrAgentName, nornAgentContextEnv, planAgentPiArgv, planHerdrAgentGet, planHerdrAgentStart, planHerdrPaneClose } from '../src/agents/herdr-runner.ts'
import { settleAgentInvocation } from '../src/agents/runner.ts'
import { buildContext, createRunArea, defaultWorkerCandidate, fakeAgentLaunch } from './helpers/agent-fixtures.ts'

function execRecorder(
  script: Array<{ readonly stdout?: string; readonly reject?: Error }>,
): { plans: HerdrPlan[]; exec: (plan: HerdrPlan) => Promise<string> } {
  const plans: HerdrPlan[] = []
  let call = 0
  return {
    plans,
    exec: (plan) => {
      plans.push(plan)
      const step = script[Math.min(call, script.length - 1)]
      call += 1
      if (step.reject !== undefined) return Promise.reject(step.reject)
      return Promise.resolve(step.stdout ?? '')
    },
  }
}

const AGENT_STARTED =
  '{"id":"cli:agent:start","result":{"agent":{"pane_id":"w10:p2","name":"norn-ag-1"},"type":"agent_started"}}\n'
const AGENT_INFO =
  '{"id":"cli:agent:get","result":{"agent":{"pane_id":"w10:p2","agent_status":"working"},"type":"agent_info"}}\n'
const AGENT_GONE =
  '{"error":{"code":"agent_not_found","message":"agent target w10:p2 not found"},"id":"cli:agent:get"}\n'

describe('herdr CLI plans', () => {
  it('starts a visible named pane with the agent argv and context env', () => {
    const plan = planHerdrAgentStart('ag-1', {
      cwd: '/ws/att-1',
      env: [{ key: 'NORN_AGENT_CONTEXT', value: '{"schema":"…"}' }],
      argv: ['pi', '--model', 'provider-a/model-x'],
    })

    assert.deepEqual(plan, {
      file: 'herdr',
      args: [
        'agent',
        'start',
        'norn-ag-1',
        '--cwd',
        '/ws/att-1',
        '--env',
        'NORN_AGENT_CONTEXT={"schema":"…"}',
        '--no-focus',
        '--',
        'pi',
        '--model',
        'provider-a/model-x',
      ],
    })
  })

  it('probes liveness and closes the pane by id', () => {
    assert.deepEqual(planHerdrAgentGet('w10:p2'), {
      file: 'herdr',
      args: ['agent', 'get', 'w10:p2'],
    })
    assert.deepEqual(planHerdrPaneClose('w10:p2'), {
      file: 'herdr',
      args: ['pane', 'close', 'w10:p2'],
    })
    assert.equal(herdrAgentName('ag-7'), 'norn-ag-7')
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

  it('round-trips adapter handles and rejects malformed ones', () => {
    const handle = encodeHerdrHandle('w10:p2', 'norn-ag-1')
    assert.deepEqual(decodeHerdrHandle(handle), { paneId: 'w10:p2', agentName: 'norn-ag-1' })
    assert.throws(() => decodeHerdrHandle('not json'))
    assert.throws(() => decodeHerdrHandle('{"adapter":"local-process","pgid":1}'))
  })
})

describe('HerdrAgentRunner against a scripted CLI', () => {
  it('launches, reports liveness from agent get, and reattaches by handle', async () => {
    const { exec, plans } = execRecorder([{ stdout: AGENT_STARTED }, { stdout: AGENT_INFO }])
    const runner = new HerdrAgentRunner(exec)
    const area = await createRunArea('scripted')
    const context = buildContext(area, { role: 'worker', phase: 'work' })

    const handle = await runner.launch({
      context,
      argv: ['pi'],
      cwd: area.workspacePath,
    })

    assert.equal(handle.kind, 'herdr')
    assert.deepEqual(plans[0].args.slice(0, 3), ['agent', 'start', 'norn-ag-invocation-1'])
    assert.equal(await runner.isLive(handle), true)

    const reattached = runner.attach(handle.adapterHandle)
    assert.deepEqual(reattached, handle)
  })

  it('treats a missing pane as exited', async () => {
    const { exec } = execRecorder([{ stdout: AGENT_STARTED }, { stdout: AGENT_GONE }])
    const runner = new HerdrAgentRunner(exec)
    const area = await createRunArea('scripted')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const handle = await runner.launch({ context, argv: ['pi'], cwd: area.workspacePath })

    assert.equal(await runner.isLive(handle), false)
  })

  it('fails closed on unrecognized CLI output', async () => {
    const { exec } = execRecorder([
      { stdout: '{"id":"cli:agent:get","result":{}}' },
      { stdout: 'garbage' },
    ])
    const runner = new HerdrAgentRunner(exec)

    const handle = runner.attach(encodeHerdrHandle('w9:p1', 'norn-ag-1'))
    await assert.rejects(() => runner.isLive(handle), /unrecognized response/)

    const broken = new HerdrAgentRunner(execRecorder([{ stdout: 'garbage' }]).exec)
    const area = await createRunArea('scripted')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    await assert.rejects(() => broken.launch({ context, argv: ['pi'], cwd: area.workspacePath }), /non-JSON/)
  })

  it('waits for exit by polling liveness', async () => {
    const { exec, plans } = execRecorder([
      { stdout: AGENT_STARTED },
      { stdout: AGENT_INFO },
      { stdout: AGENT_INFO },
      { stdout: AGENT_GONE },
    ])
    const runner = new HerdrAgentRunner(exec)
    const area = await createRunArea('scripted')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const handle = await runner.launch({ context, argv: ['pi'], cwd: area.workspacePath })

    assert.equal(await runner.waitForExit(handle, 5_000), 'exited')
    assert.equal(plans.filter((p) => p.args[1] === 'get').length, 3)

    const timeoutRunner = new HerdrAgentRunner(execRecorder([{ stdout: AGENT_STARTED }, { stdout: AGENT_INFO }]).exec)
    const hanging = await timeoutRunner.launch({ context, argv: ['pi'], cwd: area.workspacePath })
    assert.equal(await timeoutRunner.waitForExit(hanging, 150), 'timeout')
  })

  it('terminates by closing the pane and confirming the process is gone', async () => {
    const { exec, plans } = execRecorder([
      { stdout: AGENT_STARTED },
      { stdout: '{"id":"cli:pane:close","result":{"type":"ok"}}' },
      { stdout: AGENT_GONE },
    ])
    const runner = new HerdrAgentRunner(exec)
    const area = await createRunArea('scripted')
    const context = buildContext(area, { role: 'worker', phase: 'work' })
    const handle = await runner.launch({ context, argv: ['pi'], cwd: area.workspacePath })

    assert.equal(await runner.terminate(handle), 'terminated')
    assert.deepEqual(plans[1], { file: 'herdr', args: ['pane', 'close', 'w10:p2'] })

    const stuckRunner = new HerdrAgentRunner(
      execRecorder([{ stdout: AGENT_STARTED }, { stdout: '{"id":"cli:pane:close","result":{"type":"ok"}}' }, { stdout: AGENT_INFO }]).exec,
      200,
    )
    const stuck = await stuckRunner.launch({ context, argv: ['pi'], cwd: area.workspacePath })
    assert.equal(await stuckRunner.terminate(stuck), 'terminate-failed')
  })
})

describe('live Herdr pane settlement (opt-in)', () => {
  it('settles a real pane launch through the settlement engine', { skip: process.env.NORN_TEST_HERDR !== '1' }, async () => {
    const area = await createRunArea('live')
    const context = buildContext(area, { role: 'worker', phase: 'work', invocationId: `ag-live-${Date.now()}` })
    const agent = fakeAgentLaunch('complete')

    const runner = new HerdrAgentRunner()
    const handle = await runner.launch({
      context,
      argv: agent.argv,
      cwd: area.workspacePath,
      env: { ...agent.env, NORN_AGENT_CONTEXT: JSON.stringify(context) },
    })

    const settlement = await settleAgentInvocation(runner, handle, context, 30_000, 'ticket')

    assert.equal(settlement.kind, 'ok')
    if (settlement.kind === 'ok') {
      assert.deepEqual(settlement.value.completion, defaultWorkerCandidate)
      assert.deepEqual(await readdir(area.completionsDir), [`${context.invocationId}.json`])
    }
  })
})
