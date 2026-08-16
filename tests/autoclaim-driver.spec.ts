/**
 * The auto-claim DRIVER's integration behaviour: an `agent/status → idle`
 * event must claim the oldest claimable open task, scope the scan to the
 * session's workspace when resolvable (W1), and hand the task to a background
 * subagent (W2) — settling the task from the subagent's outcome — falling back
 * to a follow-up turn in the claiming session when the subagent seam is absent.
 *
 * The driver's event wiring is exercised over a real `TaskboardService` (fake
 * store) with a fake agent/ctx, because the claim, dispatch, and settle are its
 * load-bearing effects.
 */

import { describe, expect, it } from 'vitest'
import { apply } from '../src/autoclaim.ts'
import { TaskboardService, type Actor, type TaskboardStore } from '../src/service.ts'
import type { Activity, Task, Project, ProjectId, TaskId } from '../src/domain.ts'

const PROJECT_ID = 'project-1'

/** In-memory store double (same shape as the service spec's). */
function fakeStore(): TaskboardStore {
  const tasks = new Map<string, Task>()
  const projects = new Map<string, Project>([[PROJECT_ID, {
    id: PROJECT_ID, name: 'Inbox', description: '', workspaceId: null,
    archived: false, createdAt: 0, updatedAt: 0,
  }]])
  const activity = new Map<string, Activity>()
  let global = { nextTaskNumber: 1 }
  return {
    listTasks: () => [...tasks.values()],
    getTask: (id: TaskId) => tasks.get(id),
    putTask: async (task: Task) => { tasks.set(task.id, task) },
    deleteTask: async (id: TaskId) => tasks.delete(id),
    listProjects: () => [...projects.values()],
    getProject: (id: ProjectId) => projects.get(id),
    putProject: async (project: Project) => { projects.set(project.id, project) },
    listActivity: (taskId: TaskId) => [...activity.values()].filter(a => a.taskId === taskId),
    putActivity: async (entry) => { activity.set(entry.id, entry) },
    deleteActivity: async (id) => activity.delete(id),
    getGlobal: () => global,
    setGlobal: async (value) => { global = value },
  }
}

/** A minimal agent double: idle, with a claimed context and a followup spy. */
function fakeAgent(sessionId: string, contextWindow: number | undefined, cwd?: string) {
  const followups: unknown[] = []
  const agent = {
    id: sessionId,
    status: 'idle' as const,
    inbox: { hasPending: false },
    session: {
      header: { cwd },
      requestContext: () => contextWindow === undefined
        ? undefined
        : { provider: 'deepseek', model: 'demo', contextWindow },
    },
    followup: (message: unknown): void => { followups.push(message) },
  }
  return { agent, followups }
}

/** A fake subagent seam: records starts and lets the test settle runs. */
function fakeSubagents() {
  const starts: Array<{ name: string, prompt: Array<{ text?: string }>, parentId: string }> = []
  const pending: Array<{
    id: string,
    resolve: (result: { stopReason: string }) => void,
    reject: (error: Error) => void,
  }> = []
  let seq = 0
  return {
    starts,
    settleNext: (stopReason: string): void => pending.shift()?.resolve({ stopReason }),
    failNext: (message: string): void => pending.shift()?.reject(new Error(message)),
    start: (name: string, request: { prompt: Array<{ text?: string }>, parent: { id: string } }) => {
      starts.push({ name, prompt: request.prompt, parentId: request.parent.id })
      return {
        id: `sub-${++seq}`,
        result: new Promise<{ stopReason: string }>((resolve, reject) => {
          pending.push({ id: `sub-${seq}`, resolve, reject })
        }),
      }
    },
  }
}

