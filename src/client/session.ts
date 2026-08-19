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

/** A session list row's jump-relevant fields (the `byId` slice we read). */
export interface SessionRowLike {
  origin?: 'subagent'
  parentSessionId?: string
}

/**
 * v1.10 A-session (hardening): the jump target must be a session the GUI can
 * actually show. `visibleIds` are the host list's top-level rows — the
 * sidebar — while `byId` also holds the current addressed subagent route (not
 * openable from the sidebar). A claiming session:
 *   - present in `visibleIds` → itself (top-level, openable),
 *   - absent but its row names a parent in `visibleIds` → the parent
 *     (a subagent's story lives in its parent conversation),
 *   - otherwise → null (no openable target; the card should degrade).
 *
 * @returns the openable session id, or null when no openable target exists.
 */
export function resolveOpenableTarget(
  claimedSessionId: string,
  row: SessionRowLike | undefined,
  visibleIds: ReadonlySet<string>,
): string | null {
  if (visibleIds.has(claimedSessionId)) return claimedSessionId
  if (row?.parentSessionId !== undefined && visibleIds.has(row.parentSessionId)) {
    return row.parentSessionId
  }
  return null
}

/**
 * v1.10 A-session (feedback): whether opening a target actually SWITCHES the
 * GUI. When the target is the session already selected, `sessions.open` lands
 * with no visible change — the caller should say so instead of looking dead.
 * Also returns false for a null target (nothing openable).
 */
export function wouldSwitch(
  target: string | null,
  currentSessionId: string | undefined,
): boolean {
  return target !== null && target !== currentSessionId
}
