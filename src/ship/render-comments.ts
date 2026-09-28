/**
 * The human-readable delivery comments (design.md §10.2, §11.3, §14 —
 * ticket #35).
 *
 * Two rendered shapes, both pure functions over sealed facts plus the Run
 * Config `commentLanguage` (§8):
 *
 * - the **delivered comment**, posted once per sealed `ShippableChange`
 *   before the push: deterministic gate facts — branch, candidate commit,
 *   ordered tests, worker and reviewer models — plus the not-yet-merged
 *   note. Since #40's staged record it carries no worker summary: the
 *   round handoff comment (`src/run/progress-comments.ts`) owns the
 *   summary, so a one-round Ticket reads without repetition. It is an
 *   unmarked comment — the §14 envelope grammar ignores it entirely — made
 *   replay-idempotent by a `<!-- norn:delivered … -->` identity line the
 *   Ship stage scans for before writing;
 * - the **merged record comment**, what the close stage writes around the
 *   sealed Delivery Record: a merge headline plus the machine envelope
 *   folded into `<details>` (§14 prose-outside-the-envelope). The machine
 *   bytes stay exactly `formatRecordEnvelope`'s, so `deliveryId`
 *   recomputation, duplicate selection, and every predicate are unchanged.
 *
 * Everything here is deterministic: identical inputs render identical
 * bytes, so replays can compare whole bodies for idempotency.
 */
import type { CommentLanguage } from '../config/run-config.ts'
import { canonicalJson } from '../core/canonical-json.ts'
import type { CanonicalJsonValue } from '../core/canonical-json.ts'
import { formatFoldedRecordComment } from '../evidence/envelope.ts'
import type { DeliveryRecordV1, EvidenceGateV1, ShippableChange } from '../runstate/types.ts'

/** The first line of a delivered comment; unique per sealed candidate. */
export const DELIVERED_MARKER_PREFIX = '<!-- norn:delivered '

/** The raw hex of an OID, with its `sha1:`/`sha256:` format prefix removed. */
function oidHex(oid: string): string {
  const separator = oid.indexOf(':')
  return separator === -1 ? oid : oid.slice(separator + 1)
}

function shortOid(oid: string): string {
  return oidHex(oid).slice(0, 7)
}

function shortDigest(digest: string): string {
  const separator = digest.indexOf(':')
  return (separator === -1 ? digest : digest.slice(separator + 1)).slice(0, 7)
}

/**
 * The identity line of one delivered comment: `<!-- norn:delivered
 * <runId>#<ticketNumber>@<candidate-hex> -->`. Components are restricted to
 * safe characters — the ticket number stands in for the base64url issue ID,
 * which could contain a `--` sequence and break the HTML comment.
 */
export function deliveredMarker(
  runId: string,
  ticketNumber: number,
  candidateCommit: string,
): string {
  return `${DELIVERED_MARKER_PREFIX}${runId}#${ticketNumber}@${oidHex(candidateCommit)} -->`
}

/** One gate-facts line shared by both languages' generated prose. */
function gateFactsLine(change: ShippableChange, gate: EvidenceGateV1): string {
  const tests = change.tests.map((test) => `\`${test.argv.join(' ')}\` ✅ exit ${test.exitCode}`)
  return [
    `**Gate**: ${tests.join(' · ')}`,
    `worker \`${gate.worker.model}\` (${gate.worker.thinking})`,
    `reviewer \`${change.review.model}\` (${change.review.thinking}) → **${change.review.verdict}**`,
  ].join(' · ')
}

/** The base → candidate → tree line of the delivered comment. */
function baseToCandidateLine(change: ShippableChange, language: CommentLanguage): string {
  const candidateWord = language === 'zh' ? '候选' : 'candidate'
  return (
    `**Base** \`${shortOid(change.baseSha)}\` → ${candidateWord} ` +
    `\`${shortOid(change.candidateCommit)}\` · tree \`${shortOid(change.candidateTreeOid)}\``
  )
}

