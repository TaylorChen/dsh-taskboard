/**
 * The auto-claim driver's pure decision helpers: candidate selection. The
 * event wiring and quota reads are integration concerns (they need a live
 * cordis app); the scan order is a unit-testable pure function.
 */

import { describe, expect, it } from 'vitest'
import type { Task } from '../src/domain.ts'
import { selectClaimCandidate } from '../src/autoclaim.ts'

/** One minimal claimable-shaped task. */
function task(partial: Partial<Task> & { id: string, title: string, createdAt: number }): Task {
  return {
    projectId: 'p1',
    body: '',
    status: 'open',
    priority: 'normal',
    labels: [],
    workspaceId: null,
    claimedBySessionId: null,
    origin: 'agent',
    blockedReason: null,
    revision: 0,
    updatedAt: partial.createdAt,
    ...partial,
  } as Task
}

describe('selectClaimCandidate', () => {
  it('picks the oldest open, unclaimed task', () => {
    const old = task({ id: 'a', title: 'Old', createdAt: 100 })
    const mid = task({ id: 'b', title: 'Mid', createdAt: 200 })
    const fresh = task({ id: 'c', title: 'Fresh', createdAt: 300 })
    expect(selectClaimCandidate([fresh, old, mid])?.id).toBe('a')
  })

  it('skips claimed and non-open tasks', () => {
    const claimed = task({
      id: 'claimed', title: 'Taken', createdAt: 50, claimedBySessionId: 'session-x',
    })
    const inProgress = task({ id: 'doing', title: 'Doing', createdAt: 60, status: 'in_progress' })
    const blocked = task({ id: 'stuck', title: 'Stuck', createdAt: 70, status: 'blocked' })
    const open = task({ id: 'free', title: 'Free', createdAt: 80 })
    expect(selectClaimCandidate([claimed, inProgress, blocked, open])?.id).toBe('free')
  })

  it('prefers an earlier deadline, then undated tasks last (v0.9)', () => {
    const undated = task({ id: 'u', title: 'Undated', createdAt: 100 })
    const later = task({ id: 'l', title: 'Later', createdAt: 200, dueAt: 300 })
    const sooner = task({ id: 's', title: 'Sooner', createdAt: 300, dueAt: 100 })
    expect(selectClaimCandidate([undated, later, sooner])?.id).toBe('s')
    expect(selectClaimCandidate([undated, later])?.id).toBe('l')
  })

  it('returns undefined when nothing is claimable', () => {
    const done = task({ id: 'd', title: 'Done', createdAt: 10, status: 'done' })
    expect(selectClaimCandidate([done])).toBeUndefined()
    expect(selectClaimCandidate([])).toBeUndefined()
  })
})
