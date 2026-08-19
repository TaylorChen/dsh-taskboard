/**
 * v1.10 A-session: the card-title session jump — unit tests for the pure
 * decision. The DOM side (title renders as a jump, click switches the
 * conversation) is verified by the browser E2E in tests/e2e/v110-session.py.
 */
import { describe, expect, it } from 'vitest'
import { sessionJump } from '../src/client/session.ts'

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
