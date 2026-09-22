/**
 * The Norn completion extension loaded by every agent invocation's Pi
 * process (design.md §17).
 *
 * It is deliberately small: read the launch context from the environment,
 * register one `norn_complete` tool, and create exactly one completion
 * sidecar atomically — validating the typed handoff or verdict, binding it to
 * the run, role, phase, Ticket, work attempt, workspace, and Pi session
 * identity, and rejecting a conflicting second completion. The tool result
 * asks Pi to stop after a successful completion so the process group exits
 * and the invocation can settle.
 *
 * Settlement is enforced, not merely requested (issue #33): when the agent is
 * about to settle without having called `norn_complete`, the extension
 * appends a bounded corrective entry and requests one continuation; when it
 * settles without ever completing, it shuts the Pi process down so the
 * coordinator observes group-exit-without-sidecar instead of idling at the
 * prompt until the invocation timeout.
 *
 * A Reviewer additionally receives the §10.2 read-only capability set from
 * this extension rather than from Pi's `--tools` allowlist: that allowlist is
 * resolved while extensions load, so a name an extension contributes is not
 * reliably known in time and an unknown name empties the whole set. The
 * Reviewer therefore launches with `--no-builtin-tools`, and this extension
 * registers the four read-only tools plus `norn_complete` itself, which makes
 * the reviewer's capability set independent of CLI startup ordering.
 *
 * The extension never decides orchestration: the sidecar it writes is a
 * protocol artifact, not business evidence.
 */
import { fileURLToPath } from 'node:url'

