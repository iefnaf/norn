#!/usr/bin/env node
/**
 * The end-to-end validation driver of ticket #18
 * (docs/validation-runbook.md): drive the real `/norn` code paths — the
 * extension command functions with the built-in production adapters —
 * against the fixture repository, from a headless process.
 *
 * What this driver shares with the real operator experience:
 *
 * - `map` loads the Task Map through the production GraphQL loader and
 *   prints the topology Norn will use (native sub-issues + blockedBy).
 * - `init` runs the complete `initRepository` flow with the production
 *   adapters and explicit scripted choices (the same typed interaction
 *   contract `/norn init`'s dialogs produce).
 * - `check` and `run` call `executeCheckCommand` / `executeRunCommand`
 *   with the production adapter sets — real gh gateway, real git, real
 *   Herdr agent panes, real pushes.
 *
 * What it substitutes: the model registry is built over the real
 * `~/.pi/agent` credentials/catalog with explicit paths (the driver process
 * runs with a dedicated `PI_CODING_AGENT_DIR` for Norn home, which the
 * registry must NOT read auth from), and init's dialogs become the scripted
 * answers below.
 *
 * Usage:
 *
 *   PI_CODING_AGENT_DIR=<isolated-agent-dir> node scripts/e2e-driver.ts init
 *   PI_CODING_AGENT_DIR=<isolated-agent-dir> node scripts/e2e-driver.ts map <map-url>
 *   PI_CODING_AGENT_DIR=<isolated-agent-dir> node scripts/e2e-driver.ts check <map-url>
 *   PI_CODING_AGENT_DIR=<isolated-agent-dir> node scripts/e2e-driver.ts run <map-url>
 *
 * Run from inside the target repository checkout. `PI_CODING_AGENT_DIR`
 * must be set so Norn home never lands in the real Pi home.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent'

import { ghApiTaskMapLoader, ghCliGateway } from '../src/adapters/github-gateway.ts'
import { gitCliRepository } from '../src/adapters/git-repository.ts'
import { registryModelCatalog } from '../src/adapters/model-catalog.ts'
import { fsControlStore } from '../src/control/control-store.ts'
import { resolveNornHome } from '../src/config/paths.ts'
import {
  SUGGESTED_COMMAND_TIMEOUT_MS,
  SUGGESTED_REVIEWER_TIMEOUT_MS,
  SUGGESTED_WORKER_TIMEOUT_MS,
} from '../src/config/run-config.ts'
import { parseIssueUrl } from '../src/map/issue-url.ts'
import { stableReadTaskMap } from '../src/map/stable-read.ts'
import { executeCheckCommand } from '../src/extension/check-command.ts'
import { executeRunCommand } from '../src/extension/run-command.ts'
import { initRepository } from '../src/runner/init.ts'
import type { AgentRoleInput, CommandSpecInput, InitInteraction } from '../src/runner/init.ts'

// ---------------------------------------------------------------------------
// The explicit operator choices for the fixture (ticket #18 instructions)
// ---------------------------------------------------------------------------

const e2eProxy = process.env.NORN_E2E_HTTP_PROXY?.trim()
const e2eNoProxy = process.env.NORN_E2E_NO_PROXY?.trim()

const CHOICES = {
  targetBranch: 'main',
  /** The fixture package.json has zero dependencies; `npm install` would
   * create an untracked package-lock.json and dirty every gate workspace,
   * so the honest setup list is empty. */
  setup: [] as readonly CommandSpecInput[],
  tests: [
    { argv: ['npm', 'test'], timeoutMs: SUGGESTED_COMMAND_TIMEOUT_MS },
  ] as readonly CommandSpecInput[],
  worker: {
    model: 'zai-coding-cn/glm-5.3',
    thinking: 'low',
    timeoutMs: SUGGESTED_WORKER_TIMEOUT_MS,
  } satisfies AgentRoleInput,
  reviewer: {
    model: 'openai-codex/gpt-5.6-luna',
    thinking: 'minimal',
    timeoutMs: SUGGESTED_REVIEWER_TIMEOUT_MS,
  } satisfies AgentRoleInput,
  maxWorkRounds: Number(process.env.NORN_E2E_MAX_WORK_ROUNDS ?? 3),
  maxPushRetries: 2,
  concurrency: 2,
  agentEnv: {
    ...(e2eProxy === undefined || e2eProxy === ''
      ? {}
      : { HTTP_PROXY: e2eProxy, HTTPS_PROXY: e2eProxy }),
    ...(e2eNoProxy === undefined || e2eNoProxy === '' ? {} : { NO_PROXY: e2eNoProxy }),
  },
} as const

// ---------------------------------------------------------------------------
// Registry: the real Pi model registry over the real credentials
// ---------------------------------------------------------------------------

async function buildModelRegistry(): Promise<ModelRegistry> {
  // The driver isolates Norn home via PI_CODING_AGENT_DIR; the registry
  // still reads the operator's real credentials and cached catalogs.
  const agentDir = join(homedir(), '.pi', 'agent')
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store.json'),
  })
  return new ModelRegistry(runtime)
}

type NotifyLevel = 'error' | 'info' | 'warning'

