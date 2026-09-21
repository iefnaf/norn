/**
 * The coordinator-defined command environment (design.md §3, §6, §8,
 * ticket #7): the child environment demonstrably excludes GitHub tokens and
 * push credentials.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isDeniedEnvironmentName, sanitizeCommandEnvironment } from '../src/work/environment.ts'

const CREDENTIAL_NAMES = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GITHUB_API_TOKEN',
  'GITHUB_COPILOT_TOKEN',
  'GITHUB_ACTIONS_TOKEN',
  'GH_HOST_TOKEN',
  'GITHUB_PAT',
  'GH_PAT',
  'SSH_AUTH_SOCK',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_SSH_COMMAND',
  'GIT_SSH_ASKPASS',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_KEY_17',
  'GIT_CONFIG_VALUE_17',
]

describe('isDeniedEnvironmentName', () => {
  it('denies every GitHub token and push-credential spelling', () => {
    for (const name of CREDENTIAL_NAMES) {
      assert.equal(isDeniedEnvironmentName(name), true, name)
    }
  })

  it('keeps non-credential names', () => {
    for (const name of [
      'PATH',
      'HOME',
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'GH_HOST',
      'GH_REPO',
      'GITHUB_REPOSITORY',
      'GIT_DIR',
      'NODE_ENV',
      'NPM_CONFIG_REGISTRY',
    ]) {
      assert.equal(isDeniedEnvironmentName(name), false, name)
    }
  })
})

describe('sanitizeCommandEnvironment', () => {
  it('removes every denied credential name', () => {
    const source: Record<string, string> = { PATH: '/bin', HOME: '/home' }
    for (const name of CREDENTIAL_NAMES) source[name] = 'secret'
    const sanitized = sanitizeCommandEnvironment(source)
    for (const name of CREDENTIAL_NAMES) {
      assert.equal(name in sanitized, false, name)
    }
    assert.equal(sanitized.PATH, '/bin')
    assert.equal(sanitized.HOME, '/home')
  })

  it('returns a fresh object, never an alias of the source', () => {
    const source: Record<string, string> = { PATH: '/bin', GITHUB_TOKEN: 'secret' }
    const sanitized = sanitizeCommandEnvironment(source)
    assert.notEqual(sanitized, source)
    sanitized.PATH = '/mutated'
    assert.equal(source.PATH, '/bin')
  })

  it('drops entries whose value is undefined', () => {
    const sanitized = sanitizeCommandEnvironment({ PRESENT: 'x', ABSENT: undefined })
    assert.deepEqual(sanitized, { PRESENT: 'x' })
  })

  it('matches token patterns case-sensitively like the environment itself', () => {
    const sanitized = sanitizeCommandEnvironment({
      GITHUB_TOKEN: 'secret',
      github_token: 'not the canonical spelling',
    })
    assert.equal('GITHUB_TOKEN' in sanitized, false)
    assert.equal(sanitized.github_token, 'not the canonical spelling')
  })
})
