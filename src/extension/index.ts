/**
 * Norn's Pi extension: the sole production operator adapter (design.md §2.1, §6).
 *
 * It parses command syntax, renders typed runner events, and returns operator
 * responses. It owns no scheduling, retry, evidence, or side-effect policy.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { commandSummary, parseNornInvocation } from '../runner/commands.ts'
import { executeInitCommand } from './init-command.ts'
import { renderInitTakesNoArguments, renderPending, renderSummary, renderUnknown } from './render.ts'

export default function (pi: ExtensionAPI): void {
  pi.registerCommand('norn', {
    description: 'Work GitHub Task Maps: parallel Work, serial Ship, evidence-bound completion',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return

      const invocation = parseNornInvocation(args)
      switch (invocation.kind) {
        case 'summary':
          ctx.ui.notify(renderSummary(commandSummary()), 'info')
          break
        case 'unknown':
          ctx.ui.notify(renderUnknown(invocation.input, commandSummary()), 'info')
          break
        case 'subcommand':
          if (invocation.subcommand.name === 'init') {
            if (invocation.args !== '') {
              ctx.ui.notify(renderInitTakesNoArguments(), 'warning')
              return
            }
            await executeInitCommand({
              cwd: ctx.cwd,
              ui: ctx.ui,
              modelRegistry: ctx.modelRegistry,
            })
          } else {
            ctx.ui.notify(renderPending(invocation.subcommand), 'info')
          }
          break
      }
    },
  })
}
