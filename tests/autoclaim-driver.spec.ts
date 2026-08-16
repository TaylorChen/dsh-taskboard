/**
 * The auto-claim DRIVER's integration behaviour: an `agent/status → idle`
 * event must claim the oldest open task, record the `claimed` activity, and
 * hand the task to the agent as a follow-up turn — when the quota allows.
 *
 * The driver's event wiring is exercised over a real `TaskboardService` (fake
 * store) with a fake agent/ctx, because the claim and dispatch are its load-
 * bearing effects. The headless E2E additionally proves the claim lands in a
 * real dsh boot; this test keeps the process alive long enough to assert the
 * whole chain.
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
function fakeAgent(sessionId: string, contextWindow: number | undefined) {
  const followups: unknown[] = []
  const agent = {
    id: sessionId,
    status: 'idle' as const,
    inbox: { hasPending: false },
    session: {
      requestContext: () => contextWindow === undefined
        ? undefined
        : { provider: 'deepseek', model: 'demo', contextWindow },
    },
    followup: (message: unknown): void => { followups.push(message) },
  }
  return { agent, followups }
}

/** A minimal cordis-like context with an event bus and the driver's injections. */
function fakeCtx(overrides: Record<string, unknown>) {
  const handlers = new Map<string, Array<(payload: unknown) => void>>()
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
  /** Follow-up turns the driver queued via `agent.followup`. */
  followups: unknown[]
  /** Emit an idle transition for the rig's own agent. */
  emitIdle: () => void
  settle: () => Promise<void>
}

/** Build the driver over a real service and a fake agent/ctx. */
function rig(contextWindow: number | undefined, minRemainingTokens: number): Rig {
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
  const { agent, followups } = fakeAgent('session-a', contextWindow)
  const ctx = fakeCtx({
    agents: {
      get: (id: string) => (id === agent.id ? agent : undefined),
      withoutInitiator: (operation: () => unknown) => operation(),
    },
    tokenMeter: { measure: () => ({ totalTokens: 1000 }) },
    taskboard: service,
  })
  apply(ctx as unknown as Parameters<typeof apply>[0], { minRemainingTokens })
  const actor: Actor = { kind: 'human', via: 'panel' }
  return {
    service,
    ctx,
    actor,
    followups,
    emitIdle: () => ctx.emit('agent/status', { agent, status: 'idle' }),
    settle: () => new Promise(resolve => setTimeout(resolve, 10)),
  }
}

let clock = 0
let seq = 0

describe('auto-claim driver', () => {
  it('claims the oldest open task and dispatches a follow-up turn on idle', async () => {
    const { service, actor, followups, emitIdle, settle } = rig(128_000, 5000)
    const first = await service.create({ projectId: PROJECT_ID, title: 'Oldest' }, actor)
    await service.create({ projectId: PROJECT_ID, title: 'Newer' }, actor)

    emitIdle()
    await settle()

    const claimed = service.get(first.key as string)
    expect(claimed?.status).toBe('in_progress')
    expect(claimed?.claimedBySessionId).toBe('session-a')
    const entry = service.activityOf(first.id)[0]
    expect(entry?.action).toBe('claimed')
    expect(entry?.actorLabel).toBe('session-a')

    // The driver hands the claimed task to the agent as a follow-up turn.
    expect(followups).toHaveLength(1)
    const message = followups[0] as { source: { kind: string }, content: Array<{ text: string }> }
    expect(message.source.kind).toBe('taskboard')
    expect(message.content[0]?.text).toContain('TB-1')
    expect(message.content[0]?.text).toContain('Oldest')

    // The second task stays open: one claim per idle event.
    const stillOpen = service.list({ status: 'open' })
    expect(stillOpen).toHaveLength(1)
  })

  it('does nothing when the quota is too tight', async () => {
    const { service, actor, emitIdle, settle } = rig(128_000, 1_000_000)
    await service.create({ projectId: PROJECT_ID, title: 'No budget' }, actor)

    emitIdle()
    await settle()

    expect(service.list({ status: 'open' })).toHaveLength(1)
    expect(service.activityOf('TB-1')).toHaveLength(1) // only 'created'
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
