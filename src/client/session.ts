/**
 * v1.10 A-session: whether a task card's title is a jump into the claiming
 * session — and to which session. The title becomes the primary entry to the
 * agent's conversation while a task is in flight; the old footer button stays
 * only for the "session gone" case.
 *
 * Pure decision, so the unit tests pin it without a DOM.
 * @module @navidid/dsh-taskboard/client/session
 */

/** A task's session-relevant slice. */
export interface SessionCarrier {
  claimedBySessionId: string | null
}

/**
 * The session to jump to from a card's title, or null when the card has no
 * jump (no claim, or the claiming session no longer exists — jumping there
 * would dead-end, so the card must not offer it).
 */
export function sessionJump(
  task: SessionCarrier,
  missingSessions: ReadonlySet<string>,
): string | null {
  if (task.claimedBySessionId === null) return null
  if (missingSessions.has(task.claimedBySessionId)) return null
  return task.claimedBySessionId
}
