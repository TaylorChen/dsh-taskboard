/**
 * v1.10 A1 (task movie): the pure timeline logic — chronological events and
 * colored status segments rebuilt from an activity stream.
 */

import { describe, expect, it } from 'vitest'
import { buildTimeline, enteredStatus, type TimelineActivity } from '../src/client/timeline.ts'

function entry(partial: Partial<TimelineActivity>): TimelineActivity {
  return {
    id: partial.id ?? `e-${partial.at ?? 0}`,
    taskId: 't1',
    at: partial.at ?? 0,
    actor: partial.actor ?? 'human',
    actorLabel: partial.actorLabel ?? 'panel',
    action: partial.action ?? 'status',
    from: partial.from ?? null,
    to: partial.to ?? null,
  }
}

describe('task movie timeline (v1.10 A1)', () => {
  it('sorts events chronologically and reconstructs status segments', () => {
    const entries = [
      entry({ at: 3000, action: 'completed', from: 'in_progress', to: 'awaiting_human' }),
      entry({ at: 1000, action: 'created', to: 'open' }),
      entry({ at: 2000, action: 'claimed', to: 'session-a' }),
      entry({ at: 4000, action: 'status', from: 'awaiting_human', to: 'done' }),
    ]
    const { events, segments } = buildTimeline(entries, 5000)
    expect(events.map(event => event.at)).toEqual([1000, 2000, 3000, 4000])
    expect(segments).toEqual([
      { status: 'open', start: 1000, end: 2000 },
      { status: 'in_progress', start: 2000, end: 3000 },
      { status: 'awaiting_human', start: 3000, end: 4000 },
      { status: 'done', start: 4000, end: 5000 },
    ])
  })

  it('treats a claimed entry as entering in_progress', () => {
    expect(enteredStatus(entry({ action: 'claimed', to: 'session-9' }))).toBe('in_progress')
  })

  it('ignores non-status actions (noted/edited/dispatched) in the segment walk', () => {
    const entries = [
      entry({ at: 1000, action: 'created', to: 'open' }),
      entry({ at: 1500, action: 'noted', to: 'a comment' }),
      entry({ at: 2000, action: 'status', from: 'open', to: 'done' }),
    ]
    const { segments } = buildTimeline(entries, 3000)
    expect(segments).toEqual([
      { status: 'open', start: 1000, end: 2000 },
      { status: 'done', start: 2000, end: 3000 },
    ])
  })
})