import { createReadOnlyTools } from '@earendil-works/pi-coding-agent'
import type {
  CustomMessageEntryDraft,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent'

import type {
  AgentCompletion,
  AgentCompletionContext,
} from './completion.ts'
import {
  CompletionStore,
  agentRecordedAt,
  validateCompletionContext,
  validateCompletionForRole,
} from './completion.ts'

export const NORN_COMPLETE_TOOL_NAME = 'norn_complete'

/** Exact tool capability set exposed to every read-only Reviewer. */
export const NORN_REVIEWER_TOOL_ALLOWLIST: readonly string[] = [
  'read',
  'grep',
  'find',
  'ls',
  NORN_COMPLETE_TOOL_NAME,
]

/** Environment variable carrying the coordinator-owned launch context. */
export const NORN_AGENT_CONTEXT_ENV = 'NORN_AGENT_CONTEXT'

/**
 * Maximum corrective settlement nudges before the extension lets the agent
 * settle (and exits). The verdict is already formed when a nudge fires, so a
 * model that can emit the tool call does so on the first reminder; the bound
 * exists only to prevent a settle/continue loop.
 */
export const NORN_SETTLEMENT_NUDGE_LIMIT = 2

/**
 * The corrective entry appended at the settle boundary when the agent's turn
 * ended without the typed handoff. Terminal prose is discarded by the
 * settlement protocol (design.md §17), so the nudge restates the one accepted
 * exit instead of harvesting the prose.
 */
export function settlementNudgeEntry(
  attempt: number,
  limit: number,
): CustomMessageEntryDraft {
  return {
    type: 'custom_message',
    customType: 'norn-settlement-enforcement',
    content:
      `Your answer ended without the required norn_complete handoff, so this Norn ` +
      `invocation has no completion yet; a prose conclusion is discarded by the ` +
      `settlement protocol (reminder ${attempt} of ${limit}). Call norn_complete ` +
      `now with the same conclusion in its typed form — workers submit candidate ` +
      `or block, reviewers submit pass, iterate, or block — and then finish. ` +
      `That tool call is the only accepted way to end this invocation.`,
    display: false,
  }
}

/**
 * State shared between the `norn_complete` tool body and the settlement
 * lifecycle handlers of one agent invocation.
 */
type SettlementState = {
  /** True once a norn_complete call wrote a valid sidecar. */
  completed: boolean
  /** Corrective nudges already appended at settle boundaries. */
  nudges: number
}

/** Absolute path of this extension file, for `pi --extension` launch plans. */
export function completionExtensionPath(): string {
  return fileURLToPath(new URL('./completion-extension.ts', import.meta.url))
}

/**
 * Parse and validate the launch context from an environment mapping. Returns
 * `undefined` when the variable is absent or the context is invalid — in that
 * case the tool is still registered but every call fails, so the failure is
 * visible in the pane rather than silently disabling completion.
 */
export function loadAgentContextFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): AgentCompletionContext | undefined {
  const raw = env[NORN_AGENT_CONTEXT_ENV]
  if (raw === undefined || raw.length === 0) return undefined
  try {
    return validateCompletionContext(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/**
 * The `norn_complete` parameter schema in plain JSON Schema form. TypeBox
 * schemas are JSON Schema, and Pi validates against either; building the
 * schema as a literal keeps this module free of runtime imports from the
 * agent harness so it loads in any Pi process and in tests alike.
 */
const NORN_COMPLETE_PARAMETERS = {
  type: 'object',
  properties: {
    discriminant: {
      type: 'string',
      enum: ['candidate', 'block', 'pass', 'iterate'],
      description:
        'The typed completion: candidate/block for workers, pass/iterate/block for reviewers.',
    },
    claimedCommit: {
      type: 'string',
      description: 'Worker candidate only: the claimed HEAD commit OID, e.g. sha1:<hex>.',
    },
    claimedTreeOid: {
      type: 'string',
      description: 'Worker candidate only: the claimed tree OID of that commit.',
    },
    code: {
      type: 'string',
      description: 'Block only: the closed machine code for this role.',
    },
    reason: { type: 'string', description: 'Block only: operator-facing reason.' },
    feedback: { type: 'string', description: 'Reviewer iterate only: findings for the next round.' },
  },
  required: ['discriminant'],
} as const

export type NornCompleteCallResult =
  | { readonly ok: true; readonly status: 'written' | 'identical'; readonly invocationId: string }
  | { readonly ok: false; readonly problem: string }

/**
 * The tool body, isolated from the Pi API types so it is directly testable:
 * validate the typed completion against the launch context's role, create the
 * one sidecar, and reject anything after the first completion that is not an
 * identical resubmission.
 */
export type NornCompletionSubmitter = (
  params: unknown,
  liveSessionId: string | undefined,
) => Promise<NornCompleteCallResult>

export function createNornCompletionSubmitter(
  context: AgentCompletionContext,
  store: CompletionStore,
): NornCompletionSubmitter {
  // The sidecar identity is stable per logical completion: the first
  // successful call memoizes its exact document, so an identical resubmission
  // is byte-identical and idempotent, while any different second completion
  // is rejected as a conflict. The memo lives for this agent invocation only.
  let memo: { readonly completion: AgentCompletion; readonly recordedAt: string } | undefined

  return async (params, liveSessionId) => {
    if (liveSessionId !== undefined && liveSessionId !== context.piSessionId) {
      return {
        ok: false,
        problem: `this Norn invocation belongs to Pi session ${context.piSessionId}, but this session is ${liveSessionId}`,
      }
    }
    const completion = validateCompletionForRole(params, context.role)
    if (completion === undefined) {
      return { ok: false, problem: `not a valid typed completion for role ${context.role}` }
    }

    let first: { readonly completion: AgentCompletion; readonly recordedAt: string }
    if (memo === undefined) {
      first = { completion, recordedAt: agentRecordedAt() }
    } else if (sameCompletion(memo.completion, completion)) {
      first = memo
    } else {
      return {
        ok: false,
        problem: `invocation ${context.invocationId} already completed with a different typed completion; a conflicting second completion is rejected`,
      }
    }

    const result = await store.write(context, first.completion, first.recordedAt)
    if (result.status === 'conflict') {
      return {
        ok: false,
        problem: `invocation ${context.invocationId} already has a conflicting completion sidecar`,
      }
    }
    memo = first
    return { ok: true, status: result.status, invocationId: context.invocationId }
  }
}

function sameCompletion(a: AgentCompletion, b: AgentCompletion): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The extension entry point. One instance runs inside one agent invocation's
 * Pi process; it must never be registered in the operator's coordinator
 * session (Norn's operator extension lives in `src/extension`).
 */
export default function nornCompletionExtension(pi: ExtensionAPI): void {
  const context = loadAgentContextFromEnv(process.env)
  const settlement: SettlementState = { completed: false, nudges: 0 }

  // The Reviewer's read-only inspection tools. Pi resolves a CLI `--tools`
  // allowlist while extensions load, so a name contributed by an extension
  // may not be known in time — and one unknown name leaves the reviewer with
  // no tools at all, which is exactly how a reviewer ends up unable to call
  // norn_complete. Registering the same read-only built-ins here, on a
  // reviewer launched with `--no-builtin-tools`, removes that ordering
  // dependency entirely: the extension owns the complete capability set.
  if (context?.role === 'reviewer') {
    for (const tool of createReadOnlyTools(process.cwd())) {
      pi.registerTool(tool as Parameters<ExtensionAPI['registerTool']>[0])
    }
  }

  pi.registerTool({
    name: NORN_COMPLETE_TOOL_NAME,
    label: 'Norn completion',
    description:
      'Submit the typed completion for this Norn agent invocation and finish. ' +
      'Workers submit candidate (claimed commit and tree OIDs) or block (closed code + reason); ' +
      'reviewers submit pass, iterate (feedback), or block (closed code + reason). ' +
      'Exactly one completion is accepted; call it once when your task is done.',
    parameters: NORN_COMPLETE_PARAMETERS as never,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (context === undefined) {
        return toolError(
          `Norn completion is unavailable: ${NORN_AGENT_CONTEXT_ENV} is missing or invalid in this process`,
        )
      }
      const submit = createNornCompletionSubmitter(
        context,
        new CompletionStore(context.completionsDir),
      )
      const result = await submit(params, ctx.sessionManager.getSessionId())
      if (!result.ok) return toolError(result.problem)
      settlement.completed = true
      // The settlement protocol requires the complete process group to exit
      // before the invocation can settle (design.md §17). A terminating
      // tool result alone only skips the follow-up LLM call, so a successful
      // completion also shuts this Pi process down.
      ctx.shutdown()
      return {
        content: [
          {
            type: 'text',
            text: `Norn completion ${result.status} for invocation ${result.invocationId}. This agent invocation is complete; finish and exit.`,
          },
        ],
        details: { invocationId: result.invocationId, status: result.status },
        terminate: true,
      }
    },
  })

  // Enforce settlement (issue #33): without this, an agent whose turn ends in
  // a prose verdict never calls norn_complete, and the process idles at the
  // prompt until the coordinator's invocation timeout — ~30 minutes of dead
  // wall-clock for a condition detectable in seconds. Two lifecycle hooks
  // close that gap without harvesting prose as a verdict.
  pi.on('agent_before_settle', (event) => {
    if (context === undefined || settlement.completed) return
    if (settlement.nudges >= NORN_SETTLEMENT_NUDGE_LIMIT) return
    settlement.nudges += 1
    return {
      entries: [
        ...event.entries,
        settlementNudgeEntry(settlement.nudges, NORN_SETTLEMENT_NUDGE_LIMIT),
      ],
      continue: true,
    }
  })

  pi.on('agent_settled', (_event, ctx) => {
    if (context === undefined || settlement.completed) return
    // The agent settled without ever completing: exit now so the coordinator
    // observes group-exit-without-sidecar and routes it through the existing
    // recoverable protocol-error path instead of waiting out the timeout.
    ctx.shutdown()
  })

  // Re-apply the closed read-only allowlist before every Reviewer turn. The
  // names are registered above and no CLI `--tools` filter competes with
  // them, so this is authoritative; verifying it here fails the invocation
  // loudly instead of letting a reviewer reply in prose and idle forever.
  if (context?.role === 'reviewer') {
    pi.on('before_agent_start', (_event, ctx) => {
      pi.setActiveTools([...NORN_REVIEWER_TOOL_ALLOWLIST])
      if (!pi.getActiveTools().includes(NORN_COMPLETE_TOOL_NAME)) {
        console.error(
          `Norn completion is unavailable: this Reviewer started without ${NORN_COMPLETE_TOOL_NAME} ` +
            'and cannot satisfy the settlement protocol. Exiting without a completion.',
        )
        ctx.shutdown()
      }
    })
  }
}

type ToolContent = { readonly type: 'text'; readonly text: string }

function toolError(text: string): { content: ToolContent[]; details: unknown } {
  return {
    content: [{ type: 'text', text: `norn_complete error: ${text}` }],
    details: { error: text },
  }
}
