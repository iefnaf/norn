import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseIssueUrl } from '../src/map/issue-url.ts'
import { normalizeIssueHost } from '../src/map/issue-url.ts'

const CANONICAL = 'https://github.com/acme/widget/issues/6'

describe('parseIssueUrl — the full-issue-URL form (§2.2)', () => {
  it('parses the canonical form into host, owner, name, and number', () => {
    assert.deepEqual(parseIssueUrl(CANONICAL), {
      githubHost: 'github.com',
      owner: 'acme',
      name: 'widget',
      number: 6,
    })
  })

  it('accepts a trailing slash', () => {
    assert.deepEqual(parseIssueUrl(`${CANONICAL}/`), parseIssueUrl(CANONICAL))
  })

  it('lowercases the host and omits the default HTTPS port', () => {
    assert.equal(parseIssueUrl('https://GitHub.Com/acme/widget/issues/6')?.githubHost, 'github.com')
    assert.equal(parseIssueUrl('https://github.com:443/acme/widget/issues/6')?.githubHost, 'github.com')
  })

  it('keeps a non-default port in the host identity (§7.3)', () => {
    assert.equal(
      parseIssueUrl('https://ghe.example.com:8443/acme/widget/issues/6')?.githubHost,
      'ghe.example.com:8443',
    )
  })

  it('resolves a GitHub Enterprise host like any other host', () => {
    assert.deepEqual(parseIssueUrl('https://ghe.example.com/acme/widget/issues/42'), {
      githubHost: 'ghe.example.com',
      owner: 'acme',
      name: 'widget',
      number: 42,
    })
  })
})

describe('parseIssueUrl — rejected inputs', () => {
  const rejected = [
    '#6',
    '#123',
    'acme/widget#6',
    '6',
    'https://github.com/acme/widget/issues/6#issuecomment-1',
    'https://github.com/acme/widget/issues/6?query=1',
    'https://github.com/acme/widget/pull/6',
    'https://github.com/acme/widget/issues',
    'https://github.com/acme/widget/issues/0',
    'https://github.com/acme/widget/issues/abc',
    'https://github.com/acme/widget/issues/6/extra',
    'https://github.com/acme/issues/6',
    'http://github.com/acme/widget/issues/6',
    'git@github.com:acme/widget.git',
    'https://user:token@github.com/acme/widget/issues/6',
    'https://github.com/acme/widget',
    '',
    '   ',
    'not a url',
  ]

  for (const input of rejected) {
    it(`rejects "${input}"`, () => {
      assert.equal(parseIssueUrl(input), undefined)
    })
  }

  it('rejects non-https schemes even when otherwise well-formed', () => {
    assert.equal(parseIssueUrl('ssh://github.com/acme/widget/issues/6'), undefined)
  })
})

describe('normalizeIssueHost', () => {
  it('lowercases and strips only the default HTTPS port', () => {
    assert.equal(normalizeIssueHost('GitHub.COM'), 'github.com')
    assert.equal(normalizeIssueHost('github.com:443'), 'github.com')
    assert.equal(normalizeIssueHost('github.com:80'), 'github.com:80')
  })
})
