/**
 * Norn's Pi extension: the sole production operator adapter (design.md §2.1, §6).
 *
 * It parses command syntax, renders typed runner events, and returns operator
 * responses. It owns no scheduling, retry, evidence, or side-effect policy,
 * and this scaffold performs no reads or writes beyond loading the extension
 * (design.md §2.3).
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { commandSummary, parseNornInvocation } from '../runner/commands.ts'
import { renderPending, renderSummary, renderUnknown } from './render.ts'

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
          ctx.ui.notify(renderPending(invocation.subcommand), 'info')
          break
      }
    },
  })
}