/** A minimal cordis-like context with an event bus and the driver's injections. */
function fakeCtx(overrides: Record<string, unknown>) {
  const handlers = new Map<string, Array<(payload: unknown) => void>>()
  const services = new Map<string, unknown>(Object.entries(overrides))
  return {
    on: (name: string, fn: (payload: unknown) => void): (() => void) => {
      const list = handlers.get(name) ?? []
      list.push(fn)
      handlers.set(name, list)
      return () => {
        const current = handlers.get(name) ?? []
        handlers.set(name, current.filter(candidate => candidate !== fn))
      }
    },
    emit: (name: string, payload: unknown): void => {
      for (const fn of handlers.get(name) ?? []) fn(payload)
    },
    inject: (names: string[], cb: (scoped: Record<string, unknown>) => void): void => {
      if (names.every(name => services.has(name))) {
        cb(Object.fromEntries(names.map(name => [name, services.get(name)])))
      }
    },
    effect: (fn: () => unknown): unknown => fn(),
    fiber: { state: 2 },
    logger: { warn: () => {} },
    ...overrides,
  }
}

interface Rig {
  service: TaskboardService
  ctx: ReturnType<typeof fakeCtx>
  actor: Actor
  /** Follow-up turns the driver queued via `agent.followup` (fallback path). */
  followups: unknown[]
  /** Emit an idle transition for the rig's own agent. */
  emitIdle: () => void
  settle: () => Promise<void>
}

/**
 * Build the driver over a real service and a fake agent/ctx.
 * @param contextWindow - the agent's advertised capacity; `undefined` = unknown.
 * @param minRemainingTokens - the driver's quota floor.
 * @param options.workspaceCwd - when set, the workspace resolver maps it to 'ws-a'.
 * @param options.withSubagents - mount the fake subagent seam.
 */
function rig(
  contextWindow: number | undefined,
  minRemainingTokens: number,
  options: { workspaceCwd?: string, withSubagents?: boolean } = {},
): Rig & { subagents: ReturnType<typeof fakeSubagents> } {
  const store = fakeStore()
  const service = new TaskboardService({
    store,
    approval: { request: async () => 'allowed-once' },
    writePolicy: 'auto',
    maxTasks: 100,
    keyPrefix: 'TB',
    activityRetentionPerTask: 50,
    now: () => ++clock,
    newId: () => `id-${++seq}`,
  })
  if (options.workspaceCwd !== undefined) {
    service.setWorkspaceResolver(async (cwd) => (cwd === options.workspaceCwd ? 'ws-a' : undefined))
  }
  const subagents = fakeSubagents()
  const { agent, followups } = fakeAgent('session-a', contextWindow, options.workspaceCwd)
  const ctx = fakeCtx({
    agents: {
      get: (id: string) => (id === agent.id ? agent : undefined),
      withoutInitiator: (operation: () => unknown) => operation(),
    },
    tokenMeter: { measure: () => ({ totalTokens: 1000 }) },
    taskboard: service,
    ...options.withSubagents ? { subagents } : {},
  })
  apply(ctx as unknown as Parameters<typeof apply>[0], {
    minRemainingTokens,
    subagentProvider: 'spawn',
  })
  const actor: Actor = { kind: 'human', via: 'panel' }
  return {
    service,
    ctx,
    actor,
    followups,
    subagents,
    emitIdle: () => ctx.emit('agent/status', { agent, status: 'idle' }),
    settle: () => new Promise(resolve => setTimeout(resolve, 10)),
  }
}

let clock = 0
let seq = 0

