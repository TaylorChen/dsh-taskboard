/**
 * The board panel: seven columns over `/api/taskboard`.
 *
 * The panel writes. The approval gate is about the initiator, not the surface —
 * a human clicking "create" here is the authority, so the write goes straight
 * through, while the agent's `task_*` tools still pass `ctx.approval`. Each card
 * records which one made it.
 *
 * v0.2 additions: seven columns including the warning-coloured `blocked` (the
 * reason shows on the card); a per-column `+` that creates straight into that
 * column; an activity drawer per task (`GET /task/<id>/activity`); and — for a
 * claimed task — an "open in conversation" jump through the client `sessions`
 * service (Spike S2: `ctx.sessions.open`, the official API; no DOM or history
 * poking).
 *
 * Colours are `color-mix` over `currentColor`, so the panel follows the shell's
 * light and dark themes without shipping a stylesheet or a CSS-module build.
 * @module @navidid/dsh-taskboard/client/TaskboardView
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { TaskboardKey } from './locales.ts'

/** Board columns, in display order. Mirrors `TASK_STATUSES` on the host. */
const COLUMNS = ['draft', 'open', 'in_progress', 'awaiting_human', 'blocked', 'done', 'cancelled'] as const
type Column = (typeof COLUMNS)[number]

/** Statuses a human may move a card INTO from the panel. `blocked` is missing
 * on purpose: blocking reports an agent that is stuck and requires a reason —
 * the agent does it through `task_block`; a human unblocks by moving the card
 * anywhere else. A card already in `blocked` still shows its own status. */
const MOVE_TARGETS = COLUMNS.filter(column => column !== 'blocked')

/** Priorities, ascending. Mirrors `TASK_PRIORITIES` on the host. */
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

/** Priority accent, strongest first. */
const PRIORITY_TINT: Record<string, string> = {
  urgent: 'color-mix(in oklab, #e5484d 70%, currentColor)',
  high: 'color-mix(in oklab, #f76b15 60%, currentColor)',
  normal: 'color-mix(in oklab, currentColor 35%, transparent)',
  low: 'color-mix(in oklab, currentColor 20%, transparent)',
}

/** Warning accent for the blocked column. */
const BLOCKED_TINT = 'color-mix(in oklab, #e5484d 65%, currentColor)'

/** One task as the board route serves it. */
interface BoardTask {
  id: string
  key?: string
  projectId: string
  title: string
  body: string
  status: string
  priority: string
  labels: string[]
  origin: string
  revision: number
  updatedAt: number
  workspaceId: string | null
  blockedReason: string | null
  claimedBySessionId: string | null
}

/** One project as the board route serves it. */
interface BoardProject {
  id: string
  name: string
}

/** One workspace as the board route serves it (v0.4 W1). */
interface BoardWorkspace {
  id: string
  name: string
}

/** The board route's payload. */
interface BoardPayload {
  projects: BoardProject[]
  tasks: BoardTask[]
  workspaces: BoardWorkspace[]
}

/** One activity entry as the activity route serves it. */
interface ActivityEntry {
  id: string
  taskId: string
  at: number
  actor: 'human' | 'agent'
  actorLabel: string
  action: 'created' | 'status' | 'edited' | 'removed' | 'blocked' | 'claimed'
  from: string | null
  to: string | null
}

/** Props the slot registration injects. */
export interface TaskboardViewInjected {
  /** Bound translate for this package's namespace. */
  t: (key: TaskboardKey) => string
  /**
   * The client `sessions` service face, narrowed to what this view needs:
   * switching the active session (Spike S2's official API) with a liveness
   * guard, so a deleted session shows a hint instead of throwing.
   */
  sessions: {
    open(id: string): void
    exists(id: string): boolean
  }
}

const surface: CSSProperties = {
  background: 'color-mix(in oklab, currentColor 4%, transparent)',
  border: '1px solid color-mix(in oklab, currentColor 12%, transparent)',
  borderRadius: 8,
}

const control: CSSProperties = {
  ...surface,
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  padding: '4px 8px',
}

/**
 * Render the board.
 * @param props - injected translate and sessions service.
 * @returns the panel element.
 */
