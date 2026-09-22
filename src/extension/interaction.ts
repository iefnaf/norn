/**
 * The production `InitInteraction` over Pi's dialog primitives (design.md
 * §2.1, §6): each typed runner question becomes dialogs, and operator input is
 * parsed back into the typed answer shapes. This file renders and parses; it
 * never decides — validation of every answer happens in the runner, and a
 * cancelled dialog surfaces as `undefined`.
 */
import type { InitInteraction, PlausibleRepositoryRemote } from '../runner/init.ts'
import type { AgentRoleInput, CommandSpecInput } from '../runner/init.ts'
import type { AbortInteraction, AbortRunSummary } from '../run/abort.ts'
import type { CatalogModel, ThinkingLevel } from '../adapters/model-catalog.ts'
import { SUGGESTED_COMMAND_TIMEOUT_MS } from '../config/run-config.ts'

/** The dialog slice of Pi's extension UI this adapter needs. */
export type DialogUi = {
  select(title: string, options: readonly string[]): Promise<string | undefined>
  confirm(title: string, message: string): Promise<boolean>
  input(title: string, placeholder?: string): Promise<string | undefined>
  notify(message: string, level?: 'info' | 'warning' | 'error'): void
}

const FIELD_LABELS: Record<'maxWorkRounds' | 'maxPushRetries' | 'concurrency', string> = {
  maxWorkRounds: 'Max worker rounds per ticket',
  maxPushRetries: 'Max push retries after losing a push race',
  concurrency: 'Repository-wide Work concurrency',
}

function remoteLabel(remote: PlausibleRepositoryRemote): string {
  return `${remote.owner}/${remote.name} @ ${remote.githubHost} (remotes: ${remote.remoteNames.join(', ')})`
}

function modelLabel(model: CatalogModel): string {
  return `${model.id} — ${model.displayName}`
}

function parseNumber(text: string | undefined, suggested: number): number {
  const trimmed = text === undefined ? '' : text.trim()
  return trimmed === '' ? suggested : Number(trimmed)
}

/** The persisted-facts summary the confirmation dialog shows (§2.3). */
function abortSummaryLines(summary: AbortRunSummary): string {
  return [
    `Norn abort — run ${summary.runId}`,
    `State: ${summary.status} · Wave ${summary.wave}`,
    `Map: ${summary.mapUrl}`,
    `Parked tickets: ${summary.parkedTickets.length === 0 ? 'none' : summary.parkedTickets.join(', ')}`,
    summary.pendingSharedWrite
      ? 'Shared writes: the persisted state already proves at least one — abort reconciles them; pushed commits and remote evidence are never rolled back.'
      : 'Shared writes: none proven by the persisted state.',
    'Aborting is explicit and final: Norn stops or reconciles every run-owned process,',
    'records the run as aborted without deleting its state, and never removes remote',
    'evidence. To confirm, type the exact Run ID. An empty answer cancels.',
  ].join('\n')
}

/** Build the operator-facing abort interaction over Pi dialogs. */
export function dialogAbortInteraction(ui: Pick<DialogUi, 'input' | 'notify'>): AbortInteraction {
  return {
    async confirmRunId(summary) {
      ui.notify(abortSummaryLines(summary), 'info')
      return ui.input(
        `Abort Norn run ${summary.runId}? Type the exact Run ID to confirm`,
        summary.runId,
      )
    },
  }
}

/** Build the operator-facing interaction over Pi dialogs. */
export function dialogInitInteraction(ui: DialogUi): InitInteraction {
  return {
    async selectRepositoryIdentity(options) {
      const selection = await ui.select(
        'Multiple plausible GitHub remotes — select the repository for this checkout:',
        options.map(remoteLabel),
      )
      return options.find((remote) => remoteLabel(remote) === selection)
    },

    async chooseTargetBranch(suggested) {
      const answer = await ui.input(
        `Target branch for direct pushes (Enter for the remote default)`,
        suggested,
      )
      if (answer === undefined) return undefined
      const trimmed = answer.trim()
      return trimmed === '' ? suggested : trimmed
    },

    async chooseCommandList(kind) {
      const entries: CommandSpecInput[] = []
      const purpose =
        kind === 'setup'
          ? 'Setup commands run before tests in every clean workspace Norn creates.'
          : 'Tests are the machine gate on delivery and completion; at least one is required.'
      ui.notify(`Configuring ${kind} commands. ${purpose}`, 'info')
      while (
        await ui.confirm(
          `Add ${kind} command #${entries.length + 1}?`,
          kind === 'setup'
            ? 'Optional — answer No to finish with no setup commands.'
            : 'Required — the configured test list must not be empty.',
        )
      ) {
        const argvLine = await ui.input(
          `${kind} command argv (space-separated, argv[0] is the executable; no shell)`,
          kind === 'setup' ? 'npm ci' : 'npm test',
        )
        if (argvLine === undefined) return undefined
        const argv = argvLine.trim().split(/\s+/).filter((argument) => argument !== '')
        if (argv.length === 0) continue
        const timeoutText = await ui.input(
          `${kind} command timeout in milliseconds`,
          String(SUGGESTED_COMMAND_TIMEOUT_MS),
        )
        if (timeoutText === undefined) return undefined
        entries.push({ argv, timeoutMs: parseNumber(timeoutText, SUGGESTED_COMMAND_TIMEOUT_MS) })
      }
      return entries
    },

    async chooseAgentRole(role, models, suggestedTimeoutMs): Promise<AgentRoleInput | undefined> {
      if (models.length === 0) return undefined
      const selection = await ui.select(
        `Exact ${role} model (validated against the authenticated catalog)`,
        models.map(modelLabel),
      )
      const model = models.find((candidate) => modelLabel(candidate) === selection)
      if (model === undefined) return undefined
      const thinking = await ui.select(
        `${role} thinking level for ${model.id}`,
        model.thinkingLevels as readonly ThinkingLevel[],
      )
      if (thinking === undefined || !(model.thinkingLevels as readonly string[]).includes(thinking)) {
        return undefined
      }
      const timeoutText = await ui.input(
        `${role} wall-clock budget per agent invocation in milliseconds`,
        String(suggestedTimeoutMs),
      )
      if (timeoutText === undefined) return undefined
      return { model: model.id, thinking, timeoutMs: parseNumber(timeoutText, suggestedTimeoutMs) }
    },

    async chooseInteger(field, suggested, minimum) {
      const answer = await ui.input(
        `${FIELD_LABELS[field]} (minimum ${minimum})`,
        String(suggested),
      )
      if (answer === undefined) return undefined
      return parseNumber(answer, suggested)
    },

    async chooseTrustedEvidenceAuthors(actor) {
      ui.notify(
        `Authenticated GitHub actor ${actor.login} (${actor.id}) is always a trusted evidence author.`,
        'info',
      )
      const answer = await ui.input(
        'Additional trusted evidence author node IDs (comma-separated, Enter for none)',
        'none',
      )
      if (answer === undefined) return undefined
      return answer
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== '')
    },

    async confirmReplaceConfig(existing, proposed) {
      const message = [
        'A Norn configuration already exists for this repository.',
        '',
        '--- existing config.json ---',
        existing.configJson.trimEnd(),
        '',
        '--- proposed config.json ---',
        proposed.configJson.trimEnd(),
        '',
        'Replace it? This is shared by every local checkout of this repository.',
      ].join('\n')
      return ui.confirm('Replace existing Norn Run Config?', message)
    },
  }
}
