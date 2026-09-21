/**
 * `/norn run <map-url>` as an extension command: production wiring and
 * rendering (design.md §2.1, §6). The extension stays a thin operator
 * adapter: it constructs the built-in production adapters — the `git` and
 * `gh` CLIs, the GraphQL-backed map loader, evidence reader, and issue
 * writer, the Pi model registry, the Herdr visible agent runner, the
 * process-group command runner, the non-force git push seam, and the
 * filesystem Local control store under Norn home — and hands them to the
 * coordinator (`src/run/lifecycle.ts`), which owns every scheduling,
 * evidence, and side-effect decision. Tests replace the adapters at the
 * same interfaces and drive `executeRunCommand` with a fake UI.
 */
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  ghApiEvidenceReader,
  ghApiIssueWriter,
  ghApiTaskMapLoader,
  ghCliGateway,
} from '../adapters/github-gateway.ts'
import { gitCliDeliveryFacts, gitCliPush, gitCliRepository, runGit, runGitDetailed } from '../adapters/git-repository.ts'
import { registryModelCatalog } from '../adapters/model-catalog.ts'
import type { ModelRegistryLike } from '../adapters/model-catalog.ts'
import { HerdrAgentRunner } from '../agents/herdr-runner.ts'
import { fsControlStore } from '../control/control-store.ts'
import { resolveNornHome } from '../config/paths.ts'
import { piShipReviewerLaunch } from '../ship/reconcile.ts'
import { piMapCompletionReviewerLaunch } from '../run/completion.ts'
import { runMap } from '../run/lifecycle.ts'
import type { RunLifecycleDeps } from '../run/lifecycle.ts'
import { piReadOnlyReviewerLaunch, piWorkerLaunch } from '../work/round-gate.ts'
import { ProcessGroupCommandRunner } from '../work/command-runner.ts'
import type { DialogUi } from './interaction.ts'
import { renderRunOutcome } from './render.ts'

/** The slice of Pi's command context `/norn run` needs. */
export type RunCommandContext = {
  readonly cwd: string
  readonly ui: Pick<DialogUi, 'notify'>
  readonly modelRegistry: ModelRegistryLike
}

/** The adapter half of `RunLifecycleDeps`. */
export type RunCommandAdapters = Omit<RunLifecycleDeps, 'cwd'>

/**
 * The completion extension every child Pi process loads (§17): the module
 * next door, run from source exactly like this one.
 */
const COMPLETION_EXTENSION_PATH = fileURLToPath(
  new URL('../agents/completion-extension.ts', import.meta.url),
)

/**
 * Build the built-in production adapters. Work and Ship reviewers run as
 * visible Herdr panes through the Herdr agent runner; gate commands run as
 * detached process groups with sanitized environments; pushes are never
 * forced; issue writes go through the authenticated `gh` CLI.
 */
export function productionRunAdapters(ctx: RunCommandContext): RunCommandAdapters {
  return {
    git: gitCliRepository(),
    gateway: ghCliGateway(),
    loader: ghApiTaskMapLoader(),
    catalog: registryModelCatalog(ctx.modelRegistry),
    evidence: ghApiEvidenceReader(),
    gitFacts: gitCliDeliveryFacts(),
    store: fsControlStore(resolveNornHome(process.env, homedir())),
    runner: new HerdrAgentRunner(),
    commands: new ProcessGroupCommandRunner(),
    workGit: runGit,
    gitDetailed: runGitDetailed,
    push: gitCliPush(),
    writer: ghApiIssueWriter(),
    launches: productionLaunchPlans(),
  }
}

/**
 * The production launch plans: the configured Pi model with the completion
 * extension, plus the role briefing as the initial prompt. The reviewer
 * plans carry the strict §10.2 read-only tool allowlist. Each child's
 * `--session-id` equals the completion context's `piSessionId`
 * (`<invocationId>-pi`), so the sidecar the completion extension writes
 * binds to exactly the session the coordinator recorded (§17). The ship
 * reviewer's plan and invocation-ID counters advance in lockstep because
 * §11.2 plans exactly one reviewer launch per invocation ID, in that order.
 */
export function productionLaunchPlans(): RunLifecycleDeps['launches'] {
  let planned = 0
  let issued = 0
  return {
    planWorkerFor: (workAttemptId, worker) => (input) =>
      piWorkerLaunch(input, {
        model: worker.model,
        thinking: worker.thinking,
        extensionPath: COMPLETION_EXTENSION_PATH,
        piSessionId: `${workAttemptId}-worker-r${input.round}-pi`,
      }),
    planWorkReviewerFor: (workAttemptId, reviewer) => {
      // One plan call per round, in round order (§10.2), so the counter
      // matches the invocation ID `<attemptId>-reviewer-r<round>` exactly.
      let planned = 0
      return (input) => {
        planned += 1
        return piReadOnlyReviewerLaunch(input, {
          model: reviewer.model,
          thinking: reviewer.thinking,
          extensionPath: COMPLETION_EXTENSION_PATH,
          piSessionId: `${workAttemptId}-reviewer-r${planned}-pi`,
        })
      }
    },
    planShipReviewer: (reviewer) => (input) => {
      planned += 1
      return piShipReviewerLaunch(input, {
        model: reviewer.model,
        thinking: reviewer.thinking,
        extensionPath: COMPLETION_EXTENSION_PATH,
        piSessionId: `ship-rev-${planned}-pi`,
      })
    },
    planMapCompletionReviewer: (reviewer) => (input) => {
      planned += 1
      return piMapCompletionReviewerLaunch(input, {
        model: reviewer.model,
        thinking: reviewer.thinking,
        extensionPath: COMPLETION_EXTENSION_PATH,
        piSessionId: `map-completion-rev-${planned}-pi`,
      })
    },
    newShipInvocationId: () => {
      issued += 1
      return `ship-rev-${issued}`
    },
  }
}

/**
 * Execute `/norn run <map-url>` and render its typed outcome in the
 * operator's pane. The run stays attached for its whole lifetime and
 * normally returns a terminal RunReport; a recoverable shared-write error
 * reports that the run stays `running` and resumable.
 */
export async function executeRunCommand(
  ctx: RunCommandContext,
  mapUrl: string,
  adapters: RunCommandAdapters = productionRunAdapters(ctx),
): Promise<void> {
  const outcome = await runMap({ cwd: ctx.cwd, ...adapters }, mapUrl)
  ctx.ui.notify(renderRunOutcome(outcome), outcome.kind === 'ok' ? 'info' : 'warning')
}
