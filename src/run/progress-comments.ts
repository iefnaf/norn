/**
 * The staged progress comments (design.md §9, §10.2, §12, §15 — ticket #40).
 *
 * The issue-comment area is a staged, human-readable record of progress:
 * one work handoff comment per worker round, one review verdict comment per
 * reviewer round, a terminal park comment per parked Ticket, and a
 * completion-findings comment on the Map issue when map completion gates
 * fail. All rendering is coordinator-owned — agent prose (worker summaries,
 * reviewer findings, block reasons) flows only through the deterministic
 * completion channel and is sanitized here before it reaches GitHub.
 *
 * **Side-record classification (§9).** These comments are idempotent,
 * replayable side records, not shared writes:
 *
 * - no §10–§15 predicate reads them — the §14 envelope grammar ignores
 *   unmarked prose, and sealing, shipping, closing, and completion depend
 *   only on machine-verified evidence;
 * - each carries a unique first-line identity marker and is posted with
 *   scan-before-write, so a re-execution converges on the existing comment
 *   instead of duplicating it — their write state can never produce an
 *   ambiguity that recovery must resolve;
 * - a failed or unknown write therefore degrades to a recorded warning (the
 *   staged record may have a hole) — it never blocks, parks differently, or
 *   makes the run recoverable. Work outcomes stay ticket-scoped with
 *   `sharedWrite: 'none'`, and run-level accounting is untouched until the
 *   first push. The Delivered Comment and Delivery Record of #35 keep their
 *   guarded-write semantics unchanged.
 *
 * Everything here is deterministic: identical inputs render identical
 * bytes, so replays compare whole bodies for idempotency.
 */
import type { CommentLanguage } from '../config/run-config.ts'
import type { EvidenceIssueLocator, IssueEvidenceReadOutcome } from '../evidence/read.ts'
import type { GitHubIssueWriter } from '../adapters/github-gateway.ts'
import type { SettledVerdict } from '../work/round-gate.ts'

// ---------------------------------------------------------------------------
// Identity markers (first-line HTML comments, like the Delivered Comment)
// ---------------------------------------------------------------------------

/** The first line of a work handoff comment; unique per attempt round. */
export const HANDOFF_MARKER_PREFIX = '<!-- norn:handoff '
/** The first line of a review verdict comment; unique per attempt round. */
export const VERDICT_MARKER_PREFIX = '<!-- norn:verdict '
/** The first line of a park comment; unique per run and Ticket. */
export const PARKED_MARKER_PREFIX = '<!-- norn:parked '
/** The first line of a completion findings comment; unique per attempt. */
export const FINDINGS_MARKER_PREFIX = '<!-- norn:findings '

/**
 * The identity of one Work round: run, Ticket, Work attempt, and round
 * number. The Work attempt ID separates rework attempts whose round numbers
 * restart and whose zero-delta candidates could otherwise share commit OIDs.
 */
export type RoundCommentIdentity = {
  readonly runId: string
  readonly ticketNumber: number
  readonly workAttemptId: string
  readonly round: number
}

/**
 * The identity line of one round comment: `<!-- norn:<kind>
 * <runId>#<ticketNumber>@<workAttemptId>/r<round> -->`.
 */
function roundMarker(kind: 'handoff' | 'verdict', identity: RoundCommentIdentity): string {
  const { runId, ticketNumber, workAttemptId, round } = identity
  return `<!-- norn:${kind} ${runId}#${ticketNumber}@${workAttemptId}/r${round} -->`
}

/** The identity line of the work handoff comment of one round. */
export function handoffMarker(identity: RoundCommentIdentity): string {
  return roundMarker('handoff', identity)
}

/** The identity line of the review verdict comment of one round. */
export function verdictMarker(identity: RoundCommentIdentity): string {
  return roundMarker('verdict', identity)
}

