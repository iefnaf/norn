import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { RawIssueRef, RawTaskMapLoad } from '../src/map/loader.ts'
import { validateTaskMapTopology } from '../src/map/snapshot.ts'
import type { TopologyFinding } from '../src/map/snapshot.ts'
import {
  HOST,
  MAP_REF,
  REPO,
  mapIssue,
  member,
  memberA,
  memberB,
  rawLoad,
  rawRef,
} from './helpers/map-fixtures.ts'

function codes(load: RawTaskMapLoad): string[] {
  return validateTaskMapTopology(load).map((finding) => finding.code)
}

describe('validateTaskMapTopology — a valid load has no findings', () => {
  it('accepts the canonical two-ticket map with one dependency', () => {
    assert.deepEqual(codes(rawLoad([memberA(), memberB()])), [])
  })

  it('accepts a CLOSED map and CLOSED members', () => {
    const load = rawLoad([memberA()], { state: 'CLOSED' })
    const members: RawTaskMapLoad = {
      ...load,
      members: [{ ...memberA(), state: 'CLOSED' }],
    }
    assert.deepEqual(codes(members), [])
  })
})

describe('validateTaskMapTopology — map-level rules (§7.2 rules 1–3)', () => {
  it('reports a map with no direct members', () => {
    assert.deepEqual(codes(rawLoad([])), ['map-has-no-members'])
  })

  it('reports a map that is itself a sub-issue of another issue, with the parents', () => {
    const parent = rawRef('I_other_map', 9)
    const findings = validateTaskMapTopology(
      rawLoad([memberA()], { parents: [parent] }),
    )
    assert.deepEqual(codes(rawLoad([memberA()], { parents: [parent] })), ['map-is-sub-issue'])
    const finding = findings[0] as { code: 'map-is-sub-issue'; parents: readonly RawIssueRef[] }
    assert.deepEqual(finding.parents, [parent])
  })

  it('reports a map with native blockers of its own, with the blockers', () => {
    const blocker = rawRef('I_blocker', 4)
    const findings = validateTaskMapTopology(rawLoad([memberA()], { blockers: [blocker] }))
    assert.deepEqual(codes(rawLoad([memberA()], { blockers: [blocker] })), ['map-has-blockers'])
    const finding = findings[0] as { code: 'map-has-blockers'; blockers: readonly RawIssueRef[] }
    assert.deepEqual(finding.blockers, [blocker])
  })
})

describe('validateTaskMapTopology — member identity rules (§7.2 rule 4)', () => {
  it('reports a duplicated member issue ID', () => {
    const first = member('I_A', 1)
    const second = member('I_A', 1)
    const load = rawLoad([first, second, memberB()])
    const findings = validateTaskMapTopology(load)
    assert.deepEqual(codes(load), ['duplicate-member'])
    const finding = findings[0] as { code: 'duplicate-member'; memberRef: RawIssueRef }
    assert.equal(finding.memberRef.issueId, 'I_A')
  })

  it('reports a member that is the map issue itself', () => {
    const load = rawLoad([memberA(), { ...member(MAP_REF.issueId, 7), blockers: [] }])
    assert.deepEqual(codes(load), ['member-is-map'])
  })

  it('reports a member from another repository of the same host', () => {
    const crossRepo = member('I_cross', 3, {
      ref: { repositoryId: 'R_kgDOOTHER', url: 'https://github.com/acme/other/issues/3' },
    })
    const load = rawLoad([memberA(), crossRepo])
    const findings = validateTaskMapTopology(load)
    assert.deepEqual(codes(load), ['cross-repository-member'])
    const finding = findings[0] as {
      code: 'cross-repository-member'
      expected: { githubHost: string; repositoryId: string }
    }
    assert.deepEqual(finding.expected, { githubHost: HOST, repositoryId: REPO })
  })

  it('reports a member from another host', () => {
    const crossHost = member('I_crosshost', 3, {
      ref: { githubHost: 'ghe.example.com' },
    })
    assert.deepEqual(codes(rawLoad([memberA(), crossHost])), ['cross-repository-member'])
  })
})

describe('validateTaskMapTopology — flatness and parent rules (§7.2 rules 5–6)', () => {
  it('reports a member that has its own sub-issues, with them', () => {
    const child = rawRef('I_child', 10)
    const nested = member('I_nested', 3, { subIssues: [child] })
    const load = rawLoad([memberA(), nested])
    const findings = validateTaskMapTopology(load)
    assert.deepEqual(codes(load), ['member-has-sub-issues'])
    const finding = findings[0] as { code: 'member-has-sub-issues'; subIssues: readonly RawIssueRef[] }
    assert.deepEqual(finding.subIssues, [child])
  })

  it('reports a member with a parent besides the map', () => {
    const otherMap = rawRef('I_other_map', 9)
    const dualParent = member('I_dual', 3, { parents: [MAP_REF, otherMap] })
    const load = rawLoad([memberA(), dualParent])
    const findings = validateTaskMapTopology(load)
    assert.deepEqual(codes(load), ['member-has-other-parent'])
    const finding = findings[0] as { code: 'member-has-other-parent'; otherParents: readonly RawIssueRef[] }
    assert.deepEqual(finding.otherParents, [otherMap])
  })

  it('reports a member that does not list the map among its parents at all', () => {
    const orphan = member('I_orphan', 3, { parents: [] })
    assert.deepEqual(codes(rawLoad([memberA(), orphan])), ['member-not-child-of-map'])
  })

  it('reports both rule-6 findings when the only parent is another issue', () => {
    const otherMap = rawRef('I_other_map', 9)
    const adopted = member('I_adopted', 3, { parents: [otherMap] })
    assert.deepEqual(codes(rawLoad([memberA(), adopted])), [
      'member-has-other-parent',
      'member-not-child-of-map',
    ])
  })
})

