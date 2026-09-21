import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { canonicalJson } from '../src/core/canonical-json.ts'
import {
  NORN_RECORD_MARKER,
  formatRecordEnvelope,
  parseRecordEnvelope,
} from '../src/evidence/envelope.ts'

const RECORD = JSON.parse(
  '{"actorId":"I_actor","gate":{"reviewer":{"family":"provider-b","model":"provider-b/model-y","provider":"provider-b","thinking":"high"},"tests":[{"argv":["npm","test"],"timeoutMs":120000}],"worker":{"family":"provider-a","model":"provider-a/model-x","provider":"provider-a","thinking":"medium"}},"schema":"norn-delivery:v1"}',
)

describe('parseRecordEnvelope — the §14 comment grammar', () => {
  it('parses the canonical envelope written by formatRecordEnvelope', () => {
    const body = formatRecordEnvelope(canonicalJson(RECORD))
    const parsed = parseRecordEnvelope(body)
    assert.equal(parsed.kind, 'record')
    if (parsed.kind === 'record') {
      assert.deepEqual(parsed.value, RECORD)
      assert.equal(parsed.canonicalText, canonicalJson(RECORD))
    }
  })

  it('accepts prose before and after the envelope', () => {
    const body = [
      'Human-readable context about this delivery.',
      '',
      formatRecordEnvelope(canonicalJson(RECORD)),
      'Further prose is ignored, including `json` in backticks and ``` fences:',
      '```text',
      'not a machine block',
      '```',
    ].join('\n')
    assert.equal(parseRecordEnvelope(body).kind, 'record')
  })

  it('treats a comment without the marker as unmarked prose', () => {
    const body = 'A ```json\n{"schema":"norn-delivery:v1"}\n``` block with no marker line.'
    assert.equal(parseRecordEnvelope(body).kind, 'unmarked')
  })

  it('treats the marker embedded in a prose line as unmarked', () => {
    const body = `see ${NORN_RECORD_MARKER} below\n\`\`\`json\n${canonicalJson(RECORD)}\n\`\`\``
    assert.equal(parseRecordEnvelope(body).kind, 'unmarked')
  })

  it('rejects a marker with no machine block after it', () => {
    const outcome = parseRecordEnvelope(`${NORN_RECORD_MARKER}\nonly prose follows`)
    assert.equal(outcome.kind, 'invalid')
    if (outcome.kind === 'invalid') assert.match(outcome.reason, /immediately followed/)
  })

  it('rejects prose between the marker and the machine block', () => {
    const body = `${NORN_RECORD_MARKER}\nintermediate prose\n\`\`\`json\n${canonicalJson(RECORD)}\n\`\`\``
    assert.equal(parseRecordEnvelope(body).kind, 'invalid')
  })

  it('rejects malformed JSON in the machine block', () => {
    const body = `${NORN_RECORD_MARKER}\n\`\`\`json\n{not json}\n\`\`\``
    const outcome = parseRecordEnvelope(body)
    assert.equal(outcome.kind, 'invalid')
    if (outcome.kind === 'invalid') assert.match(outcome.reason, /not valid JSON/)
  })

  it('rejects valid JSON that is not RFC 8785 canonical', () => {
    const nonCanonical = `{"schema":"norn-delivery:v1", "b":1,   "a":[1, 2]}`
    const body = `${NORN_RECORD_MARKER}\n\`\`\`json\n${nonCanonical}\n\`\`\``
    const outcome = parseRecordEnvelope(body)
    assert.equal(outcome.kind, 'invalid')
    if (outcome.kind === 'invalid') assert.match(outcome.reason, /canonical/)
  })

  it('rejects an additional json machine block elsewhere in the comment', () => {
    const body = [
      formatRecordEnvelope(canonicalJson(RECORD)),
      '```json',
      '{"schema":"norn-delivery:v1"}',
      '```',
    ].join('\n')
    const outcome = parseRecordEnvelope(body)
    assert.equal(outcome.kind, 'invalid')
    if (outcome.kind === 'invalid') assert.match(outcome.reason, /additional json machine block/)
  })

  it('rejects a second marker line', () => {
    const body = [NORN_RECORD_MARKER, NORN_RECORD_MARKER, '```json', canonicalJson(RECORD), '```'].join('\n')
    const outcome = parseRecordEnvelope(body)
    assert.equal(outcome.kind, 'invalid')
    if (outcome.kind === 'invalid') assert.match(outcome.reason, /marker appears 2 times/)
  })

  it('rejects an unclosed machine block', () => {
    const body = `${NORN_RECORD_MARKER}\n\`\`\`json\n${canonicalJson(RECORD)}`
    const outcome = parseRecordEnvelope(body)
    assert.equal(outcome.kind, 'invalid')
    if (outcome.kind === 'invalid') assert.match(outcome.reason, /never closed/)
  })

  it('rejects a machine block that is not a JSON object', () => {
    const body = `${NORN_RECORD_MARKER}\n\`\`\`json\n[1,2,3]\n\`\`\``
    const outcome = parseRecordEnvelope(body)
    assert.equal(outcome.kind, 'invalid')
    if (outcome.kind === 'invalid') assert.match(outcome.reason, /not a JSON object/)
  })

  it('accepts CRLF-normalized comment bodies', () => {
    const body = formatRecordEnvelope(canonicalJson(RECORD)).replace(/\n/g, '\r\n')
    assert.equal(parseRecordEnvelope(body).kind, 'record')
  })

  it('round-trips through formatRecordEnvelope byte-identically', () => {
    const text = canonicalJson(RECORD)
    assert.equal(formatRecordEnvelope(text), `${NORN_RECORD_MARKER}\n\`\`\`json\n${text}\n\`\`\`\n`)
  })
})
