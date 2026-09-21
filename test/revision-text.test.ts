import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeRevisionText } from '../src/core/revision-text.ts'

describe('normalizeRevisionText line endings', () => {
  it('converts CRLF to LF', () => {
    assert.equal(normalizeRevisionText('a\r\nb'), 'a\nb')
  })

  it('converts lone CR to LF', () => {
    assert.equal(normalizeRevisionText('a\rb'), 'a\nb')
    assert.equal(normalizeRevisionText('a\r\rb'), 'a\n\nb')
  })

  it('handles mixed line endings', () => {
    assert.equal(normalizeRevisionText('one\r\ntwo\rthree\nfour'), 'one\ntwo\nthree\nfour')
  })
})

describe('normalizeRevisionText Unicode NFC', () => {
  it('composes canonical decompositions', () => {
    assert.equal(normalizeRevisionText('e\u0301'), 'é')
    assert.equal(normalizeRevisionText('A\u030a'), 'Å')
    // Reorders the combining marks (circumflex before dot below) and composes.
    assert.equal(normalizeRevisionText('o\u0323\u0302'), 'ộ')
    assert.equal(normalizeRevisionText('o\u0302\u0301'), 'ố')
  })

  it('leaves already-composed text unchanged', () => {
    assert.equal(normalizeRevisionText('é'), 'é')
  })

  it('does not decompose precomposed characters', () => {
    assert.equal(normalizeRevisionText('é'), '\u00e9')
  })
})

describe('normalizeRevisionText outer trimming', () => {
  it('removes only leading and trailing spaces, tabs, and LF', () => {
    assert.equal(normalizeRevisionText('  x\t'), 'x')
    assert.equal(normalizeRevisionText('\n\n x \n\t'), 'x')
    assert.equal(normalizeRevisionText(' \t\r\n x \r\n\t '), 'x')
  })

  it('collapses a text of only trimmable characters to the empty string', () => {
    assert.equal(normalizeRevisionText(' \t\n \t\n'), '')
    assert.equal(normalizeRevisionText('\r'), '')
    assert.equal(normalizeRevisionText(''), '')
  })

  it('keeps every interior byte significant', () => {
    assert.equal(normalizeRevisionText('a  \n\t b  c'), 'a  \n\t b  c')
    assert.equal(normalizeRevisionText('- item\n  - nested'), '- item\n  - nested')
  })

  it('does not trim other whitespace characters', () => {
    assert.equal(normalizeRevisionText('\u000bx'), '\u000bx')
    assert.equal(normalizeRevisionText('\u000cx'), '\u000cx')
    assert.equal(normalizeRevisionText('x\u00a0'), 'x\u00a0')
    assert.equal(normalizeRevisionText('\u3000x'), '\u3000x')
  })

  it('trims line endings introduced by CR normalization', () => {
    // CR becomes LF first, so an outer CR is trimmed like an outer LF.
    assert.equal(normalizeRevisionText('x\r\n\r'), 'x')
    assert.equal(normalizeRevisionText('\rx'), 'x')
  })
})

describe('normalizeRevisionText null bodies', () => {
  it('turns a null GitHub issue body into the empty string', () => {
    assert.equal(normalizeRevisionText(null), '')
  })
})

describe('normalizeRevisionText order of steps', () => {
  it('applies CR normalization, NFC, then outer trim as one deterministic form', () => {
    // "e" + combining acute with CRLF and outer padding normalizes exactly
    // like the precomposed trimmed form.
    assert.equal(normalizeRevisionText('  e\u0301\r\n'), 'é')
    assert.equal(normalizeRevisionText('é'), 'é')
    assert.notEqual(normalizeRevisionText('  e\u0301\r\n'), 'e\u0301')
  })
})
