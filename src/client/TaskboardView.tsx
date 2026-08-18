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

/** v1.2 B3: the "ball is with a human" accent — awaiting_human and blocked
 * cards/counts share the warning colour, so the one column a human must act
 * on stands out from the work-in-flight columns. */
const ATTENTION_TINT = BLOCKED_TINT

/**
 * v1.2 B3: a card "awaiting a human" ranks first when its deadline is already
 * past — the panel orders by who must act, not by storage order.
 */
const overdueRank = (task: BoardTask, now: number): number =>
  task.dueAt !== null && task.dueAt < now ? 0 : 1

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
  spec: { acceptanceCriteria: string[], contextRefs: string[], definitionOfDone: string } | null
  evidence: {
    criteria: Array<{ criterion: string, met: boolean, note: string }>
    artifacts: string[]
    summary: string
  } | null
  executor: 'agent' | 'human' | 'any'
  dueAt: number | null
  notes: string
  /** v1.3 D1: archive stamp; the archive view shows only tasks with one. */
  archivedAt: number | null
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
  /** v1.1 A2: task id -> running subagent, for the in-progress badge. */
  executions: Record<string, { subagentId: string, startedAt: number }>
}

/** v1.5 S1: the /stats payload — ratios, averages, trend, stuck, cost. */
interface BoardStats {
  ratios: { completionRate: number | null, reworkRate: number | null, agentSuccessRate: number | null, overdueRate: number | null }
  averages: { avgLeadTimeMin: number | null, avgCycleTimeMin: number | null, avgAwaitingHumanMin: number | null, avgBlockedMin: number | null }
  trend: Array<{ day: string, created: number, completed: number }>
  stuck: Array<{ key: string, title: string, status: string, dwellMin: number, thresholdMin: number }>
  oldest: Array<{ key: string, title: string, status: string, ageMin: number }>
  cost: { totalTokens: number | null, avgTokensPerTask: number | null, overBudgetCount: number | null }
}

/** One activity entry as the activity route serves it. */
interface ActivityEntry {
  id: string
  taskId: string
  at: number
  actor: 'human' | 'agent'
  actorLabel: string
  action: 'created' | 'status' | 'edited' | 'removed' | 'blocked' | 'claimed' | 'dispatched' | 'completed' | 'noted'
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
  // v1.4.2: ONE task form modal for both create and edit — the same fields,
  // create starts empty, edit loads the card's values. `taskId` is set in edit
  // mode, `status` is the target column in create mode.
  const [formDraft, setFormDraft] = useState<{
    mode: 'edit' | 'create'
    taskId?: string
    status?: Column
    title: string
    body: string
    priority: string
    executor: 'agent' | 'human' | 'any'
    dueAt: string
    // v1.7 P1: the owning project (editable in the form).
    projectId: string
  } | null>(null)
  // Activity drawer (W3).
  const [activityTask, setActivityTask] = useState<BoardTask | null>(null)
  const [activity, setActivity] = useState<ActivityEntry[] | undefined>(undefined)
  const [activityError, setActivityError] = useState<string | undefined>(undefined)
  // Session liveness (W4): ids whose claiming session no longer exists.
  const [missingSessions, setMissingSessions] = useState<ReadonlySet<string>>(new Set())
  // Spec editor (v1.0 UX fix): which draft card is collecting acceptance
  // criteria, and the draft text (one criterion per line).
  const [specDraft, setSpecDraft] = useState<{ taskId: string, criteria: string } | null>(null)
  // Bounce editor (v1.1 B1): which awaiting_human card is being bounced, and
  // the required reason.
  const [bounceDraft, setBounceDraft] = useState<{ taskId: string, reason: string } | null>(null)
  // v1.3 D1: show the archive instead of the active board (archived tasks are
  // done cards with an archivedAt stamp; restore is one click).
  const [archivedView, setArchivedView] = useState(false)
  // v1.3 D4: two-step confirm for 归档全部 (first click arms, second fires).
  const [archiveAllArmed, setArchiveAllArmed] = useState(false)
  // v1.4 E1: project focus — 'all' shows every project's tasks.
  const [projectFilter, setProjectFilter] = useState<string>('all')
  // v1.4 E3: the card being dragged and the card currently under the cursor.
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  // v1.5 S1: the expandable stats panel — ratios, trend, stuck, cost.
  const [statsOpen, setStatsOpen] = useState(false)
  const [stats, setStats] = useState<BoardStats | null>(null)
  const [statsError, setStatsError] = useState<string | undefined>(undefined)
  // v1.6 C4: search + single-select filters (label/priority), panel-side.
  const [searchQuery, setSearchQuery] = useState('')
  // v1.7 P1: header project creation (inline input).
  const [projectCreateOpen, setProjectCreateOpen] = useState(false)
  // v1.7 P2: the drawer's comment composer.
  const [commentText, setCommentText] = useState('')
  const [projectCreateName, setProjectCreateName] = useState('')
  const [filterPriority, setFilterPriority] = useState('all')
  const [filterLabel, setFilterLabel] = useState('all')

  /** Fetch the board without touching `busy`; shared by load (busy) and the
   * v1.6 C1 SSE auto-refresh (silent). */
  const fetchBoard = useCallback(async (): Promise<void> => {
    // v1.3 D1: the archive is the same board, one query away; v1.4 E1: the
    // project focus composes with it.
    const params = new URLSearchParams()
    if (archivedView) params.set('archived', 'true')
    if (projectFilter !== 'all') params.set('project', projectFilter)
    const qs = params.toString()
    const response = await fetch(`/api/taskboard/board${qs === '' ? '' : `?${qs}`}`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    setBoard(await response.json() as BoardPayload)
  }, [archivedView, projectFilter])

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      await fetchBoard()
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [fetchBoard])

