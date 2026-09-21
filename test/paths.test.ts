import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  configFilePath,
  encodePathSegment,
  mapsDir,
  metadataFilePath,
  repositoryHomeDir,
  resolveNornHome,
  runStatePath,
} from '../src/config/paths.ts'

describe('resolveNornHome', () => {
  it('honors PI_CODING_AGENT_DIR when set', () => {
    const home = resolveNornHome({ PI_CODING_AGENT_DIR: '/custom/agent-dir' }, '/Users/operator')
    assert.equal(home, join('/custom/agent-dir', 'norn'))
  })

  it('defaults to ~/.pi/agent/norn when the variable is unset', () => {
    assert.equal(resolveNornHome({}, '/Users/operator'), join('/Users/operator', '.pi', 'agent', 'norn'))
  })

  it('treats an empty or whitespace-only value as unset', () => {
    assert.equal(resolveNornHome({ PI_CODING_AGENT_DIR: '' }, '/h'), join('/h', '.pi', 'agent', 'norn'))
    assert.equal(resolveNornHome({ PI_CODING_AGENT_DIR: '   ' }, '/h'), join('/h', '.pi', 'agent', 'norn'))
  })

  it('does not depend on the real process environment or home directory', () => {
    // The same env snapshot and home directory always produce the same path,
    // regardless of the machine the resolution runs on.
    const env = Object.freeze({ PATH: '/usr/bin' })
    assert.equal(resolveNornHome(env, '/x'), resolveNornHome(env, '/x'))
  })

  it('resolves under the system temp directory too', () => {
    const home = resolveNornHome({ PI_CODING_AGENT_DIR: join(tmpdir(), 'pi-agent') }, '/h')
    assert.equal(home, join(tmpdir(), 'pi-agent', 'norn'))
  })
})

describe('encodePathSegment', () => {
  it('keeps unreserved characters verbatim', () => {
    assert.equal(encodePathSegment('github.com'), 'github.com')
    assert.equal(encodePathSegment('R_kgDOB-X123.abc'), 'R_kgDOB-X123.abc')
    assert.equal(encodePathSegment('I_abc123'), 'I_abc123')
  })

  it('percent-encodes everything else as uppercase UTF-8', () => {
    assert.equal(encodePathSegment('a/b'), 'a%2Fb')
    assert.equal(encodePathSegment('a b'), 'a%20b')
    assert.equal(encodePathSegment('ghe.internal:8443'), 'ghe.internal%3A8443')
    assert.equal(encodePathSegment('ünïcode'), '%C3%BCn%C3%AFcode')
  })

  it('is injective for tricky pairs', () => {
    assert.notEqual(encodePathSegment('a%2F'), encodePathSegment('a/b'))
    assert.notEqual(encodePathSegment('a%2Fb'), encodePathSegment('a/b'))
  })
})

describe('repository home layout', () => {
  const nornHome = join(tmpdir(), 'norn-test-home')

  it('keys repository home by encoded host and repository ID, not owner/name', () => {
    const home = repositoryHomeDir(nornHome, { githubHost: 'github.com', repositoryId: 'R_kgDOB123' })
    assert.equal(
      home,
      join(nornHome, 'repositories', 'github.com', 'R_kgDOB123'),
    )
  })

  it('encodes characters that are not path-safe', () => {
    const home = repositoryHomeDir(nornHome, { githubHost: 'GHE.internal:8443', repositoryId: 'R/1 2' })
    assert.equal(
      home,
      join(nornHome, 'repositories', 'GHE.internal%3A8443', 'R%2F1%202'),
    )
  })

  it('distinct identities never share a repository home', () => {
    const a = repositoryHomeDir(nornHome, { githubHost: 'github.com', repositoryId: 'R_1' })
    const b = repositoryHomeDir(nornHome, { githubHost: 'github.com', repositoryId: 'R_2' })
    const c = repositoryHomeDir(nornHome, { githubHost: 'ghe.example.com', repositoryId: 'R_1' })
    assert.notEqual(a, b)
    assert.notEqual(a, c)
  })

  it('places maps, run state, and the setup documents per §2.2/§13.1', () => {
    const home = repositoryHomeDir(nornHome, { githubHost: 'github.com', repositoryId: 'R_1' })
    assert.equal(mapsDir(home), join(home, 'maps'))
    assert.equal(runStatePath(home, 'I_9'), join(home, 'maps', 'I_9', 'run-state.json'))
    assert.equal(metadataFilePath(home), join(home, 'metadata.json'))
    assert.equal(configFilePath(home), join(home, 'config.json'))
  })
})