describe('validateTaskMapTopology — dependency rules (§7.2 rules 7–8)', () => {
  it('reports a blocker that is not a direct member, with the blocker', () => {
    const external = member('I_A', 1, {
      blockers: [rawRef('I_outside', 5, { repositoryId: 'R_kgDOOTHER' })],
    })
    const load = rawLoad([external, memberB()])
    const findings = validateTaskMapTopology(load)
    assert.deepEqual(codes(load), ['external-blocker'])
    const finding = findings[0] as { code: 'external-blocker'; blockerRef: RawIssueRef }
    assert.equal(finding.blockerRef.issueId, 'I_outside')
  })

  it('reports the map issue itself as an external blocker when used as one', () => {
    const load = rawLoad([member('I_A', 1, { blockers: [MAP_REF] }), memberB()])
    assert.deepEqual(codes(load), ['external-blocker'])
  })

  it('reports a member that blocks itself', () => {
    const selfBlocker = member('I_self', 3, { blockers: [rawRef('I_self', 3)] })
    assert.deepEqual(codes(rawLoad([memberA(), selfBlocker])), ['member-self-block'])
  })

  it('reports a two-member dependency cycle with its exact issue IDs', () => {
    const a = member('I_A', 1, { blockers: [rawRef('I_B', 2)] })
    const b = member('I_B', 2, { blockers: [rawRef('I_A', 1)] })
    const load = rawLoad([a, b])
    const findings = validateTaskMapTopology(load)
    assert.deepEqual(codes(load), ['dependency-cycle'])
    const finding = findings[0] as { code: 'dependency-cycle'; cycleIssueIds: readonly string[] }
    assert.deepEqual(finding.cycleIssueIds, ['I_A', 'I_B'])
  })

  it('reports a three-member cycle and a separate valid branch independently', () => {
    const a = member('I_1', 1, { blockers: [rawRef('I_3', 3)] })
    const b = member('I_2', 2, { blockers: [rawRef('I_1', 1)] })
    const c = member('I_3', 3, { blockers: [rawRef('I_2', 2)] })
    const independent = member('I_9', 9)
    const load = rawLoad([a, b, c, independent])
    const findings = validateTaskMapTopology(load)
    assert.deepEqual(codes(load), ['dependency-cycle'])
    const finding = findings[0] as { code: 'dependency-cycle'; cycleIssueIds: readonly string[] }
    assert.deepEqual(finding.cycleIssueIds, ['I_1', 'I_2', 'I_3'])
  })

  it('reports two distinct cycles as two findings', () => {
    const a = member('I_1', 1, { blockers: [rawRef('I_2', 2)] })
    const b = member('I_2', 2, { blockers: [rawRef('I_1', 1)] })
    const c = member('I_3', 3, { blockers: [rawRef('I_4', 4)] })
    const d = member('I_4', 4, { blockers: [rawRef('I_3', 3)] })
    const load = rawLoad([a, b, c, d])
    assert.deepEqual(codes(load), ['dependency-cycle', 'dependency-cycle'])
  })

  it('does not report a cycle for a self-block — that is its own finding', () => {
    const selfBlocker = member('I_self', 3, { blockers: [rawRef('I_self', 3)] })
    const findings = validateTaskMapTopology(rawLoad([memberA(), selfBlocker]))
    assert.ok(findings.every((finding) => finding.code !== 'dependency-cycle'))
  })
})

describe('validateTaskMapTopology — all independently discoverable findings', () => {
  it('reports every violation at once rather than stopping at the first', () => {
    const load = rawLoad(
      [
        // nested member with sub-issues and an external blocker
        member('I_nested', 3, {
          subIssues: [rawRef('I_child', 10)],
          blockers: [rawRef('I_outside', 5)],
        }),
        // cross-repository member
        member('I_cross', 4, { ref: { repositoryId: 'R_kgDOOTHER' } }),
      ],
      {
        title: 'nested map',
        parents: [rawRef('I_parent_map', 8)],
        blockers: [rawRef('I_map_blocker', 7)],
      },
    )
    assert.deepEqual(codes(load), [
      'cross-repository-member',
      'external-blocker',
      'map-has-blockers',
      'map-is-sub-issue',
      'member-has-sub-issues',
    ])
  })

  it('produces identical findings regardless of member display order', () => {
    const nested = member('I_nested', 3, { subIssues: [rawRef('I_child', 10)] })
    const crossRepo = member('I_cross', 4, { ref: { repositoryId: 'R_kgDOOTHER' } })
    const first = validateTaskMapTopology(rawLoad([nested, crossRepo]))
    const second = validateTaskMapTopology(rawLoad([crossRepo, nested]))
    assert.deepEqual(first, second)
  })
})