export function TaskboardView({ t, sessions }: TaskboardViewInjected): JSX.Element {
  const [board, setBoard] = useState<BoardPayload | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(true)
  // Per-column compose (W5): which column's inline form is open.
  const [composingIn, setComposingIn] = useState<Column | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftPriority, setDraftPriority] = useState<string>('normal')
  // Activity drawer (W3).
  const [activityTask, setActivityTask] = useState<BoardTask | null>(null)
  const [activity, setActivity] = useState<ActivityEntry[] | undefined>(undefined)
  const [activityError, setActivityError] = useState<string | undefined>(undefined)
  // Session liveness (W4): ids whose claiming session no longer exists.
  const [missingSessions, setMissingSessions] = useState<ReadonlySet<string>>(new Set())

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const response = await fetch('/api/taskboard/board')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setBoard(await response.json() as BoardPayload)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /** Send one write and refresh; surfaces the server's own message on refusal. */
  const write = useCallback(async (path: string, method: string, body: unknown): Promise<void> => {
    setBusy(true)
    try {
      const response = await fetch(path, {
        method,
        // Not a CORS-simple content type, which is what keeps a page the user
        // merely visits from reaching this route.
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(detail.error ?? `HTTP ${response.status}`)
      }
      setError(undefined)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }, [load])

  /** Create a task in the column whose `+` opened the form. */
  const submitDraft = useCallback(async (): Promise<void> => {
    const title = draftTitle.trim()
    if (title === '' || composingIn === null) return
    await write('/api/taskboard/task', 'POST', { title, priority: draftPriority, status: composingIn })
    setDraftTitle('')
    setDraftPriority('normal')
    setComposingIn(null)
  }, [draftTitle, draftPriority, composingIn, write])

  /** Open (or refresh) one task's activity drawer. */
  const openActivity = useCallback(async (task: BoardTask): Promise<void> => {
    setActivityTask(task)
    setActivity(undefined)
    setActivityError(undefined)
    try {
      const response = await fetch(`/api/taskboard/task/${encodeURIComponent(task.id)}/activity`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setActivity(await response.json() as ActivityEntry[])
    } catch (cause) {
      setActivityError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  /** Switch the conversation to a task's claiming session (W4). */
  const openSession = useCallback((sessionId: string): void => {
    if (!sessions.exists(sessionId)) {
      setMissingSessions(previous => new Set(previous).add(sessionId))
      return
    }
    sessions.open(sessionId)
  }, [sessions])

  /** Escape closes the activity drawer. */
  useEffect(() => {
    if (activityTask === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setActivityTask(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activityTask])

  const projectName = (id: string): string =>
    board?.projects.find(project => project.id === id)?.name ?? id

  const workspaceName = (id: string | null): string | undefined =>
    id === null
      ? undefined
      : board?.workspaces.find(workspace => workspace.id === id)?.name

  const sessionShort = (id: string): string => id.length > 12 ? `${id.slice(0, 12)}…` : id

  /** Render one activity entry in the drawer, newest first. */
  const describeEntry = (entry: ActivityEntry): string => {
    const actor = entry.actor === 'human'
      ? t('activity.actor.human')
      : `${t('activity.actor.agent')} ${sessionShort(entry.actorLabel)}`
    switch (entry.action) {
      case 'created': return `${actor} ${t('activity.created')}`
      case 'status':
        return `${actor} ${t('activity.status')} ${entry.to === null ? '' : t(`column.${entry.to}` as TaskboardKey)}`
      case 'blocked': return `${actor} ${t('activity.blocked')}`
      case 'claimed': return `${actor} ${t('activity.claimed')} ${sessionShort(entry.to ?? '')}`
      case 'removed': return `${actor} ${t('activity.removed')}`
      case 'edited': return `${actor} ${t('activity.edited')}`
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, height: '100%', overflow: 'hidden', position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <strong style={{ fontSize: 14 }}>{t('view.taskboard')}</strong>
        <span style={{ fontSize: 12, opacity: 0.6, flex: 1 }}>{t('hint')}</span>
        <button
          type="button"
          onClick={() => { void load() }}
          disabled={busy}
          style={{ ...control, cursor: busy ? 'default' : 'pointer' }}
        >
          {busy ? t('loading') : t('refresh')}
        </button>
      </div>

      {error !== undefined && (
        <div style={{ ...surface, padding: 12, fontSize: 13, color: 'color-mix(in oklab, #e5484d 80%, currentColor)' }}>
          {t('error')}: {error}
        </div>
      )}

      {board !== undefined && board.tasks.length === 0 && error === undefined && (
        <div style={{ ...surface, padding: 24, fontSize: 13, opacity: 0.7, textAlign: 'center' }}>{t('empty')}</div>
      )}

      {board !== undefined && board.tasks.length > 0 && (
        <div style={{ display: 'flex', gap: 12, overflowX: 'auto', flex: 1, alignItems: 'flex-start' }}>
          {COLUMNS.map((column) => {
            const tasks = board.tasks.filter(task => task.status === column)
            const blockedColumn = column === 'blocked'
            const composingHere = composingIn === column
            return (
              // `minWidth` is the shrink floor, not a target: seven columns
              // must fit a 1280px pane before the row scrolls.
              <div
                key={column}
                style={{
                  ...surface,
                  minWidth: 160,
                  flex: '1 1 0',
                  padding: 10,
                  maxHeight: '100%',
                  overflowY: 'auto',
                  ...blockedColumn ? { borderColor: 'color-mix(in oklab, #e5484d 45%, transparent)' } : {},
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, opacity: 0.75, marginBottom: 8 }}>
                  <span style={blockedColumn ? { color: BLOCKED_TINT } : undefined}>
                    {t(`column.${column}` as TaskboardKey)}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>{tasks.length}</span>
                    {/* W5: create straight into this column. */}
                    <button
                      type="button"
                      title={t('new')}
                      onClick={() => {
                        setComposingIn(composingHere ? null : column)
                        setDraftTitle('')
                      }}
                      style={{ ...control, padding: '1px 7px', cursor: 'pointer', lineHeight: 1.4 }}
                    >
                      +
                    </button>
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {composingHere && (
                    <div style={{ ...surface, display: 'flex', flexDirection: 'column', gap: 6, padding: 8 }}>
                      <input
                        autoFocus
                        value={draftTitle}
                        placeholder={t('title')}
                        onChange={event => { setDraftTitle(event.target.value) }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void submitDraft()
                          if (event.key === 'Escape') setComposingIn(null)
                        }}
                        style={{ ...control, fontSize: 13 }}
                      />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <select
                          value={draftPriority}
                          onChange={event => { setDraftPriority(event.target.value) }}
                          style={{ ...control, flex: 1, cursor: 'pointer' }}
                        >
                          {PRIORITIES.map(priority => <option key={priority} value={priority}>{priority}</option>)}
                        </select>
                        <button
                          type="button"
                          onClick={() => { void submitDraft() }}
                          disabled={busy || draftTitle.trim() === ''}
                          style={{ ...control, cursor: 'pointer' }}
                        >
                          {t('create')}
                        </button>
                        <button type="button" onClick={() => { setComposingIn(null) }} style={{ ...control, cursor: 'pointer' }}>
                          {t('cancel')}
                        </button>
                      </div>
                    </div>
                  )}
                  {tasks.map(task => (
                    <article
                      key={task.id}
                      style={{
                        ...surface,
                        background: 'color-mix(in oklab, currentColor 7%, transparent)',
                        padding: 10,
                        borderLeft: `3px solid ${PRIORITY_TINT[task.priority] ?? PRIORITY_TINT.normal}`,
                        ...blockedColumn ? { borderColor: 'color-mix(in oklab, #e5484d 55%, transparent)' } : {},
                      }}
                    >
                      <div style={{ fontSize: 13, lineHeight: 1.35, marginBottom: 6 }}>{task.title}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 11, opacity: 0.65, marginBottom: 6 }}>
                        <span>{task.key ?? task.id.slice(0, 8)}</span>
                        <span>· {projectName(task.projectId)}</span>
                        {workspaceName(task.workspaceId) !== undefined && (
                          <span>· {workspaceName(task.workspaceId)}</span>
                        )}
                        <span>· {task.priority}</span>
                        <span>· rev {task.revision}</span>
                        <span>· {t(`origin.${task.origin === 'human' ? 'human' : 'agent'}` as TaskboardKey)}</span>
                      </div>
                      {task.blockedReason !== null && (
                        <div style={{ fontSize: 11, color: BLOCKED_TINT, marginBottom: 6, lineHeight: 1.35 }}>
                          {t('blocked.reason')} {task.blockedReason}
                        </div>
                      )}
                      {task.labels.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                          {task.labels.map(label => (
                            <span key={label} style={{ ...surface, fontSize: 10, padding: '1px 6px', opacity: 0.8 }}>{label}</span>
                          ))}
                        </div>
                      )}
                      {/* W4: the claiming session, with a jump into that conversation. */}
                      {task.claimedBySessionId !== null && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                          <span style={{ fontSize: 10, opacity: 0.6 }}>{sessionShort(task.claimedBySessionId)}</span>
                          {missingSessions.has(task.claimedBySessionId) ? (
                            <span style={{ fontSize: 10, color: BLOCKED_TINT }}>{t('session.unknown')}</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => { openSession(task.claimedBySessionId as string) }}
                              style={{ ...control, fontSize: 10, padding: '1px 6px', cursor: 'pointer' }}
                            >
                              {t('session.open')}
                            </button>
                          )}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 6 }}>
                        {/* Moving a card is a human write: it carries the read
                            revision, so a concurrent agent edit wins and the
                            server answers 409 instead of clobbering it. */}
                        <select
                          value={task.status}
                          disabled={busy}
                          onChange={(event) => {
                            void write(
                              `/api/taskboard/task/${encodeURIComponent(task.id)}`,
                              'PATCH',
                              { status: event.target.value, expectedRevision: task.revision },
                            )
                          }}
                          style={{ ...control, fontSize: 11, flex: 1, cursor: 'pointer' }}
                        >
                          {(task.status === 'blocked' ? ['blocked', ...MOVE_TARGETS] : MOVE_TARGETS).map(target => (
                            <option key={target} value={target}>{t(`column.${target}` as TaskboardKey)}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => { void openActivity(task) }}
                          style={{ ...control, fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}
                          title={t('activity.title')}
                        >
                          {t('activity.title')}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* W3: the activity drawer, overlaying the board's right side. The
          panel's `surface` tint is far too transparent for an overlay — text
          from the board behind would ghost through. The drawer is therefore a
          blurred "glass" panel (legible in both themes) over an invisible
          click-catcher, so clicking outside or pressing Escape closes it
          without adding a dimming layer. */}
      {activityTask !== null && (
        <>
          <div
            onClick={() => { setActivityTask(null) }}
            style={{ position: 'absolute', inset: 0, zIndex: 20 }}
          />
          <div style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: 280,
            zIndex: 21,
            background: 'color-mix(in oklab, currentColor 12%, transparent)',
            backdropFilter: 'blur(12px) saturate(1.3)',
            WebkitBackdropFilter: 'blur(12px) saturate(1.3)',
            borderLeft: '1px solid color-mix(in oklab, currentColor 15%, transparent)',
            borderTopLeftRadius: 8,
            borderBottomLeftRadius: 8,
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '-8px 0 24px color-mix(in oklab, currentColor 20%, transparent)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, borderBottom: '1px solid color-mix(in oklab, currentColor 12%, transparent)' }}>
              <strong style={{ fontSize: 13, flex: 1 }}>{t('activity.title')}</strong>
              <span style={{ fontSize: 11, opacity: 0.6 }}>{activityTask.key ?? activityTask.title}</span>
              <button
                type="button"
                onClick={() => { setActivityTask(null) }}
                style={{ ...control, cursor: 'pointer' }}
              >
                {t('activity.close')}
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {activityError !== undefined && (
                <div style={{ fontSize: 12, color: BLOCKED_TINT }}>{activityError}</div>
              )}
              {activity === undefined && activityError === undefined && (
                <div style={{ fontSize: 12, opacity: 0.6 }}>{t('loading')}</div>
              )}
              {activity !== undefined && activity.length === 0 && (
                <div style={{ fontSize: 12, opacity: 0.6 }}>{t('empty')}</div>
              )}
              {activity !== undefined && activity.map(entry => (
                <div key={entry.id} style={{ ...surface, padding: 8, fontSize: 12, lineHeight: 1.4 }}>
                  <div>{describeEntry(entry)}</div>
                  <div style={{ fontSize: 10, opacity: 0.55, marginTop: 2 }}>
                    {new Date(entry.at).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
