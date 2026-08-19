/**
 * v1.10 A-session: the card-title session jump — unit tests for the pure
 * decision. The DOM side (title renders as a jump, click switches the
 * conversation) is verified by the browser E2E in tests/e2e/v110-session.py.
 */
import { describe, expect, it } from 'vitest'
import { resolveOpenableTarget, sessionJump } from '../src/client/session.ts'

describe('v1.10 session jump (card title → conversation)', () => {
  it('an in-flight claim offers a jump to the claiming session', () => {
    expect(sessionJump({ claimedBySessionId: 'session-abc' }, new Set()))
      .toBe('session-abc')
  })

  it('an unclaimed task has no jump', () => {
    expect(sessionJump({ claimedBySessionId: null }, new Set())).toBeNull()
  })

  it('a task whose claiming session is gone has no jump', () => {
    expect(sessionJump({ claimedBySessionId: 'session-gone' }, new Set(['session-gone'])))
      .toBeNull()
  })

  it('missing-session knowledge about OTHER sessions does not block the jump', () => {
    expect(sessionJump({ claimedBySessionId: 'session-live' }, new Set(['session-dead'])))
      .toBe('session-live')
  })
})

describe('v1.10 session jump — openable-target resolution', () => {
  const VISIBLE = new Set(['session-top', 'session-parent'])

  it('a visible claiming session resolves to itself', () => {
    expect(resolveOpenableTarget('session-top', { origin: undefined }, VISIBLE)).toBe('session-top')
    expect(resolveOpenableTarget('session-top', undefined, VISIBLE)).toBe('session-top')
  })

  it('an invisible subagent claiming session resolves to its visible parent', () => {
    expect(resolveOpenableTarget('session-child', {
      origin: 'subagent',
      parentSessionId: 'session-parent',
    }, VISIBLE)).toBe('session-parent')
  })

  it('an invisible session whose parent is also invisible has no openable target', () => {
    expect(resolveOpenableTarget('session-child', {
      origin: 'subagent',
      parentSessionId: 'session-grandparent',
    }, VISIBLE)).toBeNull()
  })

  it('a gone session (no row, not visible) has no openable target', () => {
    expect(resolveOpenableTarget('session-gone', undefined, VISIBLE)).toBeNull()
  })

  it('a visible session with a parent still resolves to itself (it is openable)', () => {
    expect(resolveOpenableTarget('session-parent', { origin: 'subagent', parentSessionId: 'session-top' }, VISIBLE))
      .toBe('session-parent')
  })
})
