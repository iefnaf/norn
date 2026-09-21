/**
 * `/norn check` as an extension command: production wiring and rendering.
 * The extension constructs the built-in production adapters here (design.md
 * §6) and hands them to the runner; it owns no policy — every finding and the
 * accepted snapshot come from the runner as typed data. Tests replace the
 * adapters at the same interfaces and drive `executeCheckCommand` with a fake
 * UI: no network, no writes.
 */
import { homedir } from 'node:os'

import { ghCliGateway, ghApiTaskMapLoader } from '../adapters/github-gateway.ts'
import { gitCliRepository } from '../adapters/git-repository.ts'
import { fsControlStore } from '../control/control-store.ts'
import { resolveNornHome } from '../config/paths.ts'
import { checkMap } from '../runner/check.ts'
import type { CheckMapDeps } from '../runner/check.ts'
import type { DialogUi } from './interaction.ts'
import { renderCheckOutcome } from './render.ts'

/** The slice of Pi's command context `/norn check` needs. */
export type CheckCommandContext = {
  readonly cwd: string
  readonly ui: Pick<DialogUi, 'notify'>
}

/** The adapter half of `CheckMapDeps`. */
export type CheckCommandAdapters = Omit<CheckMapDeps, 'cwd'>

/**
 * Build the built-in production adapters: the `git` and `gh` CLIs, the
 * GraphQL-backed Task Map loader, and the filesystem Local control store
 * under Norn home, honoring `PI_CODING_AGENT_DIR` (design.md §2.2).
 */
export function productionCheckAdapters(): CheckCommandAdapters {
  return {
    git: gitCliRepository(),
    gateway: ghCliGateway(),
    loader: ghApiTaskMapLoader(),
    store: fsControlStore(resolveNornHome(process.env, homedir())),
  }
}

/**
 * Execute `/norn check <map-url>` and render its typed outcome in the
 * operator's pane. Read-only: check creates no run-owned resources and
 * performs no shared writes (§2.3).
 */
export async function executeCheckCommand(
  ctx: CheckCommandContext,
  mapUrl: string,
  adapters: CheckCommandAdapters = productionCheckAdapters(),
): Promise<void> {
  const outcome = await checkMap({ cwd: ctx.cwd, ...adapters }, mapUrl)
  ctx.ui.notify(renderCheckOutcome(outcome), outcome.kind === 'ok' ? 'info' : 'warning')
}