/**
 * The identity line of one park comment: `<!-- norn:parked
 * <runId>#<ticketNumber> -->`. A Ticket parks at most once per run — once
 * parked it never re-enters this run's frontier — so the run ID plus ticket
 * number is a stable, replay-derivable identity for the park event.
 */
export function parkedMarker(runId: string, ticketNumber: number): string {
  return `${PARKED_MARKER_PREFIX}${runId}#${ticketNumber} -->`
}

/**
 * The identity line of one completion findings comment: `<!-- norn:findings
 * <runId>@<completionAttemptId> -->`. Each failed completion attempt posts
 * its own findings once; a recovered restart is a new attempt with fresh
 * gates, so its comment carries a distinct identity.
 */
export function findingsMarker(runId: string, completionAttemptId: string): string {
  return `${FINDINGS_MARKER_PREFIX}${runId}@${completionAttemptId} -->`
}

// ---------------------------------------------------------------------------
// Prose sanitation and excerpts
// ---------------------------------------------------------------------------

/** The machine-marker words no staged comment may carry from agent prose. */
const NORN_MARKER_WORD = /norn:(?:record|delivered|handoff|verdict|parked|findings)/g

/**
 * Redact every Norn machine-marker word from agent prose before it is
 * rendered into a staged comment. Worker summaries are already validated
 * against `norn:record` at settlement; reviewer findings and block reasons
 * have no such contract, so every agent-sourced string passes through here.
 * The result is deterministic and cannot imitate or poison the §14 envelope
 * grammar.
 */
export function sanitizeStagedProse(text: string): string {
  return text.replace(NORN_MARKER_WORD, 'norn:…')
}