function printingUi() {
  return {
    notify(message: string, level: NotifyLevel = 'info'): void {
      console.log(`--- /norn (${level}) ---\n${message}\n`)
    },
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdMap(mapUrl: string): Promise<number> {
  const locator = parseIssueUrl(mapUrl)
  if (locator === undefined) {
    console.error(`not a full GitHub issue URL: ${mapUrl}`)
    return 1
  }
  const snapshot = await stableReadTaskMap(() => ghApiTaskMapLoader().loadTaskMap(locator))
  if (snapshot.kind !== 'ok') {
    console.error(`map read failed (${snapshot.kind}/${'code' in snapshot ? snapshot.code : ''})`)
    return 1
  }
  const map = snapshot.value
  console.log(`map #${map.ref.number} ${map.state} — ${map.title}`)
  console.log(`revision ${map.mapRevision}`)
  console.log(`url ${map.ref.url}`)
  for (const ticket of map.tickets) {
    console.log(
      `  #${ticket.ref.number} ${ticket.state} blockedBy=[${ticket.blockedBy
        .map((blocker) => `#${blocker.number}`)
        .join(',')}] ${ticket.title}`,
    )
  }
  return 0
}

function scriptedInteraction(): InitInteraction {
  return {
    selectRepositoryIdentity(options) {
      if (options.length !== 1) {
        console.error(`expected exactly one plausible remote, got ${options.length}`)
        return Promise.resolve(undefined)
      }
      return Promise.resolve(options[0])
    },
    chooseTargetBranch(suggested) {
      console.log(`target branch: ${CHOICES.targetBranch} (suggested ${suggested})`)
      return Promise.resolve(CHOICES.targetBranch)
    },
    chooseCommandList(kind) {
      const list = kind === 'setup' ? CHOICES.setup : CHOICES.tests
      console.log(`${kind} commands: ${JSON.stringify(list)}`)
      return Promise.resolve(list)
    },
    chooseAgentRole(role) {
      const choice = role === 'worker' ? CHOICES.worker : CHOICES.reviewer
      console.log(`${role}: ${choice.model} (thinking ${choice.thinking})`)
      return Promise.resolve(choice)
    },
    chooseInteger(field, suggested) {
      const value = CHOICES[field]
      console.log(`${field}: ${value} (suggested ${suggested})`)
      return Promise.resolve(value)
    },
    chooseAgentEnvironment() {
      console.log(`child agent environment: ${JSON.stringify(CHOICES.agentEnv)}`)
      return Promise.resolve(CHOICES.agentEnv)
    },
    chooseTrustedEvidenceAuthors(actor) {
      console.log(`trusted evidence authors: just the authenticated actor ${actor.login}`)
      return Promise.resolve([])
    },
    confirmReplaceConfig(_existing, proposed) {
      console.log('replacing existing configuration with:')
      console.log(proposed.configJson)
      return Promise.resolve(true)
    },
  }
}

async function cmdInit(): Promise<number> {
  const modelRegistry = await buildModelRegistry()
  const outcome = await initRepository({
    cwd: process.cwd(),
    git: gitCliRepository(),
    gateway: ghCliGateway(),
    catalog: registryModelCatalog(modelRegistry),
    store: fsControlStore(resolveNornHome(process.env, homedir())),
    interaction: scriptedInteraction(),
  })
  if (outcome.kind !== 'ok') {
    console.error(`init ${outcome.kind} (${outcome.code}): ${outcome.reason}`)
    console.error(JSON.stringify(outcome.evidence, null, 2))
    return 1
  }
  console.log(`init ok — repository home: ${outcome.value.repositoryHome}`)
  console.log(`repository ${outcome.value.repository.owner}/${outcome.value.repository.name} ` +
    `(id ${outcome.value.repository.repositoryId}, default branch ${outcome.value.repository.defaultBranch})`)
  console.log(`configRevision ${outcome.value.configRevision}`)
  console.log(`concurrency ${outcome.value.config.concurrency} · maxWorkRounds ${outcome.value.config.maxWorkRounds} · maxPushRetries ${outcome.value.config.maxPushRetries}`)
  console.log(`trusted evidence authors: ${outcome.value.config.trustedEvidenceAuthorIds.join(', ')}`)
  return 0
}

async function cmdCheck(mapUrl: string): Promise<number> {
  const modelRegistry = await buildModelRegistry()
  await executeCheckCommand(
    { cwd: process.cwd(), ui: printingUi(), modelRegistry },
    mapUrl,
  )
  return 0
}

async function cmdRun(mapUrl: string): Promise<number> {
  const modelRegistry = await buildModelRegistry()
  await executeRunCommand(
    { cwd: process.cwd(), ui: printingUi(), modelRegistry },
    mapUrl,
  )
  return 0
}

// ---------------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<number> {
  if (process.env.PI_CODING_AGENT_DIR === undefined || process.env.PI_CODING_AGENT_DIR.trim() === '') {
    console.error('PI_CODING_AGENT_DIR must be set to an isolated agent directory')
    return 2
  }
  const [command, mapUrl] = argv
  switch (command) {
    case 'init':
      return cmdInit()
    case 'map':
      return mapUrl === undefined ? usage() : cmdMap(mapUrl)
    case 'check':
      return mapUrl === undefined ? usage() : cmdCheck(mapUrl)
    case 'run':
      return mapUrl === undefined ? usage() : cmdRun(mapUrl)
    default:
      return usage()
  }
}

function usage(): number {
  console.error('usage: e2e-driver.ts <init | map <url> | check <url> | run <url>>')
  return 2
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (cause) => {
    console.error(cause instanceof Error ? cause.stack : String(cause))
    process.exit(3)
  },
)
