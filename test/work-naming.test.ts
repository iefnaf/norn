/**
 * Run-qualified branch and workspace naming (design.md §10.1, ticket #7).
 *
 * Branch and workspace names are run-qualified by run ID, ticket number, and
 * work attempt, so no two attempts — and no later run — can collide or
 * silently reuse them. Unsafe components are rejected before git runs.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  WORK_BRANCH_PREFIX,
  mapCompletionWorkspaceDir,
  ticketBranch,
  ticketWorkspaceDir,
} from '../src/work/naming.ts'

describe('ticketBranch', () => {
  it('is run-qualified by run, ticket number, and work attempt', () => {
    assert.equal(ticketBranch('run-9', 7, 'wa-2'), 'norn/run-9/7/wa-2')
    assert.equal(ticketBranch('run-9', 4242, 'attempt-10'), 'norn/run-9/4242/attempt-10')
  })

  it('rejects unsafe or non-run-qualified components', () => {
    assert.equal(ticketBranch('Run_9', 7, 'wa-1'), undefined)
    assert.equal(ticketBranch('run/9', 7, 'wa-1'), undefined)
    assert.equal(ticketBranch('../escape', 7, 'wa-1'), undefined)
    assert.equal(ticketBranch('.lock', 7, 'wa-1'), undefined)
    assert.equal(ticketBranch('', 7, 'wa-1'), undefined)
    assert.equal(ticketBranch('run-9', 0, 'wa-1'), undefined)
    assert.equal(ticketBranch('run-9', -3, 'wa-1'), undefined)
    assert.equal(ticketBranch('run-9', 7.5, 'wa-1'), undefined)
    assert.equal(ticketBranch('run-9', 7, 'wa/1'), undefined)
    assert.equal(ticketBranch('run-9', 7, 'Wa-1'), undefined)
    assert.equal(ticketBranch('run-9', 7, ''), undefined)
  })

  it('rejects components that could escape the branch namespace', () => {
    // A dashed name cannot start with a dash, contain a slash, or end in lock.
    assert.equal(ticketBranch('-run', 7, 'wa-1'), undefined)
    assert.equal(ticketBranch('run-9', 7, 'wa-1..x'), undefined)
  })
})

describe('ticketWorkspaceDir', () => {
  it('places the workspace under repository home runs, run-qualified', () => {
    assert.equal(
      ticketWorkspaceDir('/norn-home/repo', 'run-9', 7, 'wa-2'),
      join('/norn-home/repo', 'runs', 'run-9', 'workspaces', '7', 'wa-2'),
    )
  })

  it('rejects the same unsafe components as the branch name', () => {
    assert.equal(ticketWorkspaceDir('/norn-home/repo', 'run/9', 7, 'wa-1'), undefined)
    assert.equal(ticketWorkspaceDir('/norn-home/repo', 'run-9', 0, 'wa-1'), undefined)
    assert.equal(ticketWorkspaceDir('/norn-home/repo', 'run-9', 7, 'wa/1'), undefined)
  })
})

describe('mapCompletionWorkspaceDir', () => {
  it('carries the completion attempt under workspaces/map', () => {
    assert.equal(
      mapCompletionWorkspaceDir('/norn-home/repo', 'run-9', 'mc-1'),
      join('/norn-home/repo', 'runs', 'run-9', 'workspaces', 'map', 'mc-1'),
    )
    assert.equal(mapCompletionWorkspaceDir('/norn-home/repo', 'run/9', 'mc-1'), undefined)
    assert.equal(mapCompletionWorkspaceDir('/norn-home/repo', 'run-9', '../mc'), undefined)
  })
})

describe('the branch namespace', () => {
  it('is the single norn prefix inside the target repository', () => {
    assert.equal(WORK_BRANCH_PREFIX, 'norn')
    assert.ok(ticketBranch('run-1', 1, 'wa-1')!.startsWith('norn/'))
  })
})
