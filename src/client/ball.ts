/**
 * v1.10 A4: the status ball — a small dot on every card that tells the task's
 * story at a glance, and *moves* when the story is live:
 *
 *   in_progress      blue, pulsing        — the agent is working right now
 *   awaiting_human   red,  breathing      — the ball is with a human
 *   blocked          red,  breathing      — the agent is stuck, needs a human
 *   done             green, still         — finished
 *   everything else  grey,  still         — parked
 *
 * Pure mapping, so the unit tests pin the contract without a DOM. The actual
 * @keyframes live in `injectBallKeyframes` (client-only, idempotent).
 * @module @navidid/dsh-taskboard/client/ball
 */

/** Colours follow the panel's `color-mix` over `currentColor` convention, so
 * the balls stay legible in both shell themes. */
const BALL_COLORS = {
  inProgress: 'color-mix(in oklab, #3b82f6 78%, currentColor)',
  attention: 'color-mix(in oklab, #e5484d 72%, currentColor)',
  done: 'color-mix(in oklab, #2f9e44 70%, currentColor)',
  idle: 'color-mix(in oklab, currentColor 38%, transparent)',
} as const

/** Animation shorthand strings — the keyframe names must match the ones
 * injected by `injectBallKeyframes`. */
export const BALL_ANIMATIONS = {
  pulse: 'taskboard-pulse 1.6s ease-in-out infinite',
  breathe: 'taskboard-breathe 2.2s ease-in-out infinite',
} as const

export interface StatusBall {
  /** The dot's background colour. */
  color: string
  /** Animation shorthand, or null for a still ball. */
  animation: string | null
}

/** Map a task status to its ball. Unknown statuses degrade to a still grey
 * dot — a new status on a newer server must never break an older client. */
export function statusBall(status: string): StatusBall {
  switch (status) {
    case 'in_progress':
      return { color: BALL_COLORS.inProgress, animation: BALL_ANIMATIONS.pulse }
    case 'awaiting_human':
    case 'blocked':
      return { color: BALL_COLORS.attention, animation: BALL_ANIMATIONS.breathe }
    case 'done':
      return { color: BALL_COLORS.done, animation: null }
    default:
      return { color: BALL_COLORS.idle, animation: null }
  }
}

const KEYFRAMES = `
@keyframes taskboard-pulse {
  0%, 100% { transform: scale(1); opacity: 0.8; }
  50%      { transform: scale(1.45); opacity: 1; }
}
@keyframes taskboard-breathe {
  0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 color-mix(in oklab, #e5484d 55%, transparent); }
  50%      { transform: scale(1.2); box-shadow: 0 0 0 5px color-mix(in oklab, #e5484d 0%, transparent); }
}
`

const KEYFRAMES_ID = 'taskboard-ball-keyframes'

/** Inject the ball's @keyframes once. Client-only and idempotent — calling it
 * from any module scope is safe (the unit-test environment has no DOM and
 * simply skips). */
export function injectBallKeyframes(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(KEYFRAMES_ID) !== null) return
  const style = document.createElement('style')
  style.id = KEYFRAMES_ID
  style.textContent = KEYFRAMES
  document.head.appendChild(style)
}
