import assert from 'node:assert/strict'

/** Assert the Norn-owned instructions common to every independent Reviewer. */
export function assertTwoAxisReviewerInstructions(prompt: string): void {
  assert.match(prompt, /Standards axis/)
  assert.match(prompt, /repository-authored instructions and coding standards/)
  assert.match(prompt, /Spec axis/)
  assert.match(prompt, /missing or partial requirements/)
  assert.match(prompt, /unrequested scope/)
  assert.match(prompt, /coordinator-supplied binding, diff where provided, and ordered test evidence/)
  assert.match(prompt, /Pass only when both axes pass/)
  assert.match(prompt, /label every actionable finding as Standards or Spec/)
  assert.match(prompt, /Do not launch nested agents/)
  assert.match(prompt, /user-level skill/)
  assert.match(prompt, /read-only tools/)
  assert.doesNotMatch(prompt, /\/skill:/)
}