describe('auto-claim driver', () => {
  it('scopes the scan to the session\'s workspace (W1)', async () => {
    const { service, actor, emitIdle, settle } = rig(128_000, 0, { workspaceCwd: '/home/work' })
    const mine = await service.create(
      { projectId: PROJECT_ID, title: 'Mine', sessionCwd: '/home/work' }, actor)
    const unbound = await service.create({ projectId: PROJECT_ID, title: 'Global' }, actor)
    await service.create({ projectId: PROJECT_ID, title: 'Theirs' }, actor)
    // A foreign-workspace task: bind it explicitly to another workspace.
    await service.update('TB-3', { workspaceId: 'ws-b' }, actor)

    emitIdle()
    await settle()
    emitIdle()
    await settle()

    // Two idle events claim the ws-a task and the unbound task (oldest first).
    expect(service.get(mine.key as string)?.claimedBySessionId).toBe('session-a')
    expect(service.get(unbound.key as string)?.claimedBySessionId).toBe('session-a')
    // The foreign-workspace task is never claimable from this session.
    expect(service.get('TB-3')?.claimedBySessionId).toBeNull()
    expect(service.get('TB-3')?.status).toBe('open')
  })

  it('claims the oldest open task and hands it to a background subagent (W2)', async () => {
    const { service, actor, subagents, followups, emitIdle, settle } = rig(
      128_000, 5000, { withSubagents: true })
    const first = await service.create({ projectId: PROJECT_ID, title: 'Oldest' }, actor)
    await service.create({ projectId: PROJECT_ID, title: 'Newer' }, actor)

    emitIdle()
    await settle()

    const claimed = service.get(first.key as string)
    expect(claimed?.status).toBe('in_progress')
    expect(claimed?.claimedBySessionId).toBe('session-a')
    // Dispatched to a subagent, not a follow-up turn.
    expect(subagents.starts).toHaveLength(1)
    expect(subagents.starts[0]?.name).toBe('spawn')
    expect(subagents.starts[0]?.prompt[0]?.text).toContain('TB-1')
    expect(subagents.starts[0]?.prompt[0]?.text).toContain('Oldest')
    expect(subagents.starts[0]?.parentId).toBe('session-a')
    expect(service.activityOf(first.id).some(entry => entry.action === 'dispatched')).toBe(true)
    expect(followups).toHaveLength(0)
  })

  it('settles a completed dispatch to awaiting_human', async () => {
    const { service, actor, subagents, emitIdle, settle } = rig(128_000, 0, { withSubagents: true })
    const task = await service.create({ projectId: PROJECT_ID, title: 'Ship it' }, actor)

    emitIdle()
    await settle()
    subagents.settleNext('completed')
    await settle()

    const settled = service.get(task.key as string)
    expect(settled?.status).toBe('awaiting_human')
    expect(settled?.blockedReason).toBeNull()
    expect(service.activityOf(task.id).some(entry => entry.action === 'completed')).toBe(true)
  })

  it('settles a failed dispatch to blocked with a reason', async () => {
    const { service, actor, subagents, emitIdle, settle } = rig(128_000, 0, { withSubagents: true })
    const task = await service.create({ projectId: PROJECT_ID, title: 'Doomed' }, actor)

    emitIdle()
    await settle()
    subagents.settleNext('error')
    await settle()

    const settled = service.get(task.key as string)
    expect(settled?.status).toBe('blocked')
    expect(settled?.blockedReason).toContain('subagent sub-1 ended with error')
  })

  it('falls back to a follow-up turn when the subagent seam is absent', async () => {
    const { service, actor, followups, emitIdle, settle } = rig(128_000, 5000)
    const first = await service.create({ projectId: PROJECT_ID, title: 'Oldest' }, actor)

    emitIdle()
    await settle()

    expect(service.get(first.key as string)?.claimedBySessionId).toBe('session-a')
    expect(followups).toHaveLength(1)
    const message = followups[0] as { source: { kind: string }, content: Array<{ text: string }> }
    expect(message.source.kind).toBe('taskboard')
    expect(message.content[0]?.text).toContain('TB-1')
  })

  it('does nothing when the quota is too tight', async () => {
    const { service, actor, emitIdle, settle } = rig(128_000, 1_000_000)
    await service.create({ projectId: PROJECT_ID, title: 'No budget' }, actor)

    emitIdle()
    await settle()

    expect(service.list({ status: 'open' })).toHaveLength(1)
  })

  it('does nothing when the capacity is unknown', async () => {
    const { service, actor, emitIdle, settle } = rig(undefined, 0)
    await service.create({ projectId: PROJECT_ID, title: 'No capacity info' }, actor)

    emitIdle()
    await settle()

    expect(service.get('TB-1')?.claimedBySessionId).toBeNull()
  })

  it('does not double-claim on a second idle event', async () => {
    const { service, actor, emitIdle, settle } = rig(128_000, 0)
    const task = await service.create({ projectId: PROJECT_ID, title: 'Once' }, actor)

    emitIdle()
    await settle()
    emitIdle()
    await settle()

    expect(service.get(task.key as string)?.claimedBySessionId).toBe('session-a')
    expect(service.get(task.key as string)?.revision).toBe(1)
  })
})
