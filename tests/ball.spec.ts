/**
 * v1.10 A4: the status ball mapping — unit tests for the pure contract.
 * The DOM side (keyframes injection, dot rendering) is verified by the
 * browser E2E in tests/e2e/v110-a4.mjs.
 */
import { describe, expect, it } from 'vitest'
import { statusBall, BALL_ANIMATIONS, injectBallKeyframes } from '../src/client/ball.ts'

describe('v1.10 A4 status ball', () => {
  it('in_progress is a pulsing blue ball', () => {
    const ball = statusBall('in_progress')
    expect(ball.animation).toBe(BALL_ANIMATIONS.pulse)
    expect(ball.color).toContain('#3b82f6')
  })

  it('awaiting_human and blocked are breathing red balls', () => {
    const awaiting = statusBall('awaiting_human')
    const blocked = statusBall('blocked')
    expect(awaiting.animation).toBe(BALL_ANIMATIONS.breathe)
    expect(blocked.animation).toBe(BALL_ANIMATIONS.breathe)
    expect(awaiting.color).toContain('#e5484d')
    expect(blocked.color).toContain('#e5484d')
  })

  it('done is a still green ball', () => {
    const ball = statusBall('done')
    expect(ball.animation).toBeNull()
    expect(ball.color).toContain('#2f9e44')
  })

  it('parked statuses (draft/open/cancelled) are still grey balls', () => {
    for (const status of ['draft', 'open', 'cancelled']) {
      const ball = statusBall(status)
      expect(ball.animation).toBeNull()
      expect(ball.color).toContain('transparent')
    }
  })

  it('unknown statuses degrade to a still grey ball, never throw', () => {
    const ball = statusBall('some_future_status')
    expect(ball.animation).toBeNull()
    expect(ball.color).toContain('transparent')
  })

  it('injectBallKeyframes is a no-op without a DOM and idempotent with one', () => {
    // No DOM in the unit environment: must not throw.
    expect(() => injectBallKeyframes()).not.toThrow()
    // With a DOM: injects exactly once (idempotent guard).
    const head = { appendChild: () => undefined }
    const doc = {
      head,
      createElement: () => ({ id: '' }),
      getElementById: (id: string) => (id === 'taskboard-ball-keyframes' ? {} : null),
    }
    const original = globalThis.document
    ;(globalThis as Record<string, unknown>).document = doc
    try {
      expect(() => injectBallKeyframes()).not.toThrow()
    } finally {
      if (original === undefined) delete (globalThis as Record<string, unknown>).document
      else (globalThis as Record<string, unknown>).document = original
    }
  })

  it('the keyframe names referenced by the animations match the injected sheet', () => {
    expect(BALL_ANIMATIONS.pulse.startsWith('taskboard-pulse ')).toBe(true)
    expect(BALL_ANIMATIONS.breathe.startsWith('taskboard-breathe ')).toBe(true)
  })
})