/** Everything the delivered comment needs beyond its seams. */
export type DeliveredCommentInput = {
  readonly runId: string
  readonly change: ShippableChange
  readonly gate: EvidenceGateV1
  /** The delivery's target branch, for the not-yet-merged note. */
  readonly targetBranch: string
  readonly language: CommentLanguage
}

/**
 * Render the delivered comment: identity marker, delivery headline, gate
 * facts, and the not-yet-merged note — facts only. The worker's sealed
 * summary is not rendered here: the round handoff comment of #40 already
 * carried it at the moment the worker settled, so repeating it at Ship
 * would duplicate the prose on every one-round Ticket.
 */
export function renderDeliveredComment(input: DeliveredCommentInput): string {
  const { change, gate, language, runId, targetBranch } = input
  const marker = deliveredMarker(runId, change.ticket.number, change.candidateCommit)
  const branch = change.workspace.kind === 'ticket' ? change.workspace.branch : '(detached)'
  const facts = `${gateFactsLine(change, gate)}\n${baseToCandidateLine(change, language)}\n`
  if (language === 'zh') {
    return (
      `${marker}\n` +
      `已在分支 \`${branch}\` 完成实现（候选提交 \`${shortOid(change.candidateCommit)}\`）。\n\n` +
      `---\n\n` +
      `${facts}` +
      `尚未合并进 \`${targetBranch}\`。\n`
    )
  }
  return (
    `${marker}\n` +
    `Delivered on branch \`${branch}\` (commit \`${shortOid(change.candidateCommit)}\`).\n\n` +
    `---\n\n` +
    `${facts}` +
    `Not merged to \`${targetBranch}\` yet.\n`
  )
}

/** Everything the merged record comment needs beyond its seams. */
export type MergedCommentInput = {
  readonly record: DeliveryRecordV1
  /** The sealed canonical JSON text of `record` — written byte-identical. */
  readonly canonicalText: string
  /** Whether this delivery carried no new commit (§11.3 zero-delta). */
  readonly zeroDelta: boolean
  readonly language: CommentLanguage
}

/**
 * Render the merged record comment: a merge (or zero-delta) headline plus
 * the sealed Delivery Record folded into `<details>`. The machine envelope
 * inside is byte-identical to `formatRecordEnvelope`, so the §14 duplicate
 * and chronology rules treat this comment exactly like the bare envelope.
 */
export function renderMergedRecordComment(input: MergedCommentInput): string {
  const { record, canonicalText, zeroDelta, language } = input
  const base = record.target.baseSha
  const integrated = record.target.integratedSha
  const branch = record.target.branch
  const headline = zeroDelta
    ? language === 'zh'
      ? `无需合并（zero-delta）：\`${branch}\` 已满足该 ticket（\`${shortOid(integrated)}\`）。gate 测试全绿，评审通过，ticket 关闭；封存的交付记录见下。`
      : `No merge needed (zero-delta): \`${branch}\` already satisfies this ticket (\`${shortOid(integrated)}\`). Gate tests green, review passed; the sealed delivery record follows.`
    : language === 'zh'
      ? `已在 \`${branch}\` 合并（\`${shortOid(integrated)}\`，base \`${shortOid(base)}\`）。gate 测试全绿，评审通过，ticket 关闭；封存的交付记录见下。`
      : `Merged to \`${branch}\` (\`${shortOid(integrated)}\`, base \`${shortOid(base)}\`). Gate tests green, review passed; the ticket is closed with the sealed delivery record below.`
  const label =
    language === 'zh'
      ? `norn 交付记录 · norn-delivery:v1 · deliveryId ${shortDigest(record.deliveryId)}`
      : `norn delivery record · norn-delivery:v1 · deliveryId ${shortDigest(record.deliveryId)}`
  return formatFoldedRecordComment(headline, label, canonicalText)
}
