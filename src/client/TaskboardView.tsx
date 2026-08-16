/**
 * The board panel: five columns over `/api/taskboard`.
 *
 * The panel writes. The approval gate is about the initiator, not the surface —
 * a human clicking "create" here is the authority, so the write goes straight
 * through, while the agent's `task_*` tools still pass `ctx.approval`. Each card
 * records which one made it.
 *
 * Colours are `color-mix` over `currentColor`, so the panel follows the shell's
 * light and dark themes without shipping a stylesheet or a CSS-module build.
 * @module @navidid/dsh-taskboard/client/TaskboardView
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { TaskboardKey } from './locales.ts'

/** Board columns, in display order. Mirrors `TASK_STATUSES` on the host. */
const COLUMNS = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'] as const
type Column = (typeof COLUMNS)[number]

/** Priorities, ascending. Mirrors `TASK_PRIORITIES` on the host. */
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

/** Priority accent, strongest first. */
const PRIORITY_TINT: Record<string, string> = {
  urgent: 'color-mix(in oklab, #e5484d 70%, currentColor)',
  high: 'color-mix(in oklab, #f76b15 60%, currentColor)',
  normal: 'color-mix(in oklab, currentColor 35%, transparent)',
  low: 'color-mix(in oklab, currentColor 20%, transparent)',
}

/** One task as the board route serves it. */
interface BoardTask {
  id: string
  projectId: string
  title: string
  body: string
  status: string
  priority: string
  labels: string[]
  origin: string
  revision: number
  updatedAt: number
}

/** One project as the board route serves it. */
interface BoardProject {
  id: string
  name: string
}

/** The board route's payload. */
interface BoardPayload {
  projects: BoardProject[]
  tasks: BoardTask[]
}

/** Props the slot registration injects. */
export interface TaskboardViewInjected {
  /** Bound translate for this package's namespace. */
  t: (key: TaskboardKey) => string
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
 * @param props - injected translate.
 * @returns the panel element.
 */
export function TaskboardView({ t }: TaskboardViewInjected): JSX.Element {
  const [board, setBoard] = useState<BoardPayload | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(true)
  const [composing, setComposing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftPriority, setDraftPriority] = useState<string>('normal')

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

  const submitDraft = useCallback(async (): Promise<void> => {
    const title = draftTitle.trim()
    if (title === '') return
    await write('/api/taskboard/task', 'POST', { title, priority: draftPriority })
    setDraftTitle('')
    setDraftPriority('normal')
    setComposing(false)
  }, [draftTitle, draftPriority, write])

  const projectName = (id: string): string =>
    board?.projects.find(project => project.id === id)?.name ?? id

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <strong style={{ fontSize: 14 }}>{t('view.taskboard')}</strong>
        <span style={{ fontSize: 12, opacity: 0.6, flex: 1 }}>{t('hint')}</span>
        <button
          type="button"
          onClick={() => { setComposing(value => !value) }}
          style={{ ...control, cursor: 'pointer' }}
        >
          + {t('new')}
        </button>
        <button
          type="button"
          onClick={() => { void load() }}
          disabled={busy}
          style={{ ...control, cursor: busy ? 'default' : 'pointer' }}
        >
          {busy ? t('loading') : t('refresh')}
        </button>
      </div>

      {composing && (
        <div style={{ ...surface, display: 'flex', gap: 8, padding: 10, alignItems: 'center' }}>
          <input
            autoFocus
            value={draftTitle}
            placeholder={t('title')}
            onChange={event => { setDraftTitle(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitDraft()
              if (event.key === 'Escape') setComposing(false)
            }}
            style={{ ...control, flex: 1, fontSize: 13 }}
          />
          <select
            value={draftPriority}
            onChange={event => { setDraftPriority(event.target.value) }}
            style={{ ...control, cursor: 'pointer' }}
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
          <button type="button" onClick={() => { setComposing(false) }} style={{ ...control, cursor: 'pointer' }}>
            {t('cancel')}
          </button>
        </div>
      )}

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
            return (
              // `minWidth` is the shrink floor, not a target: five columns must
              // fit a laptop-width conversation pane before the row scrolls.
              <div key={column} style={{ ...surface, minWidth: 180, flex: '1 1 0', padding: 10, maxHeight: '100%', overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, opacity: 0.75, marginBottom: 8 }}>
                  <span>{t(`column.${column}` as TaskboardKey)}</span>
                  <span>{tasks.length}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {tasks.map(task => (
                    <article
                      key={task.id}
                      style={{
                        ...surface,
                        background: 'color-mix(in oklab, currentColor 7%, transparent)',
                        padding: 10,
                        borderLeft: `3px solid ${PRIORITY_TINT[task.priority] ?? PRIORITY_TINT.normal}`,
                      }}
                    >
                      <div style={{ fontSize: 13, lineHeight: 1.35, marginBottom: 6 }}>{task.title}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 11, opacity: 0.65, marginBottom: 6 }}>
                        <span>{projectName(task.projectId)}</span>
                        <span>· {task.priority}</span>
                        <span>· rev {task.revision}</span>
                        <span>· {t(`origin.${task.origin === 'human' ? 'human' : 'agent'}` as TaskboardKey)}</span>
                      </div>
                      {task.labels.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                          {task.labels.map(label => (
                            <span key={label} style={{ ...surface, fontSize: 10, padding: '1px 6px', opacity: 0.8 }}>{label}</span>
                          ))}
                        </div>
                      )}
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
                        style={{ ...control, fontSize: 11, width: '100%', cursor: 'pointer' }}
                      >
                        {COLUMNS.map(target => (
                          <option key={target} value={target}>{t(`column.${target}` as TaskboardKey)}</option>
                        ))}
                      </select>
                    </article>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
