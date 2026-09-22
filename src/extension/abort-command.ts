/**
 * `/norn abort <map-url>` as an extension command: production wiring and
 * rendering (design.md §2.3, §13.2). The extension stays a thin operator
 * adapter: it constructs the built-in production adapters — the `git` and
 * `gh` CLIs, the GraphQL-backed map loader and evidence reader, the Herdr
 * visible agent runner for process-group settlement, read-only Git delivery
 * facts, and the filesystem Local control store under Norn home — and asks
 * the operator for the exact run ID through the typed dialog. Every abort
 * decision belongs to the runner (`src/run/abort.ts`); tests replace the
 * adapters at the same interfaces and drive `executeAbortCommand` with a
 * scripted UI.
 */
import { homedir } from 'node:os'

import {
  ghApiEvidenceReader,
  ghApiTaskMapLoader,
  ghCliGateway,
} from '../adapters/github-gateway.ts'
import { gitCliDeliveryFacts, gitCliRepository } from '../adapters/git-repository.ts'
import { HerdrAgentRunner } from '../agents/herdr-runner.ts'
import { fsControlStore } from '../control/control-store.ts'
import { resolveNornHome } from '../config/paths.ts'
import { abortMap } from '../run/abort.ts'
import type { AbortDeps } from '../run/abort.ts'
import type { DialogUi } from './interaction.ts'
import { dialogAbortInteraction } from './interaction.ts'
import { renderAbortOutcome } from './render.ts'

/** The slice of Pi's command context `/norn abort` needs. */
export type AbortCommandContext = {
  readonly cwd: string
  readonly ui: DialogUi
}

/** The adapter half of `AbortDeps`; the interaction always comes from `ctx.ui`. */
export type AbortCommandAdapters = Omit<AbortDeps, 'cwd' | 'interaction'>

/**
 * Build the built-in production adapters: the `git` and `gh` CLIs, the
 * GraphQL-backed Task Map loader and evidence reader, the Herdr visible
 * agent runner, read-only Git delivery facts, and the filesystem Local
 * control store under Norn home, honoring `PI_CODING_AGENT_DIR`
 * (design.md §2.2).
 */
export function productionAbortAdapters(): AbortCommandAdapters {
  const nornHome = resolveNornHome(process.env, homedir())
  return {
    nornHome,
    git: gitCliRepository(),
    gateway: ghCliGateway(),
    loader: ghApiTaskMapLoader(),
    store: fsControlStore(nornHome),
    evidence: ghApiEvidenceReader(),
    gitFacts: gitCliDeliveryFacts(),
    runner: new HerdrAgentRunner(),
  }
}

/**
 * Execute `/norn abort <map-url>` and render its typed outcome in the
 * operator's pane. The operator confirms the exact run ID through the typed
 * dialog; a mismatch or cancellation aborts nothing.
 */
export async function executeAbortCommand(
  ctx: AbortCommandContext,
  mapUrl: string,
  adapters: AbortCommandAdapters = productionAbortAdapters(),
): Promise<void> {
  const outcome = await abortMap(
    { cwd: ctx.cwd, ...adapters, interaction: dialogAbortInteraction(ctx.ui) },
    mapUrl,
  )
  ctx.ui.notify(renderAbortOutcome(outcome), outcome.kind === 'ok' ? 'info' : 'warning')
}
