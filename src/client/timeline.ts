/**
 * v1.10 A1 (task movie): the pure logic of a task's story timeline — kept
 * free of React so it is unit-testable in vitest. The panel renders this.
 * @module @navidid/dsh-taskboard/client/timeline
 */

/** One activity entry as the activity route serves it. */
export interface TimelineActivity {
  id: string
  taskId: string
  at: number
  actor: 'human' | 'agent'
  actorLabel: string
  action: 'created' | 'status' | 'edited' | 'removed' | 'blocked' | 'claimed' | 'dispatched' | 'completed' | 'noted'
  from: string | null
  to: string | null
}

/** Timeline status colors (segment rail + event dots). */
export const STATUS_TIMELINE_COLOR: Record<string, string> = {
  draft: 'color-mix(in oklab, currentColor 25%, transparent)',
  open: 'color-mix(in oklab, currentColor 40%, transparent)',
  in_progress: 'color-mix(in oklab, #3b82f6 60%, currentColor)',
  awaiting_human: 'color-mix(in oklab, #e5484d 65%, currentColor)',
  blocked: 'color-mix(in oklab, #e5484d 65%, currentColor)',
  done: 'color-mix(in oklab, #46a758 60%, currentColor)',
  cancelled: 'color-mix(in oklab, currentColor 20%, transparent)',
}

/** The status a client-side activity entry enters (mirror of the service). */
export function enteredStatus(entry: TimelineActivity): string | undefined {
  if (entry.action === 'claimed') return 'in_progress'
  if (entry.action === 'status' || entry.action === 'created' || entry.action === 'completed') {
    return entry.to === null ? undefined : entry.to
  }
  if (entry.action === 'blocked') return entry.to ?? 'blocked'
  return undefined
}

/** One colored status segment over the task's lifetime. */
export interface TimelineSegment {
  status: string
  start: number
  end: number
}

/**
 * Rebuild a task's story — events chronologically and colored status
 * segments over the whole span. The final segment runs to `now`.
 */
export function buildTimeline(
  entries: readonly TimelineActivity[],
  now = Date.now(),
): { events: TimelineActivity[], segments: TimelineSegment[] } {
  const events = [...entries].sort((a, b) => a.at - b.at)
  const segments: TimelineSegment[] = []
  let current: string | undefined
  let start = 0
  for (const entry of events) {
    const entered = enteredStatus(entry)
    if (entered === undefined) continue
    if (current === undefined) { current = entered; start = entry.at; continue }
    if (entered !== current) {
      segments.push({ status: current, start, end: entry.at })
      current = entered
      start = entry.at
    }
  }
  if (current !== undefined) segments.push({ status: current, start, end: now })
  return { events, segments }
}