/** A deterministic bounded excerpt: short text stays verbatim. */
export function excerptOf(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/** The bounded command-output excerpt of one staged comment. */
const COMMAND_EXCERPT_CHARS = 1_600

// ---------------------------------------------------------------------------
// Shared OID helpers
// ---------------------------------------------------------------------------

/** The raw hex of an OID, with its `sha1:`/`sha256:` format prefix removed. */
function oidHex(oid: string): string {
  const separator = oid.indexOf(':')
  return separator === -1 ? oid : oid.slice(separator + 1)
}

function shortOid(oid: string): string {
  return oidHex(oid).slice(0, 7)
}

// ---------------------------------------------------------------------------
// Rendering: the work handoff comment (§10.2)
// ---------------------------------------------------------------------------

/** Everything the round handoff comment needs. */
export type HandoffCommentInput = {
  readonly identity: RoundCommentIdentity
  readonly language: CommentLanguage
  /** The worker's delivery summary, sanitized but otherwise verbatim. */
  readonly summary: string
  /** The base the round's candidate was judged against. */
  readonly base: string
  /** The independently verified candidate facts of this round. */
  readonly candidate: {
    readonly commit: string
    readonly treeOid: string
    readonly zeroDelta: boolean
  }
}

/**
 * Render the work handoff comment of one round: identity marker, a compact
 * headline, the worker's summary, and the deterministic base-to-candidate
 * facts — posted after the worker settles and candidate verification
 * passes, before the round's setup and test gates.
 */
export function renderHandoffComment(input: HandoffCommentInput): string {
  const { identity, language, candidate } = input
  const round = identity.round
  const base = shortOid(input.base)
  const commit = shortOid(candidate.commit)
  const tree = shortOid(candidate.treeOid)
  const summary = sanitizeStagedProse(input.summary.trim())
  if (language === 'zh') {
    return (
      `${handoffMarker(identity)}\n` +
      `第 ${round} 轮实现交付：worker 已交付候选 \`${commit}\`。\n` +
      `\n${summary}\n` +
      `\n---\n\n` +
      `**Base** \`${base}\` → 候选 \`${commit}\` · 候选树 \`${tree}\`` +
      (candidate.zeroDelta ? '\n零差异：候选树与 base 相同。\n' : '\n')
    )
  }
  return (
    `${handoffMarker(identity)}\n` +
    `Round ${round} work handoff: the worker settled candidate \`${commit}\`.\n` +
    `\n${summary}\n` +
    `\n---\n\n` +
    `**Base** \`${base}\` → candidate \`${commit}\` · tree \`${tree}\`` +
    (candidate.zeroDelta ? '\nzero-delta: the candidate tree equals the base.\n' : '\n')
  )
}

// ---------------------------------------------------------------------------
// Rendering: the review verdict comment (§10.2)
// ---------------------------------------------------------------------------

/** The typed verdict a verdict comment renders. */
export type VerdictCommentValue = SettledVerdict

/** Everything the review verdict comment needs. */
export type VerdictCommentInput = {
  readonly identity: RoundCommentIdentity
  readonly language: CommentLanguage
  readonly verdict: VerdictCommentValue
  readonly reviewer: {
    readonly model: string
    readonly thinking: string
  }
}

/**
 * Render the review verdict comment of one round: `pass` with both axes and
 * the advance-to-Ship note, or `iterate` with the reviewer's axis-labelled
 * findings (sanitized) and the note that the next worker round addresses
 * them. Reviewer `block` verdicts park the Ticket instead and surface
 * through the park comment.
 */
export function renderVerdictComment(input: VerdictCommentInput): string {
  const { identity, language, verdict, reviewer } = input
  const round = identity.round
  const reviewerLine = `**Reviewer** \`${reviewer.model}\` (${reviewer.thinking})`
  if (verdict.discriminant === 'pass') {
    if (language === 'zh') {
      return (
        `${verdictMarker(identity)}\n` +
        `第 ${round} 轮评审：**pass** —— Standards 与 Spec 两个轴均通过，候选进入 Ship。\n` +
        `\n${reviewerLine}\n`
      )
    }
    return (
      `${verdictMarker(identity)}\n` +
      `Round ${round} review: **pass** — both axes (Standards and Spec) pass; the candidate ` +
      `proceeds to Ship.\n` +
      `\n${reviewerLine}\n`
    )
  }
  const findings = sanitizeStagedProse(verdict.feedback.trim())
  if (language === 'zh') {
    return (
      `${verdictMarker(identity)}\n` +
      `第 ${round} 轮评审：**iterate** —— 下一轮 worker 将处理以下发现。\n` +
      `\n${reviewerLine}\n` +
      `\n---\n\n` +
      `${findings}\n`
    )
  }
  return (
    `${verdictMarker(identity)}\n` +
    `Round ${round} review: **iterate** — the next worker round addresses these findings.\n` +
    `\n${reviewerLine}\n` +
    `\n---\n\n` +
    `${findings}\n`
  )
}

// ---------------------------------------------------------------------------
// Rendering: the park comment (§12)
// ---------------------------------------------------------------------------

/** Everything the park comment needs. */
export type ParkedCommentInput = {
  readonly runId: string
  readonly ticketNumber: number
  readonly language: CommentLanguage
  /** The parked outcome's closed machine code. */
  readonly code: string
  /** The parked outcome's operator-facing reason. */
  readonly reason: string
  /** Reviewer findings, when a ship review gate failed (§11.2). */
  readonly findings?: string
}

/**
 * Render the terminal park comment of one Ticket: the outcome code and
 * reason, the note that a later run can pick the Ticket up with its
 * accumulated feedback, and — for a failed ship review gate — the
 * reviewer's findings (sanitized).
 */
export function renderParkedComment(input: ParkedCommentInput): string {
  const { language, code, reason } = input
  const marker = parkedMarker(input.runId, input.ticketNumber)
  const findings =
    input.findings === undefined ? '' : `\n**Reviewer findings:**\n\n${sanitizeStagedProse(input.findings.trim())}\n`
  if (language === 'zh') {
    return (
      `${marker}\n` +
      `本轮运行已搁置该 ticket：\`${code}\` —— ${reason}。\n` +
      `\n本轮运行不会再次尝试；后续运行会带着累计反馈重新开始。\n` +
      findings
    )
  }
  return (
    `${marker}\n` +
    `Parked for this run: \`${code}\` — ${reason}.\n` +
    `\nThis run will not attempt the Ticket again; a later run can pick it up with its ` +
    `accumulated feedback.\n` +
    findings
  )
}

// ---------------------------------------------------------------------------
// Rendering: the completion findings comment (§15)
// ---------------------------------------------------------------------------

/** The narrowed shape of a completion gate-failure detail value. */
export type CompletionGateDetail =
  | { readonly kind: 'review-iterate'; readonly feedback: string }
  | { readonly kind: 'review-block'; readonly code: string; readonly reason: string }
  | {
      readonly kind: 'command'
      readonly argv: readonly string[]
      readonly cause: string
      readonly exitCode: number | null
      readonly stdout: string
      readonly stderr: string
    }
  | { readonly kind: 'unknown' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Narrow one gate-failure evidence `detail` value into the typed rendering
 * shape; anything unexpected stays `unknown` and renders generically.
 */
export function completionGateDetailOf(detail: unknown): CompletionGateDetail {
  if (!isRecord(detail)) return { kind: 'unknown' }
  if (detail.verdict === 'iterate' && typeof detail.feedback === 'string') {
    return { kind: 'review-iterate', feedback: detail.feedback }
  }
  if (
    detail.verdict === 'block' &&
    typeof detail.code === 'string' &&
    typeof detail.reason === 'string'
  ) {
    return { kind: 'review-block', code: detail.code, reason: detail.reason }
  }
  if (
    Array.isArray(detail.argv) &&
    detail.argv.every((part) => typeof part === 'string') &&
    typeof detail.cause === 'string' &&
    (detail.exitCode === null || typeof detail.exitCode === 'number') &&
    typeof detail.stdout === 'string' &&
    typeof detail.stderr === 'string'
  ) {
    return {
      kind: 'command',
      argv: detail.argv as string[],
      cause: detail.cause,
      exitCode: detail.exitCode,
      stdout: detail.stdout,
      stderr: detail.stderr,
    }
  }
  return { kind: 'unknown' }
}

/** Everything the completion findings comment needs. */
export type CompletionFindingsInput = {
  readonly runId: string
  readonly completionAttemptId: string
  readonly language: CommentLanguage
  readonly gate: 'setup' | 'tests' | 'review'
  readonly detail: CompletionGateDetail
  readonly reviewer?: {
    readonly model: string
    readonly thinking: string
  }
}

/**
 * Render the map completion findings comment of one failed attempt (§15):
 * which gate failed, what was found — the completion reviewer's verdict and
 * findings for a review gate, a bounded command excerpt for setup or tests —
 * and the note that the Map remains open with the run blocked.
 */
export function renderCompletionFindingsComment(input: CompletionFindingsInput): string {
  const { language, gate, detail } = input
  const marker = findingsMarker(input.runId, input.completionAttemptId)
  const reviewerLine =
    input.reviewer === undefined
      ? ''
      : `**Reviewer** \`${input.reviewer.model}\` (${input.reviewer.thinking})`

  const gateWord = language === 'zh' ? (gate === 'review' ? '评审' : gate === 'tests' ? '测试' : '安装') : gate
  const remainsOpen =
    language === 'zh'
      ? '地图保持开启；本轮运行以 blocked(map-completion-gate-failed) 结束。'
      : 'The Map remains open; the run ends blocked(map-completion-gate-failed).'

  if (detail.kind === 'review-iterate') {
    const findings = sanitizeStagedProse(detail.feedback.trim())
    if (language === 'zh') {
      return (
        `${marker}\n` +
        `地图完成${gateWord}未通过：**iterate** —— 完成评审要求整改。\n` +
        `\n${remainsOpen}\n` +
        (reviewerLine === '' ? '' : `\n${reviewerLine}\n`) +
        `\n---\n\n${findings}\n`
      )
    }
    return (
      `${marker}\n` +
      `Map completion ${gate} failed: **iterate** — the completion review requires changes.\n` +
      `\n${remainsOpen}\n` +
      (reviewerLine === '' ? '' : `\n${reviewerLine}\n`) +
      `\n---\n\n${findings}\n`
    )
  }

  if (detail.kind === 'review-block') {
    if (language === 'zh') {
      return (
        `${marker}\n` +
        `地图完成${gateWord}未通过：**block**（\`${detail.code}\`）—— ${detail.reason}。\n` +
        `\n${remainsOpen}\n` +
        (reviewerLine === '' ? '' : `\n${reviewerLine}\n`)
      )
    }
    return (
      `${marker}\n` +
      `Map completion ${gate} failed: **block** (\`${detail.code}\`) — ${detail.reason}.\n` +
      `\n${remainsOpen}\n` +
      (reviewerLine === '' ? '' : `\n${reviewerLine}\n`)
    )
  }

  if (detail.kind === 'command') {
    const argv = detail.argv.join(' ')
    const exitWord = detail.exitCode === null ? 'timeout' : `exit ${detail.exitCode}`
    const output = excerptOf(
      detail.stdout.trim() === '' ? detail.stderr : detail.stdout,
      COMMAND_EXCERPT_CHARS,
    )
    const commandLine =
      language === 'zh'
        ? `\`${argv}\` —— ${exitWord}（${detail.cause}）`
        : `\`${argv}\` — ${exitWord} (${detail.cause})`
    return (
      `${marker}\n` +
      (language === 'zh'
        ? `地图完成${gateWord}未通过：命令未通过 gate。\n`
        : `Map completion ${gate} failed: the command did not pass its gate.\n`) +
      `\n${commandLine}\n` +
      `\n${remainsOpen}\n` +
      `\n---\n\n\`\`\`\n${output}\n\`\`\`\n`
    )
  }

  return (
    `${marker}\n` +
    (language === 'zh'
      ? `地图完成${gateWord}未通过。\n`
      : `Map completion ${gate} failed.\n`) +
    `\n${remainsOpen}\n`
  )
}

// ---------------------------------------------------------------------------
// The posting engine: scan-before-write with side-record semantics
// ---------------------------------------------------------------------------

/** The two gateway seams one staged comment needs. */
export type ProgressCommentSeams = {
  readonly loadComments: (locator: EvidenceIssueLocator) => Promise<IssueEvidenceReadOutcome>
  readonly writeComment: GitHubIssueWriter['writeIssueComment']
}

/**
 * Post one staged comment with scan-before-write idempotency: the issue is
 * read first and an existing comment whose first line equals the identity
 * marker is reused (a divergent body warns and stays untouched); otherwise
 * the exact rendered body is written. Side-record semantics: every failure
 * — read error, read block, or unknown write — degrades to one warning and
 * never fails the caller (§9 classification, module header).
 *
 * @returns the warnings to record; never throws.
 */
export async function postProgressComment(
  seams: ProgressCommentSeams,
  locator: EvidenceIssueLocator,
  expected: string,
  marker: string,
  what: string,
): Promise<readonly string[]> {
  const read = await seams.loadComments(locator)
  if (read.kind !== 'ok') {
    return [
      `the staged comment (${what}) could not be scanned on #${locator.number} and was not ` +
        `written: ${read.reason}`,
    ]
  }
  const existing = read.value.comments.find(
    (comment) => comment.body.split('\n')[0] === marker,
  )
  if (existing !== undefined) {
    if (existing.body !== expected) {
      return [
        `the staged comment (${what}) of #${locator.number} already exists with different ` +
          'bytes; it was left untouched',
      ]
    }
    return []
  }
  const written = await seams.writeComment(locator, expected)
  if (written.kind !== 'ok') {
    return [
      `the staged comment (${what}) of #${locator.number} returned an unknown write result ` +
        `and was recorded as a warning: ${written.reason}`,
    ]
  }
  return []
}