  // v1.6 C1: the server pushes `changed` on every taskboard write; reload the
  // board (debounced) so another session's or agent's change appears without
  // polling. EventSource reconnects automatically on drop.
  useEffect(() => {
    const source = new EventSource('/api/taskboard/events')
    let timer: ReturnType<typeof setTimeout> | undefined
    const reload = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { void fetchBoard().catch(() => {}) }, 500)
    }
    source.addEventListener('changed', reload)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      source.close()
    }
  }, [fetchBoard])

  useEffect(() => { void load() }, [load])

  /** v1.5 S1: fetch the stats payload on demand (only when the panel opens). */
  const loadStats = useCallback(async (): Promise<void> => {
    setStatsError(undefined)
    try {
      const response = await fetch('/api/taskboard/stats')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setStats(await response.json() as BoardStats)
    } catch (cause) {
      setStatsError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const toggleStats = useCallback((): void => {
    if (!statsOpen) void loadStats()
    setStatsOpen(open => !open)
  }, [statsOpen, loadStats])

  const formatMin = (min: number | null): string => {
    if (min === null) return '—'
    if (min < 60) return `${min}m`
    if (min < 24 * 60) return `${Math.round(min / 60)}h`
    return `${(min / (24 * 60)).toFixed(1)}d`
  }

  const percent = (value: number | null): string => value === null ? '—' : `${value}%`

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

  /** v1.7 P1: create a project from the header and reload. */
  const submitProject = useCallback(async (): Promise<void> => {
    const name = projectCreateName.trim()
    if (name === '') return
    await write('/api/taskboard/projects', 'POST', { name })
    setProjectCreateName('')
    setProjectCreateOpen(false)
  }, [projectCreateName, write])

  /** v1.4.2: open the create form for a column — same modal as edit, empty
   * fields, target column fixed. Blocked is an agent's report (it needs a
   * reason), so its `+` creates into draft instead. */
  const openCreate = useCallback((column: Column): void => {
    setFormDraft({
      mode: 'create',
      status: column === 'blocked' ? 'draft' : column,
      title: '',
      body: '',
      priority: 'normal',
      executor: 'any',
      dueAt: '',
      projectId: projectFilter !== 'all' ? projectFilter : (board?.projects[0]?.id ?? ''),
    })
  }, [projectFilter, board])

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

  /** v1.7 P2: append a comment (note) from the drawer; the next comment then
   * carries the bumped revision. */
  const sendComment = useCallback(async (): Promise<void> => {
    if (activityTask === null || commentText.trim() === '') return
    const text = commentText.trim()
    await write(`/api/taskboard/task/${encodeURIComponent(activityTask.id)}`, 'PATCH', {
      note: text,
      expectedRevision: activityTask.revision,
    })
    setCommentText('')
    const fresh = board?.tasks.find(task => task.id === activityTask.id)
    if (fresh !== undefined) void openActivity(fresh)
  }, [activityTask, commentText, board, write, openActivity])

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

  /** Escape closes the task form modal (v1.4.1/1.4.2), wherever focus is. */
  useEffect(() => {
    if (formDraft === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFormDraft(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [formDraft])

  /** Save the spec editor: one acceptance criterion per line, then the card
   * may move to open. */
  const saveSpec = useCallback(async (task: BoardTask): Promise<void> => {
    if (specDraft === null || specDraft.taskId !== task.id) return
    const criteria = specDraft.criteria.split('\n').map(line => line.trim()).filter(line => line !== '')
    if (criteria.length === 0) return
    await write(`/api/taskboard/task/${encodeURIComponent(task.id)}`, 'PATCH', {
      acceptance_criteria: criteria,
      expectedRevision: task.revision,
    })
    setSpecDraft(null)
  }, [specDraft, write])

  /** Confirm a bounce: the reason is required and lands in the task notes. */
  const confirmBounce = useCallback(async (task: BoardTask): Promise<void> => {
    if (bounceDraft === null || bounceDraft.taskId !== task.id) return
    const reason = bounceDraft.reason.trim()
    if (reason === '') return
    await write(`/api/taskboard/task/${encodeURIComponent(task.id)}`, 'PATCH', {
      status: 'draft',
      note: `bounce: ${reason}`,
      expectedRevision: task.revision,
    })
    setBounceDraft(null)
  }, [bounceDraft, write])

  /** v1.4.2: save the task form — PATCH in edit mode (empty deadline clears
   * `dueAt`), POST in create mode (target column from the `+` that opened
   * it). Both carry the fields the other mode's card needs. */
  const saveForm = useCallback(async (task: BoardTask | undefined): Promise<void> => {
    if (formDraft === null) return
    const title = formDraft.title.trim()
    if (title === '') return
    if (formDraft.mode === 'edit') {
      if (task === undefined || formDraft.taskId !== task.id) return
      await write(`/api/taskboard/task/${encodeURIComponent(task.id)}`, 'PATCH', {
        title,
        ...formDraft.body !== task.body ? { body: formDraft.body } : {},
        priority: formDraft.priority,
        executor: formDraft.executor,
        ...formDraft.dueAt === '' ? { due_at: null } : { due_at: new Date(formDraft.dueAt).getTime() },
        // v1.7 P1: migrate the task to another project from the form.
        ...formDraft.projectId !== '' && formDraft.projectId !== task.projectId
          ? { project_id: formDraft.projectId } : {},
        expectedRevision: task.revision,
      })
    } else {
      await write('/api/taskboard/task', 'POST', {
        title,
        ...formDraft.body === '' ? {} : { body: formDraft.body },
        priority: formDraft.priority,
        executor: formDraft.executor,
        ...formDraft.dueAt === '' ? {} : { due_at: new Date(formDraft.dueAt).getTime() },
        // v1.7 P1: the form's project select decides; falls back to the
        // server default when empty.
        ...formDraft.projectId !== '' ? { projectId: formDraft.projectId } : {},
        status: formDraft.status ?? 'draft',
      })
    }
    setFormDraft(null)
  }, [formDraft, projectFilter, write])

  /** v1.3 D3: one click out of blocked — the server clears the reason. */
  const unblock = useCallback(async (task: BoardTask): Promise<void> => {
    await write(`/api/taskboard/task/${encodeURIComponent(task.id)}`, 'PATCH', {
      status: 'open',
      expectedRevision: task.revision,
    })
  }, [write])

  /** v1.3 D4: sweep the whole done column, then reload. */
  const archiveAllDone = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const response = await fetch('/api/taskboard/archive-done', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(detail.error ?? `HTTP ${response.status}`)
      }
      setError(undefined)
      setArchiveAllArmed(false)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }, [load])

  /** v1.4 E3: drop the dragged card into the column at the hovered position
   * and POST the column's full order. Only in the unfiltered view — a project
   * filter hides the ids the whole-column check needs. */
  const dropOn = useCallback(async (column: Column, columnTasks: BoardTask[]): Promise<void> => {
    if (dragId === null || projectFilter !== 'all' || archivedView) return
    const from = columnTasks.findIndex(task => task.id === dragId)
    if (from === -1) return // dragged from another column — moves go via the status select
    const over = dragOverId === null
      ? columnTasks.length - 1
      : Math.max(0, columnTasks.findIndex(task => task.id === dragOverId))
    const reordered = [...columnTasks]
    const moved = reordered[from] as BoardTask
    reordered.splice(from, 1)
    reordered.splice(over, 0, moved)
    const unchanged = reordered.every((task, index) => task.id === columnTasks[index]?.id)
    setDragId(null)
    setDragOverId(null)
    if (unchanged) return
    await write('/api/taskboard/reorder', 'POST', { refs: reordered.map(task => task.id) })
  }, [dragId, dragOverId, projectFilter, archivedView, write])

  /** v1.3 D2 (v1.4.2 modal): seed the form from a card (epoch ms -> local
   * datetime-local). */
  const openEdit = useCallback((task: BoardTask): void => {
    const pad = (value: number): string => String(value).padStart(2, '0')
    const localInput = task.dueAt === null
      ? ''
      : (() => {
        const d = new Date(task.dueAt as number)
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
      })()
    setFormDraft({
      mode: 'edit',
      taskId: task.id,
      title: task.title,
      body: task.body,
      priority: task.priority,
      executor: task.executor,
      dueAt: localInput,
      projectId: task.projectId,
    })
  }, [])

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
      case 'completed':
        return `${actor} ${t('activity.completed')} ${entry.to === null ? '' : t(`column.${entry.to}` as TaskboardKey)}`
      case 'dispatched': return `${actor} ${t('activity.dispatched')} ${sessionShort(entry.to ?? '')}`
      // v1.7 P2: a noted entry IS the thread — author followed by the text.
      case 'noted': return `${actor}: ${entry.to ?? ''}`
    }
  }

  // v1.2 B3: one clock for the whole render, so the overdue-top sort and the
  // per-card overdue badge cannot disagree with each other.
  const now = Date.now()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, height: '100%', overflow: 'hidden', position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>{t('view.taskboard')}</strong>
        {/* v1.4 E1: project focus — one project at a time, or everything. */}
        <select
          value={projectFilter}
          disabled={busy}
          onChange={event => { setProjectFilter(event.target.value) }}
          style={{ ...control, cursor: 'pointer' }}
        >
          <option value="all">{t('project.all')}</option>
          {board?.projects.map(project => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
        {/* v1.7 P1: create a project straight from the header. */}
        {projectCreateOpen ? (
          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              autoFocus
              value={projectCreateName}
              placeholder={t('project.new')}
              onChange={event => { setProjectCreateName(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitProject()
                if (event.key === 'Escape') { setProjectCreateOpen(false); setProjectCreateName('') }
              }}
              style={{ ...control, fontSize: 12, width: 130 }}
            />
            <button type="button" onClick={() => { void submitProject() }} disabled={projectCreateName.trim() === ''}
              style={{ ...control, cursor: projectCreateName.trim() === '' ? 'default' : 'pointer' }}>✓</button>
            <button type="button" onClick={() => { setProjectCreateOpen(false); setProjectCreateName('') }}
              style={{ ...control, cursor: 'pointer' }}>×</button>
          </span>
        ) : (
          <button type="button" title={t('project.new')} onClick={() => { setProjectCreateOpen(true) }}
            style={{ ...control, cursor: 'pointer' }}>+</button>
        )}
        <span style={{ fontSize: 12, opacity: 0.6, flex: 1 }}>{t('hint')}</span>
        {/* v1.3 D1: the archive is one query away — 归档 ≠ 删除, and the
            toggle is how history comes back into view. */}
        <button
          type="button"
          onClick={() => { setArchivedView(current => !current) }}
          disabled={busy}
          style={{ ...control, cursor: busy ? 'default' : 'pointer' }}
          title={archivedView ? t('archive.active') : t('archive.view')}
        >
          {archivedView ? t('archive.active') : t('archive.view')}
        </button>
        {/* v1.5 S1: the stats panel toggle — ratios, trend, stuck, cost. */}
        <button
          type="button"
          onClick={toggleStats}
          style={{ ...control, cursor: 'pointer' }}
          title={t('stats.button')}
        >
          {statsOpen ? t('stats.hide') : t('stats.button')}
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

      {/* v1.4 E2: the board at a glance — totals, the waiting-on-you sum in
          warning colour, and overdue work. All derived from the loaded board. */}
      {board !== undefined && (
        <div style={{ display: 'flex', gap: 14, fontSize: 12, opacity: 0.85, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>{t('stats.total')}: {board.tasks.length}</span>
          <span>{t('stats.open')}: {board.tasks.filter(task => task.status === 'open').length}</span>
          <span>{t('stats.inProgress')}: {board.tasks.filter(task => task.status === 'in_progress').length}</span>
          <span style={{ color: BLOCKED_TINT, fontWeight: 700 }}>
            {t('stats.waiting')}: {board.tasks.filter(task => task.status === 'awaiting_human' || task.status === 'blocked').length}
          </span>
          <span style={{ color: board.tasks.some(task => task.dueAt !== null && task.dueAt < now && task.status !== 'done' && task.status !== 'cancelled') ? BLOCKED_TINT : undefined }}>
            {t('stats.overdue')}: {board.tasks.filter(task => task.dueAt !== null && task.dueAt < now && task.status !== 'done' && task.status !== 'cancelled').length}
          </span>
          <span>{t('stats.done')}: {board.tasks.filter(task => task.status === 'done').length}</span>
          {projectFilter !== 'all' && !archivedView && (
            <span style={{ opacity: 0.55 }}>{t('sort.hint')}</span>
          )}
        </div>
      )}

      {/* v1.5 S1: the stats panel — everything derived from the activity
          stream. Ratios + averages on one row, a 7-day throughput mini-chart
          (pure CSS bars), stuck tasks in warning colour, oldest open. */}
      {statsOpen && (
        <div style={{ ...surface, padding: 10, display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 }}>
          {statsError !== undefined && (
            <div style={{ color: BLOCKED_TINT }}>{t('error')}: {statsError}</div>
          )}
          {stats === null && statsError === undefined && (
            <div style={{ opacity: 0.6 }}>{t('loading')}</div>
          )}
          {stats !== null && (
            <>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', opacity: 0.9 }}>
                <span>{t('stats.completion')}: <strong>{percent(stats.ratios.completionRate)}</strong></span>
                <span>{t('stats.rework')}: <strong>{percent(stats.ratios.reworkRate)}</strong></span>
                <span>{t('stats.success')}: <strong>{percent(stats.ratios.agentSuccessRate)}</strong></span>
                <span style={stats.ratios.overdueRate !== null && stats.ratios.overdueRate > 0 ? { color: BLOCKED_TINT } : undefined}>
                  {t('stats.overdueRate')}: <strong>{percent(stats.ratios.overdueRate)}</strong>
                </span>
              </div>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', opacity: 0.85 }}>
                <span>{t('stats.lead')}: {formatMin(stats.averages.avgLeadTimeMin)}</span>
                <span>{t('stats.cycle')}: {formatMin(stats.averages.avgCycleTimeMin)}</span>
                <span>{t('stats.awaiting')}: {formatMin(stats.averages.avgAwaitingHumanMin)}</span>
                <span>{t('stats.blocked')}: {formatMin(stats.averages.avgBlockedMin)}</span>
              </div>
              <div>
                <div style={{ opacity: 0.7, marginBottom: 4 }}>{t('stats.trend')}</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 44 }}>
                  {stats.trend.map(point => {
                    const height = Math.max(2, Math.round((point.completed / Math.max(1, ...stats.trend.map(p => p.completed))) * 36))
                    return (
                      <div key={point.day} title={`${point.day} · ${t('stats.done')} ${point.completed} / ${t('stats.new')} ${point.created}`}
                        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                        <div style={{ width: 14, height, background: 'color-mix(in oklab, currentColor 45%, transparent)', borderRadius: 2 }} />
                        <span style={{ fontSize: 9, opacity: 0.55 }}>{point.day.slice(5)}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
              {stats.stuck.length > 0 && (
                <div>
                  <div style={{ opacity: 0.7, marginBottom: 4, color: BLOCKED_TINT }}>{t('stats.stuck')}</div>
                  {stats.stuck.map(task => (
                    <div key={task.key} style={{ fontSize: 11, color: BLOCKED_TINT, marginBottom: 2 }}>
                      {task.key} {task.title} · {t('stats.waitingMin')} {formatMin(task.dwellMin)} / {t('stats.thresholdMin')} {formatMin(task.thresholdMin)}
                    </div>
                  ))}
                </div>
              )}
              {stats.oldest.length > 0 && (
                <div>
                  <div style={{ opacity: 0.7, marginBottom: 4 }}>{t('stats.oldest')}</div>
                  {stats.oldest.map(task => (
                    <div key={task.key} style={{ fontSize: 11, opacity: 0.85, marginBottom: 2 }}>
                      {task.key} {task.title} · {t(`column.${task.status}` as TaskboardKey)} · {formatMin(task.ageMin)}
                    </div>
                  ))}
                </div>
              )}
              {stats.cost.totalTokens !== null && (
                <div style={{ opacity: 0.85 }}>
                  {t('stats.cost')}: {stats.cost.totalTokens} tok · {t('stats.avgPerTask')} {stats.cost.avgTokensPerTask} · {t('stats.overBudget')} {stats.cost.overBudgetCount}
                </div>
              )}
            </>
          )}
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

      {/* v1.6 C4: search + filters — applied client-side over the loaded
          board, composing with the project/archive views. */}
      {board !== undefined && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={searchQuery}
            placeholder={t('filter.search')}
            onChange={event => { setSearchQuery(event.target.value) }}
            style={{ ...control, fontSize: 12, flex: 1, minWidth: 160 }}
          />
          <select
            value={filterPriority}
            onChange={event => { setFilterPriority(event.target.value) }}
            style={{ ...control, fontSize: 12, cursor: 'pointer' }}
          >
            <option value="all">{t('filter.allPriority')}</option>
            {PRIORITIES.map(priority => <option key={priority} value={priority}>{priority}</option>)}
          </select>
          <select
            value={filterLabel}
            onChange={event => { setFilterLabel(event.target.value) }}
            style={{ ...control, fontSize: 12, cursor: 'pointer' }}
          >
            <option value="all">{t('filter.allLabels')}</option>
            {[...new Set(board.tasks.flatMap(task => task.labels))].sort().map(label => (
              <option key={label} value={label}>{label}</option>
            ))}
          </select>
        </div>
      )}

      {board !== undefined && (() => {
        const q = searchQuery.trim().toLowerCase()
        const visible = board.tasks.filter(task => {
          if (q !== ''
            && !(task.key ?? '').toLowerCase().includes(q)
            && !task.title.toLowerCase().includes(q)
            && !task.body.toLowerCase().includes(q)) return false
          if (filterPriority !== 'all' && task.priority !== filterPriority) return false
          if (filterLabel !== 'all' && !task.labels.includes(filterLabel)) return false
          return true
        })
        const filtering = q !== '' || filterPriority !== 'all' || filterLabel !== 'all'
        return (
          <>
            {board.tasks.length > 0 && visible.length === 0 && (
              <div style={{ ...surface, padding: 16, fontSize: 13, opacity: 0.7, textAlign: 'center' }}>{t('filter.noMatch')}</div>
            )}
            {visible.length === 0 && !filtering && (
              <div style={{ ...surface, padding: 24, fontSize: 13, opacity: 0.7, textAlign: 'center' }}>{t('empty')}</div>
            )}
            {visible.length > 0 && (
      <div style={{ display: 'flex', gap: 12, overflowX: 'auto', flex: 1, alignItems: 'flex-start' }}>
          {COLUMNS.map((column) => {
            // v1.4 E3: while a drag is live IN this column, render the true
            // storage order — the overdue float is a render hint, and the
            // reorder must not bake it into sortOrder.
            const draggingHere = dragId !== null
              && visible.some(task => task.id === dragId && task.status === column)
            // v1.2 B3: overdue cards float to the top of their column (stable
            // sort keeps the storage order for everything else).
            const tasks = visible
              .filter(task => task.status === column)
              .sort((a, b) => draggingHere ? 0 : overdueRank(a, now) - overdueRank(b, now))
            const blockedColumn = column === 'blocked'
            // v1.2 B3: the two columns whose ball is with a HUMAN get the
            // warning accent, so the count says "you must act".
            const attentionColumn = column === 'awaiting_human' || blockedColumn
            return (
              // `minWidth` is the shrink floor, not a target: seven columns
              // must fit a 1280px pane before the row scrolls.
              <div
                key={column}
                onDragOver={(event) => { event.preventDefault() }}
                onDrop={() => { void dropOn(column, tasks) }}
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
                    {/* v1.2 B3: the "waiting on you" columns count in warning
                        colour, bold — the badge is a call to action, not a
                        statistic. */}
                    <span style={attentionColumn ? { color: BLOCKED_TINT, fontWeight: 700 } : undefined}>{tasks.length}</span>
                    {/* v1.3 D4: one click sweeps the done column (two-step to
                        survive a stray click). */}
                    {column === 'done' && !archivedView && (
                      <button
                        type="button"
                        title={t('archive.all')}
                        disabled={busy || tasks.length === 0}
                        onClick={() => {
                          if (!archiveAllArmed) { setArchiveAllArmed(true); return }
                          void archiveAllDone()
                        }}
                        onBlur={() => { setArchiveAllArmed(false) }}
                        style={{ ...control, padding: '1px 7px', cursor: busy || tasks.length === 0 ? 'default' : 'pointer', lineHeight: 1.4 }}
                      >
                        {archiveAllArmed ? t('archive.allConfirm') : t('archive.all')}
                      </button>
                    )}
                    {/* v1.4.2: create straight into this column — opens the
                        same task-form modal as edit, fields empty. */}
                    <button
                      type="button"
                      title={t('new')}
                      onClick={() => { openCreate(column) }}
                      style={{ ...control, padding: '1px 7px', cursor: 'pointer', lineHeight: 1.4 }}
                    >
                      +
                    </button>
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {tasks.map(task => (
                    <article
                      key={task.id}
                      // v1.4 E3: drag to reorder — only in the unfiltered
                      // active view (the whole-column check needs all ids).
                      draggable={!archivedView && projectFilter === 'all' && !busy}
                      onDragStart={() => { setDragId(task.id); setDragOverId(task.id) }}
                      onDragEnd={() => { setDragId(null); setDragOverId(null) }}
                      onDragOver={(event) => { event.preventDefault(); setDragOverId(task.id) }}
                      title={!archivedView && projectFilter === 'all' ? t('sort.drag') : t('sort.hint')}
                      style={{
                        ...surface,
                        background: 'color-mix(in oklab, currentColor 7%, transparent)',
                        padding: 10,
                        cursor: !archivedView && projectFilter === 'all' && !busy ? 'grab' : 'default',
                        ...dragOverId === task.id && dragId !== null && dragId !== task.id
                          ? { borderTop: '2px solid color-mix(in oklab, currentColor 45%, transparent)' }
                          : {},
                        ...dragId === task.id
                          ? { opacity: 0.45 }
                          : {},
                        borderLeft: `3px solid ${
                          // v1.2 B3: a card waiting on a human gets the warning
                          // accent (blocked cards already paint all borders red
                          // via the column tint below).
                          task.status === 'awaiting_human'
                            ? ATTENTION_TINT
                            : (PRIORITY_TINT[task.priority] ?? PRIORITY_TINT.normal)
                        }`,
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
                        <span>· {t(`executor.${task.executor}` as TaskboardKey)}</span>
                        {task.dueAt !== null && (
                          <span style={{ color: task.dueAt < now ? BLOCKED_TINT : undefined }}>
                            · {task.dueAt < now ? t('due.overdue') : new Date(task.dueAt).toLocaleDateString()}
                          </span>
                        )}
                        <span>· {task.priority}</span>
                        <span>· rev {task.revision}</span>
                        <span>· {t(`origin.${task.origin === 'human' ? 'human' : 'agent'}` as TaskboardKey)}</span>
                      </div>
                      {task.notes !== '' && (
                        <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 6, lineHeight: 1.35, whiteSpace: 'pre-line' }}>
                          {t('notes.title')}: {task.notes.length > 160 ? `${task.notes.slice(-160)}…` : task.notes}
                        </div>
                      )}
                      {task.blockedReason !== null && (
                        <div style={{ fontSize: 11, color: BLOCKED_TINT, marginBottom: 6, lineHeight: 1.35 }}>
                          {t('blocked.reason')} {task.blockedReason}
                        </div>
                      )}
                      {/* v0.5: a draft task's spec completeness is the gate to
                          open. The panel must offer the way to complete it —
                          otherwise moving to open is guaranteed to fail. */}
                      {task.status === 'draft' && (task.spec === null || task.spec.acceptanceCriteria.length === 0) && (
                        <div style={{ fontSize: 11, color: BLOCKED_TINT, marginBottom: 6 }}>
                          {t('spec.missingCriteria')}
                        </div>
                      )}
                      {task.status === 'draft' && (task.spec === null || task.spec.acceptanceCriteria.length === 0)
                        && specDraft?.taskId !== task.id && (
                        <button
                          type="button"
                          onClick={() => {
                            setSpecDraft({
                              taskId: task.id,
                              criteria: (task.spec?.acceptanceCriteria ?? []).join('\n'),
                            })
                          }}
                          style={{ ...control, fontSize: 11, padding: '2px 8px', cursor: 'pointer', marginBottom: 6 }}
                        >
                          {t('spec.addCriteria')}
                        </button>
                      )}
                      {task.status === 'draft' && specDraft?.taskId === task.id && (
                        <div style={{ ...surface, display: 'flex', flexDirection: 'column', gap: 6, padding: 8, marginBottom: 6 }}>
                          <textarea
                            autoFocus
                            value={specDraft.criteria}
                            placeholder={t('spec.criteriaPlaceholder')}
                            onChange={event => { setSpecDraft({ taskId: task.id, criteria: event.target.value }) }}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') setSpecDraft(null)
                            }}
                            rows={3}
                            style={{ ...control, fontSize: 11, resize: 'vertical', fontFamily: 'inherit' }}
                          />
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              onClick={() => { void saveSpec(task) }}
                              disabled={busy || specDraft.criteria.trim() === ''}
                              style={{ ...control, fontSize: 11, padding: '2px 8px', cursor: 'pointer', flex: 1 }}
                            >
                              {t('spec.save')}
                            </button>
                            <button
                              type="button"
                              onClick={() => { setSpecDraft(null) }}
                              style={{ ...control, fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}
                            >
                              {t('cancel')}
                            </button>
                          </div>
                        </div>
                      )}
                      {task.status === 'draft' && task.spec !== null && task.spec.contextRefs.length === 0 && task.spec.acceptanceCriteria.length > 0 && (
                        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6 }}>
                          {t('spec.suggestRefs')}
                        </div>
                      )}
                      {task.spec !== null && task.spec.acceptanceCriteria.length > 0 && task.status !== 'draft' && (
                        <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, lineHeight: 1.35 }}>
                          {task.spec.acceptanceCriteria.map((criterion, index) => (
                            <div key={index}>✓ {criterion}</div>
                          ))}
                        </div>
                      )}
                      {/* v0.6: a settled task carries the subagent's evidence;
                          the human confirms or bounces it. */}
                      {task.status === 'awaiting_human' && task.evidence !== null && (
                        <div style={{ ...surface, padding: 8, marginBottom: 6, fontSize: 11, lineHeight: 1.4 }}>
                          <div style={{ opacity: 0.7, marginBottom: 4 }}>{t('evidence.title')}</div>
                          {task.evidence.criteria.map((entry, index) => (
                            <div key={index} style={{ display: 'flex', gap: 6, marginBottom: 2 }}>
                              <span style={{ color: entry.met ? undefined : BLOCKED_TINT }}>
                                {entry.met ? '✓' : '✗'}
                              </span>
                              <span style={{ flex: 1 }}>
                                {entry.criterion}
                                {entry.note !== '' && <span style={{ opacity: 0.6 }}> — {entry.note}</span>}
                              </span>
                            </div>
                          ))}
                          {task.evidence.artifacts.length > 0 && (
                            <div style={{ opacity: 0.7, marginTop: 4 }}>
                              {t('evidence.artifacts')}: {task.evidence.artifacts.join(', ')}
                            </div>
                          )}
                          {task.evidence.summary !== '' && (
                            <div style={{ opacity: 0.7, marginTop: 4 }}>{task.evidence.summary}</div>
                          )}
                        </div>
                      )}
                      {task.status === 'awaiting_human' && (
                        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                          <button
                            type="button"
                            onClick={() => {
                              void write(
                                `/api/taskboard/task/${encodeURIComponent(task.id)}`,
                                'PATCH',
                                { status: 'done', expectedRevision: task.revision },
                              )
                            }}
                            style={{ ...control, fontSize: 11, padding: '2px 8px', cursor: 'pointer', flex: 1 }}
                          >
                            {t('evidence.confirm')}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              // v1.1 B1: a bounce must carry a reason; open
                              // the reason editor instead of bouncing blind.
                              setBounceDraft({ taskId: task.id, reason: '' })
                            }}
                            style={{ ...control, fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}
                          >
                            {t('evidence.bounce')}
                          </button>
                        </div>
                      )}
                      {task.status === 'awaiting_human' && bounceDraft?.taskId === task.id && (
                        <div style={{ ...surface, display: 'flex', flexDirection: 'column', gap: 6, padding: 8, marginBottom: 6 }}>
                          <input
                            autoFocus
                            value={bounceDraft.reason}
                            placeholder={t('bounce.reason')}
                            onChange={event => { setBounceDraft({ taskId: task.id, reason: event.target.value }) }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void confirmBounce(task)
                              if (event.key === 'Escape') setBounceDraft(null)
                            }}
                            style={{ ...control, fontSize: 11 }}
                          />
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              onClick={() => { void confirmBounce(task) }}
                              disabled={busy || bounceDraft.reason.trim() === ''}
                              style={{ ...control, fontSize: 11, padding: '2px 8px', cursor: 'pointer', flex: 1 }}
                            >
                              {t('bounce.confirm')}
                            </button>
                            <button
                              type="button"
                              onClick={() => { setBounceDraft(null) }}
                              style={{ ...control, fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}
                            >
                              {t('cancel')}
                            </button>
                          </div>
                        </div>
                      )}
                      {/* v1.3 D1: the archive view stamps when it happened. */}
                      {archivedView && task.archivedAt !== null && (
                        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6 }}>
                          {t('archive.stamped')} {new Date(task.archivedAt).toLocaleDateString()}
                        </div>
                      )}
                      {/* v1.4.1: the card editor moved OUT of the card into a
                          centered modal (see the overlay near the bottom) —
                          a 160px column is no place for a form. */}
                      {/* v1.1 A2: an in-progress task that is dispatched shows
                          which subagent is running it and for how long. */}
                      {task.status === 'in_progress' && board?.executions[task.id] !== undefined && (() => {
                        const execution = board.executions[task.id] as { subagentId: string, startedAt: number }
                        return (
                          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>
                            {t('execution.running')} · {sessionShort(execution.subagentId)}
                            {' · '}
                            {Math.max(1, Math.round((now - execution.startedAt) / 60_000))}{t('execution.minutes')}
                          </div>
                        )
                      })()}
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
                        {/* v1.3 D1: the archive is read-mostly — restore is
                            the one move (the same governance write that
                            archived it, flipped). */}
                        {archivedView ? (
                          <button
                            type="button"
                            onClick={() => {
                              void write(
                                `/api/taskboard/task/${encodeURIComponent(task.id)}`,
                                'PATCH',
                                { archived: false, expectedRevision: task.revision },
                              )
                            }}
                            style={{ ...control, fontSize: 11, padding: '2px 8px', cursor: 'pointer', flex: 1 }}
                          >
                            {t('archive.restore')}
                          </button>
                        ) : (
                          <>
                            {/* Moving a card is a human write: it carries the read
                                revision, so a concurrent agent edit wins and the
                                server answers 409 instead of clobbering it. */}
                            <select
                              value={task.status}
                              disabled={busy}
                              onChange={(event) => {
                                // Moving a draft task to open requires a complete
                                // spec; instead of letting the server reject the
                                // write, open the spec editor for that card.
                                if (
                                  event.target.value === 'open'
                                  && task.spec !== null
                                  && task.spec.acceptanceCriteria.length > 0
                                ) {
                                  void write(
                                    `/api/taskboard/task/${encodeURIComponent(task.id)}`,
                                    'PATCH',
                                    { status: event.target.value, expectedRevision: task.revision },
                                  )
                                  return
                                }
                                if (event.target.value === 'open' && (task.spec === null || task.spec.acceptanceCriteria.length === 0)) {
                                  setSpecDraft({ taskId: task.id, criteria: (task.spec?.acceptanceCriteria ?? []).join('\n') })
                                  return
                                }
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
                            {/* v1.3 D3: blocked is a state the agent reports;
                                the human's exit is one explicit click. */}
                            {task.status === 'blocked' && (
                              <button
                                type="button"
                                onClick={() => { void unblock(task) }}
                                disabled={busy}
                                style={{ ...control, fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}
                                title={t('blocked.unblock')}
                              >
                                {t('blocked.unblock')}
                              </button>
                            )}
                          </>
                        )}
                        {/* v1.3 D2: edit title/body/priority/executor/deadline
                            without leaving the panel. */}
                        <button
                          type="button"
                          onClick={() => { openEdit(task) }}
                          style={{ ...control, fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}
                          title={t('edit.title')}
                        >
                          {t('edit.title')}
                        </button>
                        <button
                          type="button"
                          onClick={() => { void openActivity(task) }}
                          style={{ ...control, fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}
                          title={t('activity.title')}
                        >
                          {t('activity.title')}
                        </button>
                        {/* v1.2 C1: a done task is archive material, not board
                            clutter — archive it and it leaves the active view
                            (restoring is a governance write; see the service). */}
                        {!archivedView && task.status === 'done' && (
                          <button
                            type="button"
                            onClick={() => {
                              void write(
                                `/api/taskboard/task/${encodeURIComponent(task.id)}`,
                                'PATCH',
                                { archived: true, expectedRevision: task.revision },
                              )
                            }}
                            style={{ ...control, fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}
                            title={t('archive.done')}
                          >
                            {t('archive.done')}
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
            )}
          </>
        )
      })()}

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
            {/* v1.7 P2: the thread composer — a comment lands in the notes,
                which the next dispatch prompt quotes to the executing agent. */}
            <div style={{ display: 'flex', gap: 6, padding: 10, borderTop: '1px solid color-mix(in oklab, currentColor 12%, transparent)' }}>
              <input
                value={commentText}
                placeholder={t('comment.placeholder')}
                onChange={event => { setCommentText(event.target.value) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void sendComment()
                }}
                style={{ ...control, fontSize: 11, flex: 1 }}
              />
              <button
                type="button"
                onClick={() => { void sendComment() }}
                disabled={busy || commentText.trim() === ''}
                style={{ ...control, fontSize: 11, cursor: busy || commentText.trim() === '' ? 'default' : 'pointer' }}
              >
                {t('comment.send')}
              </button>
            </div>
          </div>
        </>
      )}

      {/* v1.4.1/1.4.2: the ONE task form — edit and create share this centered
          modal (a 160px column is no place for a form). Backdrop click or
          Escape closes; saving carries the read revision in edit mode, so a
          concurrent change is a 409, not a clobber. */}
      {formDraft !== null && (() => {
        const editingTask = formDraft.mode === 'edit'
          ? board?.tasks.find(task => task.id === formDraft.taskId)
          : undefined
        if (formDraft.mode === 'edit' && editingTask === undefined) return null
        const heading = formDraft.mode === 'edit'
          ? `${t('edit.title')} ${editingTask?.key ?? editingTask?.id.slice(0, 8)}`
          : `${t('new')} · ${t(`column.${formDraft.status ?? 'draft'}` as TaskboardKey)}`
        const meta = formDraft.mode === 'edit' && editingTask !== undefined
          ? `${projectName(editingTask.projectId)} · ${t(`column.${editingTask.status}` as TaskboardKey)}`
          : `${projectFilter !== 'all' ? projectName(projectFilter) : t('project.all')} · ${t(`column.${formDraft.status ?? 'draft'}` as TaskboardKey)}`
        return (
          <>
            <div
              onClick={() => { setFormDraft(null) }}
              style={{ position: 'absolute', inset: 0, zIndex: 30, background: 'color-mix(in oklab, currentColor 18%, transparent)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)' }}
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-label={heading}
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: 520,
                maxWidth: 'calc(100% - 32px)',
                maxHeight: '85%',
                overflowY: 'auto',
                zIndex: 31,
                background: 'color-mix(in oklab, currentColor 12%, transparent)',
                backdropFilter: 'blur(16px) saturate(1.3)',
                WebkitBackdropFilter: 'blur(16px) saturate(1.3)',
                border: '1px solid color-mix(in oklab, currentColor 18%, transparent)',
                borderRadius: 10,
                boxShadow: '0 16px 48px color-mix(in oklab, currentColor 25%, transparent)',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, borderBottom: '1px solid color-mix(in oklab, currentColor 12%, transparent)' }}>
                <strong style={{ fontSize: 13, flex: 1 }}>{heading}</strong>
                <span style={{ fontSize: 11, opacity: 0.6 }}>{meta}</span>
                <button
                  type="button"
                  onClick={() => { setFormDraft(null) }}
                  style={{ ...control, cursor: 'pointer' }}
                  title={t('cancel')}
                >
                  ×
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14 }}>
                <input
                  autoFocus
                  value={formDraft.title}
                  placeholder={t('title')}
                  onChange={event => { setFormDraft({ ...formDraft, title: event.target.value }) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setFormDraft(null)
                  }}
                  style={{ ...control, fontSize: 13 }}
                />
                <textarea
                  value={formDraft.body}
                  placeholder={t('edit.body')}
                  rows={6}
                  onChange={event => { setFormDraft({ ...formDraft, body: event.target.value }) }}
                  style={{ ...control, fontSize: 12, resize: 'vertical', fontFamily: 'inherit' }}
                />
                <div style={{ display: 'flex', gap: 10 }}>
                  <select
                    value={formDraft.priority}
                    onChange={event => { setFormDraft({ ...formDraft, priority: event.target.value }) }}
                    style={{ ...control, fontSize: 12, flex: 1, cursor: 'pointer' }}
                  >
                    {PRIORITIES.map(priority => <option key={priority} value={priority}>{priority}</option>)}
                  </select>
                  <select
                    value={formDraft.executor}
                    onChange={event => { setFormDraft({ ...formDraft, executor: event.target.value as 'agent' | 'human' | 'any' }) }}
                    style={{ ...control, fontSize: 12, flex: 1, cursor: 'pointer' }}
                  >
                    {(['agent', 'human', 'any'] as const).map(executor => (
                      <option key={executor} value={executor}>{t(`executor.${executor}` as TaskboardKey)}</option>
                    ))}
                  </select>
                </div>
                {/* v1.7 P1: owning project — editable in the form. */}
                <select
                  value={formDraft.projectId}
                  onChange={event => { setFormDraft({ ...formDraft, projectId: event.target.value }) }}
                  style={{ ...control, fontSize: 12, cursor: 'pointer' }}
                >
                  {board?.projects.map(project => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
                </select>
                <input
                  type="datetime-local"
                  value={formDraft.dueAt}
                  onChange={event => { setFormDraft({ ...formDraft, dueAt: event.target.value }) }}
                  style={{ ...control, fontSize: 12 }}
                />
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => { void saveForm(editingTask) }}
                    disabled={busy || formDraft.title.trim() === ''}
                    style={{ ...control, fontSize: 13, padding: '6px 12px', cursor: 'pointer', flex: 1 }}
                  >
                    {formDraft.mode === 'edit' ? t('edit.save') : t('create')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setFormDraft(null) }}
                    style={{ ...control, fontSize: 13, padding: '6px 12px', cursor: 'pointer' }}
                  >
                    {t('cancel')}
                  </button>
                </div>
              </div>
            </div>
          </>
        )
      })()}
    </div>
  )
}
