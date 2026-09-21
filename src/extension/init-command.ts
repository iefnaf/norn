/**
 * `/norn init` as an extension command: production wiring and rendering. The
 * extension constructs the built-in production adapters here (design.md §6)
 * and hands them to the runner; it owns no policy. Tests replace the adapters
 * at the same interfaces and drive `executeInitCommand` with a scripted UI.
 */
import { homedir } from 'node:os'

import { ghCliGateway } from '../adapters/github-gateway.ts'
import { gitCliRepository } from '../adapters/git-repository.ts'
import { registryModelCatalog } from '../adapters/model-catalog.ts'
import type { ModelRegistryLike } from '../adapters/model-catalog.ts'
import { fsControlStore } from '../control/control-store.ts'
import { resolveNornHome } from '../config/paths.ts'
import { initRepository } from '../runner/init.ts'
import type { InitDeps } from '../runner/init.ts'
import type { DialogUi } from './interaction.ts'
import { dialogInitInteraction } from './interaction.ts'
import { renderInitOutcome } from './render.ts'

/** The slice of Pi's command context `/norn init` needs. */
export type InitCommandContext = {
  readonly cwd: string
  readonly ui: DialogUi
  readonly modelRegistry: ModelRegistryLike
}

/** The adapter half of `InitDeps`; the interaction always comes from `ctx.ui`. */
export type InitCommandAdapters = Omit<InitDeps, 'cwd' | 'interaction'>

/**
 * Build the built-in production adapters: the `git` and `gh` CLIs, the Pi
 * model registry, and the filesystem Local control store under Norn home,
 * honoring `PI_CODING_AGENT_DIR` (design.md §2.2).
 */
export function productionInitAdapters(ctx: InitCommandContext): InitCommandAdapters {
  return {
    git: gitCliRepository(),
    gateway: ghCliGateway(),
    catalog: registryModelCatalog(ctx.modelRegistry),
    store: fsControlStore(resolveNornHome(process.env, homedir())),
  }
}

/** Execute `/norn init` and render its typed outcome in the operator's pane. */
export async function executeInitCommand(
  ctx: InitCommandContext,
  adapters: InitCommandAdapters = productionInitAdapters(ctx),
): Promise<void> {
  const outcome = await initRepository({
    cwd: ctx.cwd,
    ...adapters,
    interaction: dialogInitInteraction(ctx.ui),
  })
  ctx.ui.notify(renderInitOutcome(outcome), outcome.kind === 'ok' ? 'info' : 'warning')
}
