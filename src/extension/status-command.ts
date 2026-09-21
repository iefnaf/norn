/**
 * `/norn status <map-url>` as an extension command: production wiring and
 * rendering. Like `init`, the extension owns no policy — it hands the map URL
 * to the runner and renders the typed outcome. Status needs no dialogs.
 */
import { homedir } from 'node:os'

import { resolveNornHome } from '../config/paths.ts'
import { readStatus } from '../runner/status.ts'
import type { DialogUi } from './interaction.ts'
import { renderStatusOutcome } from './render.ts'

/** Build the production status deps: the filesystem facts under Norn home. */
export function productionStatusDeps(): { readonly nornHome: string } {
  return { nornHome: resolveNornHome(process.env, homedir()) }
}

/** Execute `/norn status <map-url>` and render its typed outcome. */
export async function executeStatusCommand(
  mapUrl: string,
  ui: Pick<DialogUi, 'notify'>,
  deps: { readonly nornHome: string } = productionStatusDeps(),
): Promise<void> {
  const outcome = await readStatus(deps, mapUrl)
  ui.notify(renderStatusOutcome(outcome), outcome.kind === 'ok' ? 'info' : 'warning')
}
