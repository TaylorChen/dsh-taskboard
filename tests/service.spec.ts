/**
 * Behaviour of the write gate, the optimistic-concurrency guard, the v0.2
 * status machine, short-id allocation, and the activity stream — over an
 * in-memory store. These are the contracts a consumer relies on, so they are
 * tested against the service rather than through the tools; the legacy-status
 * alias lives in the zod schema and is tested at the schema boundary.
 */

import { describe, expect, it } from 'vitest'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  taskSchema, type Activity, type Project, type ProjectId, type Task, type TaskId,
} from '../src/domain.ts'
import { TaskboardError } from '../src/errors.ts'
import { TaskboardService, type Actor, type ApprovalLike, type TaskboardStore } from '../src/service.ts'
import type { WritePolicy } from '../src/defaults.ts'

const PROJECT_ID = 'project-1'

/** In-memory provider double; mirrors the real store's sync-read/async-write split. */
function fakeStore(): TaskboardStore & { tasks: Map<string, Task> } {
  const tasks = new Map<string, Task>()
  const activity = new Map<string, Activity>()
  const projects = new Map<string, Project>([[PROJECT_ID, {
    id: PROJECT_ID,
    name: 'Inbox',
    description: '',
    workspaceId: null,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  }]])
  let global = { nextTaskNumber: 1 }
  return {
    tasks,
    listTasks: () => [...tasks.values()],
    getTask: (id: TaskId) => tasks.get(id),
    putTask: async (task: Task) => { tasks.set(task.id, task) },
    deleteTask: async (id: TaskId) => tasks.delete(id),
    listProjects: () => [...projects.values()],
    getProject: (id: ProjectId) => projects.get(id),
    putProject: async (project: Project) => { projects.set(project.id, project) },
    deleteProject: async (id: ProjectId) => projects.delete(id),
    listActivity: (taskId: TaskId) => [...activity.values()].filter(entry => entry.taskId === taskId),
    putActivity: async (entry: Activity) => { activity.set(entry.id, entry) },
    deleteActivity: async (id: string) => activity.delete(id as TaskId),
    getGlobal: () => global,
    setGlobal: async (value) => { global = value },
  }
}

/** Approval double recording every ask. */
function fakeApproval(outcome: ApprovalOutcome | Error): ApprovalLike & { asks: string[] } {
  const asks: string[] = []
  return {
    asks,
    request: async (req) => {
      asks.push(req.reason ?? '')
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  }
}

/** Build a service with a controllable clock and id source. */
function build(
  policy: WritePolicy,
  outcome: ApprovalOutcome | Error = 'allowed-once',
  overrides: Partial<ConstructorParameters<typeof TaskboardService>[0]> = {},
) {
  const store = fakeStore()
  const approval = fakeApproval(outcome)
  let clock = 1000
  let seq = 0
  const service = new TaskboardService({
    store,
    approval,
    writePolicy: policy,
    maxTasks: 3,
    keyPrefix: 'TB',
    activityRetentionPerTask: 50,
    now: () => ++clock,
    newId: () => `task-${++seq}`,
    ...overrides,
  })
  // The gate only needs an object identity for routing; the double never reads it.
  const actor: Actor = { kind: 'agent', agent: {} as never }
  const human: Actor = { kind: 'human', via: 'panel' }
  return { service, store, approval, actor, human }
}

describe('write gate', () => {
  it('asks once per write and stores after approval', async () => {
    const { service, store, approval, actor } = build('ask')
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Ship it' }, actor)

    expect(approval.asks).toHaveLength(1)
    expect(approval.asks[0]).toContain('[dsh-taskboard] create')
    expect(approval.asks[0]).toContain('Ship it')
    expect(store.tasks.get(task.id)?.title).toBe('Ship it')
  })

  it('stores nothing when the human rejects', async () => {
    const { service, store, actor } = build('ask', 'rejected')
    await expect(service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Nope' }, actor))
      .rejects.toThrow(TaskboardError)
    expect(store.tasks.size).toBe(0)
  })

  it("refuses rather than auto-allowing when approval is unavailable", async () => {
    const { service, store, actor } = build('ask', new Error('no open turn'))
    await expect(service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Between turns' }, actor))
      .rejects.toMatchObject({ code: 'write-denied' })
    expect(store.tasks.size).toBe(0)
  })

  it("refuses an 'ask' write with no agent to ask through", async () => {
    const { service } = build('ask')
    await expect(service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Headless' }, { kind: 'agent' }))
      .rejects.toMatchObject({ code: 'write-denied' })
  })

  it("writes without asking under 'auto'", async () => {
    const { service, approval, actor } = build('auto')
    await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Unattended' }, actor)
    expect(approval.asks).toHaveLength(0)
  })

  it("refuses every write under 'off'", async () => {
    const { service, actor } = build('off')
    await expect(service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Read only' }, actor))
      .rejects.toMatchObject({ code: 'write-denied' })
  })

  it('lets a human write without asking anyone', async () => {
    const { service, store, approval, human } = build('ask')
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Typed by hand' }, human)

    // The human IS the authority: asking them to approve their own click is
    // ceremony, so the approval seam is never consulted.
    expect(approval.asks).toHaveLength(0)
    expect(store.tasks.get(task.id)?.title).toBe('Typed by hand')
    expect(task.origin).toBe('human')
  })

  it("still refuses a human write under 'off'", async () => {
    const { service, human } = build('off')
    await expect(service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Read only' }, human))
      .rejects.toMatchObject({ code: 'write-denied' })
  })

  it('records who created each task', async () => {
    const { service, actor, human } = build('auto')
    const byAgent = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'A' }, actor)
    const byHuman = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'B' }, human)
    expect(byAgent.origin).toBe('agent')
    expect(byHuman.origin).toBe('human')
  })

  it('quotes the complete before/after into an update approval', async () => {
    const { service, approval, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Old title' }, actor)

    const asking = build('ask')
    await asking.store.putTask(task)
    await asking.service.update(task.id as TaskId, { title: 'New title' }, asking.actor)

    expect(asking.approval.asks[0]).toContain('from:')
    expect(asking.approval.asks[0]).toContain('Old title')
    expect(asking.approval.asks[0]).toContain('to:')
    expect(asking.approval.asks[0]).toContain('New title')
  })
})

describe('optimistic concurrency', () => {
  it('bumps revision on every update', async () => {
    const { service, actor } = build('auto')
    const created = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'A' }, actor)
    expect(created.revision).toBe(0)

    const updated = await service.update(created.id as TaskId, { status: 'in_progress' }, actor)
    expect(updated.revision).toBe(1)
  })

  it('refuses a stale expectedRevision', async () => {
    const { service, actor } = build('auto')
    const created = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'A' }, actor)
    await service.update(created.id as TaskId, { status: 'in_progress' }, actor)

    await expect(service.update(created.id as TaskId, { status: 'done', expectedRevision: 0 }, actor))
      .rejects.toMatchObject({ code: 'revision-conflict' })
  })
})

describe('limits and lookup', () => {
  it('refuses a create past maxTasks', async () => {
    const { service, actor } = build('auto')
    for (const title of ['a', 'b', 'c']) {
      await service.create({ projectId: PROJECT_ID, title }, actor)
    }
    await expect(service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'd' }, actor))
      .rejects.toMatchObject({ code: 'limit-exceeded' })
  })

  it('refuses a task in a project that does not exist', async () => {
    const { service, actor } = build('auto')
    await expect(service.create({ projectId: 'ghost', title: 'x' }, actor))
      .rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('status machine', () => {
  it('creates into draft by default without acceptance criteria (v0.5)', async () => {
    const { service, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, title: 'Ready' }, actor)
    expect(task.status).toBe('draft')
    expect(task.spec).toBeNull()
  })

  it('creates into open when the spec is complete', async () => {
    const { service, actor } = build('auto')
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Ready', acceptanceCriteria: ['works'] }, actor)
    expect(task.status).toBe('open')
    expect(task.spec?.acceptanceCriteria).toEqual(['works'])
  })

  it('creates into a requested column', async () => {
    const { service, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Drafting', status: 'draft' }, actor)
    expect(task.status).toBe('draft')
  })

  it('refuses to move into blocked without a reason', async () => {
    const { service, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'A' }, actor)
    await expect(service.update(task.id as TaskId, { status: 'blocked' }, actor))
      .rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('refuses to create a task already blocked without a reason', async () => {
    const { service, actor } = build('auto')
    await expect(service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'X', status: 'blocked' }, actor))
      .rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('blocks with a reason and clears it on leaving', async () => {
    const { service, actor } = build('auto')
    const created = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'A' }, actor)

    const blocked = await service.block(created.key as string, 'missing API key', actor)
    expect(blocked.status).toBe('blocked')
    expect(blocked.blockedReason).toBe('missing API key')

    const unblocked = await service.update(blocked.key as string, { status: 'in_progress' }, actor)
    expect(unblocked.status).toBe('in_progress')
    expect(unblocked.blockedReason).toBeNull()
  })

  it('rejects an empty block reason', async () => {
    const { service, actor } = build('auto')
    const created = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'A' }, actor)
    await expect(service.block(created.key as string, '  ', actor))
      .rejects.toMatchObject({ code: 'invalid-input' })
  })
})

describe('short ids', () => {
  it('assigns TB-1, TB-2, … in create order', async () => {
    const { service, actor } = build('auto')
    const first = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'A' }, actor)
    const second = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'B' }, actor)
    expect(first.key).toBe('TB-1')
    expect(second.key).toBe('TB-2')
  })

  it('never reuses a number after deletion', async () => {
    const { service, actor } = build('auto')
    const first = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'A' }, actor)
    await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'B' }, actor)
    await service.remove(first.key as string, actor)
    const third = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'C' }, actor)
    expect(third.key).toBe('TB-3')
  })

  it('allocates distinct keys under parallel creates', async () => {
    const { service, actor } = build('auto')
    const tasks = await Promise.all([
      service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'A' }, actor),
      service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'B' }, actor),
      service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'C' }, actor),
    ])
    const keys = tasks.map(task => task.key).sort()
    expect(keys).toEqual(['TB-1', 'TB-2', 'TB-3'])
  })

  it('resolves a task by key or by id alike', async () => {
    const { service, actor } = build('auto')
    const created = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'A' }, actor)
    await service.update(created.id as TaskId, { status: 'in_progress' }, actor)

    const byKey = service.get(created.key as string)
    const byId = service.get(created.id)
    expect(byKey?.title).toBe('A')
    expect(byId?.title).toBe('A')
    expect(service.get('TB-99')).toBeUndefined()
    expect(service.get('no-such-id')).toBeUndefined()
  })

  it('reports a missing task through either reference form', async () => {
    const { service, actor } = build('auto')
    await expect(service.update('TB-42', { status: 'done' }, actor))
      .rejects.toMatchObject({ code: 'not-found' })
  })

  it('backfills keys for keyless records in createdAt order, once', async () => {
    const { service, store } = build('auto', 'allowed-once', { maxTasks: 10 })
    const at = 1000
    for (const [title, createdAt] of [['Old', at], ['Middle', at + 10], ['New', at + 20]] as const) {
      await store.putTask({
        id: `legacy-${createdAt}`,
        projectId: PROJECT_ID,
        title,
        body: '',
        status: 'open',
        priority: 'normal',
        labels: [],
        workspaceId: null,
        claimedBySessionId: null,
        origin: 'agent',
        blockedReason: null,
        spec: null,
        evidence: null,
        dependsOn: [],
        budgetTokens: null,
        executor: 'any',
        dueAt: null,
        notes: '',
        archivedAt: null,
        contextBudgetTokens: null,
      sortOrder: null,
      tokensUsed: null,
      nextTask: null,
        revision: 0,
        createdAt,
        updatedAt: createdAt,
      })
    }
    expect(await service.backfillKeys()).toBe(3)
    const tasks = service.list()
    expect(tasks.find(task => task.title === 'Old')?.key).toBe('TB-1')
    expect(tasks.find(task => task.title === 'Middle')?.key).toBe('TB-2')
    expect(tasks.find(task => task.title === 'New')?.key).toBe('TB-3')
    // Idempotent: a second mount writes nothing.
    expect(await service.backfillKeys()).toBe(0)
    // The counter moved past the backfilled keys.
    const fresh = await service.create(
      { projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Fresh' },
      { kind: 'human', via: 'panel' },
    )
    expect(fresh.key).toBe('TB-4')
  })
})

describe('legacy status alias', () => {
  it('maps stored todo -> open and in_review -> awaiting_human at the schema boundary', () => {
    const base = {
      id: 't1',
      projectId: PROJECT_ID,
      title: 'Legacy',
      body: '',
      priority: 'normal',
      labels: [],
      workspaceId: null,
      claimedBySessionId: null,
      revision: 0,
      createdAt: 0,
      updatedAt: 0,
    } as const
    const todo = taskSchema.parse({ ...base, status: 'todo' })
    const inReview = taskSchema.parse({ ...base, id: 't2', status: 'in_review' })
    expect(todo.status).toBe('open')
    expect(inReview.status).toBe('awaiting_human')
    // The alias does not touch valid new values.
    expect(taskSchema.parse({ ...base, id: 't3', status: 'draft' }).status).toBe('draft')
    // v0.1 records lack origin / key / blockedReason and still parse.
    expect(todo.origin).toBe('agent')
    expect(todo.key).toBeUndefined()
    expect(todo.blockedReason).toBeNull()
  })

  it('rejects an unknown status', () => {
    expect(() => taskSchema.parse({
      id: 't1',
      projectId: PROJECT_ID,
      title: 'X',
      body: '',
      status: 'in_reviewx',
      priority: 'normal',
      labels: [],
      workspaceId: null,
      claimedBySessionId: null,
      revision: 0,
      createdAt: 0,
      updatedAt: 0,
    })).toThrow()
  })
})

describe('activity stream', () => {
  it('records created, status, blocked, claimed, edited and removed', async () => {
    const { service, actor } = build('auto')
    const created = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'A' }, actor)
    const updated = await service.update(created.key as string, { status: 'in_progress' }, actor)
    const blocked = await service.block(created.key as string, 'stuck', actor)
    const unblocked = await service.update(created.key as string, { status: 'open' }, actor)
    await service.update(created.key as string, { claimedBySessionId: 'session-1' }, actor)
    await service.update(created.key as string, { title: 'A2' }, actor)
    await service.remove(created.key as string, actor)

    // The card is gone; the audit trail survives, keyed by the task id.
    // The stream is newest first (the panel's presentation order).
    const actions = service.activityOf(created.id).map(entry => entry.action)
    expect(actions).toEqual(['removed', 'edited', 'claimed', 'status', 'blocked', 'status', 'created'])
    expect(updated.status).toBe('in_progress')
    expect(blocked.status).toBe('blocked')
    expect(unblocked.status).toBe('open')
  })

  it('records human and agent actors in the same format', async () => {
    const { service, actor, human } = build('auto')
    const byAgent = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'A' }, actor)
    const byHuman = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'B' }, human)

    const agentEntry = service.activityOf(byAgent.key as string)[0]!
    const humanEntry = service.activityOf(byHuman.key as string)[0]!
    expect(agentEntry.actor).toBe('agent')
    expect(humanEntry.actor).toBe('human')
    expect(humanEntry.actorLabel).toBe('panel')
    // Both carry the same field shape.
    expect(Object.keys(agentEntry).sort()).toEqual(Object.keys(humanEntry).sort())
  })

  it('records nothing when a write is refused', async () => {
    const { service, store, actor } = build('ask', 'rejected')
    await expect(service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Nope' }, actor))
      .rejects.toThrow(TaskboardError)
    expect(store.tasks.size).toBe(0)
    expect(store.listActivity('any' as TaskId)).toHaveLength(0)
  })

  it('trims the oldest entries past the per-task retention', async () => {
    const { service, actor } = build('auto', 'allowed-once', { activityRetentionPerTask: 3 })
    const created = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'A' }, actor)
    for (const status of ['in_progress', 'open', 'in_progress', 'open'] as const) {
      await service.update(created.key as string, { status }, actor)
    }
    const stream = service.activityOf(created.key as string)
    // 1 create + 4 updates, retained at 3: the two oldest are gone, newest first.
    expect(stream).toHaveLength(3)
    expect(stream[0]?.action).toBe('status')
    expect(stream[2]?.action).toBe('status')
  })
})

describe('auto-claim', () => {
  it('claims an open task for the session and records the activity', async () => {
    const { service, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Pick me' }, actor)

    const claimed = await service.autoClaim(task.key as string, 'session-auto')

    expect(claimed?.status).toBe('in_progress')
    expect(claimed?.claimedBySessionId).toBe('session-auto')
    expect(claimed?.revision).toBe(1)
    const entry = service.activityOf(task.id)[0]!
    expect(entry.action).toBe('claimed')
    expect(entry.actor).toBe('agent')
    expect(entry.actorLabel).toBe('session-auto')
    expect(entry.from).toBeNull()
    expect(entry.to).toBe('session-auto')
  })

  it('returns null for an already-claimed task', async () => {
    const { service, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Taken' }, actor)
    await service.autoClaim(task.key as string, 'session-a')

    await expect(service.autoClaim(task.key as string, 'session-b')).resolves.toBeNull()
    expect(service.get(task.key as string)?.claimedBySessionId).toBe('session-a')
  })

  it('returns null for a task that is not open', async () => {
    const { service, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Drafting', status: 'draft' }, actor)
    await expect(service.autoClaim(task.key as string, 'session-a')).resolves.toBeNull()
  })

  it('returns null for a missing task', async () => {
    const { service } = build('auto')
    await expect(service.autoClaim('TB-99', 'session-a')).resolves.toBeNull()
  })

  it('lets only one of two parallel claims win', async () => {
    const { service, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Contested' }, actor)
    const [first, second] = await Promise.all([
      service.autoClaim(task.key as string, 'session-a'),
      service.autoClaim(task.key as string, 'session-b'),
    ])
    expect([first, second].filter(claimed => claimed !== null)).toHaveLength(1)
    const winner = first ?? second
    expect(winner?.claimedBySessionId).toBe(
      service.get(task.key as string)?.claimedBySessionId,
    )
  })

  it("refuses under writePolicy 'off'", async () => {
    const { service, store } = build('off')
    // `create` itself is refused under 'off', so seed the task through the store.
    await store.putTask({
      id: 't-off',
      key: 'TB-1',
      projectId: PROJECT_ID,
      title: 'Read only',
      body: '',
      status: 'open',
      priority: 'normal',
      labels: [],
      workspaceId: null,
      claimedBySessionId: null,
      origin: 'human',
      blockedReason: null,
      spec: null,
      evidence: null,
      dependsOn: [],
      budgetTokens: null,
      executor: 'any',
      dueAt: null,
      notes: '',
      archivedAt: null,
      contextBudgetTokens: null,
      sortOrder: null,
      tokensUsed: null,
      nextTask: null,
      revision: 0,
      createdAt: 0,
      updatedAt: 0,
    })
    await expect(service.autoClaim('TB-1', 'session-a'))
      .rejects.toMatchObject({ code: 'write-denied' })
    expect(service.get('TB-1')?.claimedBySessionId).toBeNull()
  })
})

describe('workspace binding (v0.4 W1)', () => {
  it('binds a created task to the workspace owning the session cwd', async () => {
    const { service, actor } = build('auto')
    service.setWorkspaceResolver(async (cwd) => (cwd === '/home/work' ? 'ws-a' : undefined))
    const task = await service.create(
      { projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Bound', sessionCwd: '/home/work' }, actor)
    expect(task.workspaceId).toBe('ws-a')
  })

  it('keeps an unowned or absent cwd board-global', async () => {
    const { service, actor } = build('auto')
    service.setWorkspaceResolver(async () => undefined)
    const unowned = await service.create(
      { projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Unowned', sessionCwd: '/elsewhere' }, actor)
    expect(unowned.workspaceId).toBeNull()
  })

  it('does not bind without the workspace seam', async () => {
    const { service, actor } = build('auto')
    const task = await service.create(
      { projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'No seam', sessionCwd: '/home/work' }, actor)
    expect(task.workspaceId).toBeNull()
  })

  it('binds an unbound task on claim (update with sessionCwd)', async () => {
    const { service, actor } = build('auto')
    service.setWorkspaceResolver(async (cwd) => (cwd === '/home/work' ? 'ws-a' : undefined))
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Claim me' }, actor)
    expect(task.workspaceId).toBeNull()

    const claimed = await service.update(task.key as string, {
      status: 'in_progress',
      claimedBySessionId: 'session-1',
      sessionCwd: '/home/work',
    }, actor)
    expect(claimed.workspaceId).toBe('ws-a')
    // An already-bound task is never rebound.
    const again = await service.update(task.key as string, { title: 'X', sessionCwd: '/other' }, actor)
    expect(again.workspaceId).toBe('ws-a')
  })

  it('binds an unbound task on auto-claim', async () => {
    const { service, actor } = build('auto')
    service.setWorkspaceResolver(async (cwd) => (cwd === '/home/work' ? 'ws-a' : undefined))
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Auto' }, actor)
    const claimed = await service.autoClaim(task.key as string, 'session-a', '/home/work')
    expect(claimed?.workspaceId).toBe('ws-a')
  })

  it('exposes the cwd -> workspace resolution to the driver', async () => {
    const { service } = build('auto')
    service.setWorkspaceResolver(async (cwd) => (cwd === '/w' ? 'ws-1' : undefined))
    await expect(service.workspaceIdOfCwd('/w')).resolves.toBe('ws-1')
    await expect(service.workspaceIdOfCwd(undefined)).resolves.toBeUndefined()
    await expect(service.workspaceIdOfCwd('/nowhere')).resolves.toBeUndefined()
  })
})

describe('subagent dispatch (v0.4 W2)', () => {
  it('records a dispatch and settles completed to awaiting_human', async () => {
    const { service, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Shipped' }, actor)
    await service.autoClaim(task.key as string, 'session-a')

    const dispatched = await service.recordDispatched(task.key as string, 'session-a', 'sub-1')
    expect(dispatched?.status).toBe('in_progress')
    expect(service.activityOf(task.id).some(entry => entry.action === 'dispatched')).toBe(true)

    const settled = await service.settleDispatch(task.key as string, 'session-a', { kind: 'completed', evidence: { criteria: [{ criterion: 'works', met: true, note: 'seen' }], artifacts: ['out.txt'], summary: 'done' } })
    expect(settled?.status).toBe('awaiting_human')
    expect(settled?.blockedReason).toBeNull()
    expect(service.activityOf(task.id).some(entry => entry.action === 'completed')).toBe(true)
  })

  it('settles an error to blocked with the reason', async () => {
    const { service, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Failed' }, actor)
    await service.autoClaim(task.key as string, 'session-a')

    const settled = await service.settleDispatch(task.key as string, 'session-a', {
      kind: 'error',
      reason: 'subagent exploded',
      diagnosis: 'stuck on step 3',
    })
    expect(settled?.status).toBe('blocked')
    expect(settled?.blockedReason).toBe('subagent exploded')
  })

  it('refuses to settle a task the human moved meanwhile', async () => {
    const { service, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Touched' }, actor)
    await service.autoClaim(task.key as string, 'session-a')
    await service.update(task.key as string, { status: 'done' }, actor)

    await expect(service.settleDispatch(task.key as string, 'session-a', { kind: 'completed', evidence: { criteria: [], artifacts: [], summary: '' } }))
      .resolves.toBeNull()
    expect(service.get(task.key as string)?.status).toBe('done')
  })

  it('refuses a dispatch or settle from a different session', async () => {
    const { service, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Mine' }, actor)
    await service.autoClaim(task.key as string, 'session-a')

    await expect(service.recordDispatched(task.key as string, 'session-b', 'sub-9')).resolves.toBeNull()
    await expect(service.settleDispatch(task.key as string, 'session-b', {
      kind: 'completed',
      evidence: { criteria: [], artifacts: [], summary: '' },
    })).resolves.toBeNull()
    expect(service.get(task.key as string)?.status).toBe('in_progress')
  })
})

describe('task spec (v0.5 L2)', () => {
  it('downgrades a no-spec create requesting open to draft', async () => {
    const { service, actor } = build('auto')
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'No spec', status: 'open' }, actor)
    expect(task.status).toBe('draft')
  })

  it('refuses moving into open without acceptance criteria', async () => {
    const { service, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, title: 'Drafting' }, actor)
    await expect(service.update(task.key as string, { status: 'open' }, actor))
      .rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('allows draft -> open once criteria are supplied', async () => {
    const { service, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, title: 'Drafting' }, actor)
    const opened = await service.update(task.key as string, {
      status: 'open',
      spec: { acceptanceCriteria: ['compiles', 'tests pass'] },
    }, actor)
    expect(opened.status).toBe('open')
    expect(opened.spec?.acceptanceCriteria).toEqual(['compiles', 'tests pass'])
  })

  it('does not re-gate a pre-v0.5 open task without a spec', async () => {
    const { service, store, actor } = build('auto')
    await store.putTask({
      id: 'legacy-open',
      key: 'TB-1',
      projectId: PROJECT_ID,
      title: 'Legacy open',
      body: '',
      status: 'open',
      priority: 'normal',
      labels: [],
      workspaceId: null,
      claimedBySessionId: null,
      origin: 'agent',
      blockedReason: null,
      spec: null,
      evidence: null,
      dependsOn: [],
      budgetTokens: null,
      executor: 'any',
      dueAt: null,
      notes: '',
      archivedAt: null,
      contextBudgetTokens: null,
      sortOrder: null,
      tokensUsed: null,
      nextTask: null,
      revision: 0,
      createdAt: 0,
      updatedAt: 0,
    })
    const updated = await service.update('TB-1', { title: 'Touched' }, actor)
    expect(updated.status).toBe('open')
  })

  it('merges a partial spec update without dropping existing fields', async () => {
    const { service, actor } = build('auto')
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Spec', acceptanceCriteria: ['a'] }, actor)
    const withRefs = await service.update(task.key as string, {
      spec: { contextRefs: ['src/foo.ts'] },
    }, actor)
    expect(withRefs.spec?.acceptanceCriteria).toEqual(['a'])
    expect(withRefs.spec?.contextRefs).toEqual(['src/foo.ts'])
    expect(withRefs.spec?.definitionOfDone).toBe('')
  })

  it('creates a spec block from a partial update on a spec-less task', async () => {
    const { service, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, title: 'Empty' }, actor)
    const updated = await service.update(task.key as string, {
      spec: { definitionOfDone: 'ship it' },
    }, actor)
    expect(updated.spec?.definitionOfDone).toBe('ship it')
    expect(updated.spec?.acceptanceCriteria).toEqual([])
    expect(updated.spec?.contextRefs).toEqual([])
  })

  it('keeps old records readable with spec null (schema boundary)', () => {
    const parsed = taskSchema.parse({
      id: 't1',
      projectId: PROJECT_ID,
      title: 'Legacy',
      body: '',
      status: 'open',
      priority: 'normal',
      labels: [],
      workspaceId: null,
      claimedBySessionId: null,
      origin: 'agent',
      revision: 0,
      createdAt: 0,
      updatedAt: 0,
    })
    expect(parsed.spec).toBeNull()
  })
})

describe('evidence (v0.6 L3)', () => {
  it('stores evidence on a completed settlement and reads it back', async () => {
    const { service, actor } = build('auto')
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'E', acceptanceCriteria: ['works'] }, actor)
    await service.autoClaim(task.key as string, 'session-a')
    expect(service.evidenceOf(task.key as string)).toBeNull()

    await service.settleDispatch(task.key as string, 'session-a', {
      kind: 'completed',
      evidence: {
        criteria: [{ criterion: 'works', met: true, note: 'verified by test' }],
        artifacts: ['out.txt'],
        summary: 'all green',
      },
    })
    expect(service.evidenceOf(task.key as string)?.criteria[0]?.met).toBe(true)
    expect(service.evidenceOf(task.key as string)?.artifacts).toEqual(['out.txt'])
    expect(service.get(task.key as string)?.status).toBe('awaiting_human')
  })

  it('stores the diagnosis in evidence on an error settlement', async () => {
    const { service, actor } = build('auto')
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'F', acceptanceCriteria: ['works'] }, actor)
    await service.autoClaim(task.key as string, 'session-a')
    await service.settleDispatch(task.key as string, 'session-a', {
      kind: 'error',
      reason: 'subagent failed',
      diagnosis: 'stuck at step 3',
    })
    const settled = service.get(task.key as string)
    expect(settled?.status).toBe('blocked')
    expect(settled?.blockedReason).toBe('subagent failed')
    expect(settled?.evidence?.summary).toBe('stuck at step 3')
  })
})

describe('dependencies and scheduling (v0.7 L4)', () => {
  it('stores dependencies and reports readiness', async () => {
    const { service, actor } = build('auto')
    const dep = await service.create(
      { projectId: PROJECT_ID, title: 'Dep', acceptanceCriteria: ['d'] }, actor)
    const task = await service.create({
      projectId: PROJECT_ID,
      title: 'Worker',
      acceptanceCriteria: ['w'],
      dependsOn: [dep.key as string],
    }, actor)

    expect(task.dependsOn).toEqual([dep.id])
    // Dep is still open: not ready.
    expect(service.isReady(task.key as string)).toBe(false)
    await service.update(dep.key as string, { status: 'done' }, actor)
    expect(service.isReady(task.key as string)).toBe(true)
  })

  it('treats a cancelled dependency as satisfied and a missing one as not ready', async () => {
    const { service, actor } = build('auto')
    const cancelled = await service.create(
      { projectId: PROJECT_ID, title: 'Cancelled', acceptanceCriteria: ['c'] }, actor)
    const withMissing = await service.create({
      projectId: PROJECT_ID,
      title: 'Partial',
      acceptanceCriteria: ['p'],
      dependsOn: [cancelled.key as string, 'ghost-task-id'],
    }, actor)
    // The unresolvable reference is kept: a missing dependency blocks
    // readiness until a human clears it.
    expect(withMissing.dependsOn).toEqual([cancelled.id, 'ghost-task-id'])

    await service.update(cancelled.key as string, { status: 'cancelled' }, actor)
    // Missing dependency keeps it not ready even though the real one is done.
    expect(service.isReady(withMissing.key as string)).toBe(false)
    await service.update(withMissing.key as string, { dependsOn: [cancelled.key as string] }, actor)
    expect(service.isReady(withMissing.key as string)).toBe(true)
  })

  it('rejects a dependency on itself and a two-task cycle', async () => {
    const { service, actor } = build('auto')
    const a = await service.create(
      { projectId: PROJECT_ID, title: 'A', acceptanceCriteria: ['a'] }, actor)
    await expect(service.update(a.key as string, { dependsOn: [a.key as string] }, actor))
      .rejects.toMatchObject({ code: 'invalid-input' })

    const b = await service.create(
      { projectId: PROJECT_ID, title: 'B', acceptanceCriteria: ['b'] }, actor)
    await service.update(a.key as string, { dependsOn: [b.key as string] }, actor)
    await expect(service.update(b.key as string, { dependsOn: [a.key as string] }, actor))
      .rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('stores the output-token budget and clears it with null', async () => {
    const { service, actor } = build('auto')
    const task = await service.create({
      projectId: PROJECT_ID,
      title: 'Budgeted',
      acceptanceCriteria: ['b'],
      budgetTokens: 500,
    }, actor)
    expect(task.budgetTokens).toBe(500)
    const cleared = await service.update(task.key as string, { budgetTokens: null }, actor)
    expect(cleared.budgetTokens).toBeNull()
  })
})

describe('experience cards (v0.8 L5)', () => {
  it('returns done tasks with evidence summaries, newest first', async () => {
    const { service, actor } = build('auto')
    const old = await service.create(
      { projectId: PROJECT_ID, title: 'Old', acceptanceCriteria: ['a'] }, actor)
    await service.autoClaim(old.key as string, 'session-a')
    await service.settleDispatch(old.key as string, 'session-a', {
      kind: 'completed',
      evidence: { criteria: [{ criterion: 'a', met: true, note: '' }], artifacts: [], summary: 'old done' },
    })
    // Confirm to done.
    await service.update(old.key as string, { status: 'done' }, actor)

    const fresh = await service.create(
      { projectId: PROJECT_ID, title: 'Fresh', acceptanceCriteria: ['b'] }, actor)
    await service.autoClaim(fresh.key as string, 'session-a')
    await service.settleDispatch(fresh.key as string, 'session-a', {
      kind: 'completed',
      evidence: { criteria: [{ criterion: 'b', met: true, note: '' }], artifacts: ['x.txt'], summary: 'fresh done' },
    })
    await service.update(fresh.key as string, { status: 'done' }, actor)

    const cards = service.relatedExperience({ projectId: PROJECT_ID })
    expect(cards.map(card => card.key)).toEqual([fresh.key, old.key])
    expect(cards[0]?.summary).toBe('fresh done')
    expect(cards[0]?.artifacts).toEqual(['x.txt'])
  })

  it('excludes done tasks without a summary', async () => {
    const { service, actor } = build('auto')
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Silent', acceptanceCriteria: ['a'] }, actor)
    await service.update(task.key as string, { status: 'done' }, actor)
    expect(service.relatedExperience()).toHaveLength(0)
  })
})

describe('executor, dueAt, notes (v0.9)', () => {
  it('defaults executor to any and stores explicit values', async () => {
    const { service, actor } = build('auto')
    const plain = await service.create(
      { projectId: PROJECT_ID, title: 'Plain', acceptanceCriteria: ['p'] }, actor)
    expect(plain.executor).toBe('any')
    const human = await service.create(
      { projectId: PROJECT_ID, title: 'For human', acceptanceCriteria: ['h'], executor: 'human' }, actor)
    expect(human.executor).toBe('human')
    const agent = await service.update(human.key as string, { executor: 'agent' }, actor)
    expect(agent.executor).toBe('agent')
  })

  it('appends notes without overwriting and records a noted activity', async () => {
    const { service, actor } = build('auto')
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Noted', acceptanceCriteria: ['n'], notes: 'first' }, actor)
    expect(task.notes).toBe('first')

    const second = await service.update(task.key as string, { note: 'second' }, actor)
    expect(second.notes).toBe('first\nsecond')
    expect(service.activityOf(task.id).some(entry => entry.action === 'noted')).toBe(true)

    const third = await service.update(task.key as string, { note: 'third' }, actor)
    expect(third.notes).toBe('first\nsecond\nthird')
  })

  it('stores the deadline and clears it with null', async () => {
    const { service, actor } = build('auto')
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Dated', acceptanceCriteria: ['d'], dueAt: 1_000_000 }, actor)
    expect(task.dueAt).toBe(1_000_000)
    const cleared = await service.update(task.key as string, { dueAt: null }, actor)
    expect(cleared.dueAt).toBeNull()
  })
})

describe('execution visibility (v1.1 A2)', () => {
  it('exposes live executions injected by the driver', async () => {
    const { service, actor } = build('auto')
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Runs', acceptanceCriteria: ['w'] }, actor)
    expect(service.executionOf(task.key as string)).toBeUndefined()
    expect(service.executions()).toEqual({})

    service.setExecutionTracker({ executionOf: (id) => (id === task.id
      ? { subagentId: 'sub-9', startedAt: 1234 }
      : undefined) })
    expect(service.executionOf(task.key as string)).toEqual({ subagentId: 'sub-9', startedAt: 1234 })
    expect(service.executions()[task.id]).toEqual({ subagentId: 'sub-9', startedAt: 1234 })
  })
})

describe('archive (v1.2 C1)', () => {
  it('hides a done task from the active board, filters it in, and restores it', async () => {
    const { service, actor } = build('auto')
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Finished', acceptanceCriteria: ['done'] }, actor)
    const settled = await service.update(task.key as string, { status: 'done' }, actor)
    expect(settled.archivedAt).toBeNull()

    const archived = await service.archive(settled.key as string, true)
    expect(archived.archivedAt).not.toBeNull()
    expect(service.list()).toHaveLength(0)
    expect(service.list({ archived: true }).map(entry => entry.id)).toContain(settled.id)

    const restored = await service.archive(archived.key as string, false)
    expect(restored.archivedAt).toBeNull()
    expect(service.list().map(entry => entry.id)).toContain(settled.id)
  })

  it('refuses to archive a task that is not done', async () => {
    const { service, actor } = build('auto')
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Open', acceptanceCriteria: ['o'] }, actor)
    await expect(service.archive(task.key as string, true))
      .rejects.toThrow(/only done tasks/)
  })

  it('archives every done task with archiveAllDone and skips the rest', async () => {
    const { service, actor } = build('auto')
    const first = await service.create({ projectId: PROJECT_ID, title: 'A', acceptanceCriteria: ['a'] }, actor)
    const second = await service.create({ projectId: PROJECT_ID, title: 'B', acceptanceCriteria: ['b'] }, actor)
    const open = await service.create({ projectId: PROJECT_ID, title: 'C', acceptanceCriteria: ['c'] }, actor)
    await service.update(first.key as string, { status: 'done' }, actor)
    await service.update(second.key as string, { status: 'done' }, actor)

    expect(await service.archiveAllDone()).toBe(2)
    expect(service.list({ archived: true })).toHaveLength(2)
    expect(service.list()).toHaveLength(1)
    expect(service.list()[0]?.id).toBe(open.id)
  })

  it('keeps archived tasks in the export (backup completeness)', async () => {
    const { service, actor } = build('auto')
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Gone', acceptanceCriteria: ['g'] }, actor)
    await service.update(task.key as string, { status: 'done' }, actor)
    await service.archive(task.key as string, true)

    const doc = service.exportAll()
    expect(doc.tasks.some(entry => entry.id === task.id && entry.archivedAt !== null)).toBe(true)
  })
})

describe('context budget (v1.2 B2)', () => {
  it('stores the input-context budget and clears it with null', async () => {
    const { service, actor } = build('auto')
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Budgeted', acceptanceCriteria: ['b'], contextBudgetTokens: 4000 }, actor)
    expect(task.contextBudgetTokens).toBe(4000)

    const cleared = await service.update(task.key as string, { contextBudgetTokens: null }, actor)
    expect(cleared.contextBudgetTokens).toBeNull()
  })
})

describe('claim release (v1.5 fix)', () => {
  it('releases the claim when a task leaves in_progress, so it can be re-claimed', async () => {
    const { service, actor } = build('auto')
    const t = await service.create({ projectId: PROJECT_ID, title: 'Rework', acceptanceCriteria: ['w'], status: 'open' }, actor)
    await service.autoClaim(t.key as string, 'session-1')
    expect(service.get(t.key as string)?.claimedBySessionId).toBe('session-1')

    // Bounce to draft (the panel's 打回待立项) — the claim must drop.
    await service.update(t.key as string, { status: 'draft', note: 'bounce: redo' }, actor)
    expect(service.get(t.key as string)?.claimedBySessionId).toBeNull()

    // Back to open and claimable again.
    await service.update(t.key as string, { status: 'open' }, actor)
    const reclaimed = await service.autoClaim(t.key as string, 'session-2')
    expect(reclaimed?.claimedBySessionId).toBe('session-2')
  })

  it('keeps the claim while the task stays in_progress', async () => {
    const { service, actor } = build('auto')
    const t = await service.create({ projectId: PROJECT_ID, title: 'Held', acceptanceCriteria: ['w'], status: 'open' }, actor)
    await service.autoClaim(t.key as string, 'session-1')
    await service.update(t.key as string, { title: 'Held 2' }, actor)
    expect(service.get(t.key as string)?.claimedBySessionId).toBe('session-1')
  })
})

describe('token usage recording (v1.5 S2)', () => {
  it('stores tokensUsed passed to settleDispatch and keeps it absent otherwise', async () => {
    const { service, actor } = build('auto')
    const a = await service.create({ projectId: PROJECT_ID, title: 'A', acceptanceCriteria: ['a'] }, actor)
    await service.autoClaim(a.key as string, 'session-1')
    const measured = await service.settleDispatch(a.key as string, 'session-1', {
      kind: 'completed',
      evidence: { criteria: [{ criterion: 'a', met: true, note: '' }], artifacts: [], summary: 'ok' },
    }, 4321)
    expect(measured?.tokensUsed).toBe(4321)

    const b = await service.create({ projectId: PROJECT_ID, title: 'B', acceptanceCriteria: ['b'] }, actor)
    await service.autoClaim(b.key as string, 'session-1')
    const unmeasured = await service.settleDispatch(b.key as string, 'session-1', {
      kind: 'completed',
      evidence: { criteria: [{ criterion: 'b', met: true, note: '' }], artifacts: [], summary: 'ok' },
    })
    expect(unmeasured?.tokensUsed).toBeNull()
  })
})

describe('task chaining (v1.7 P3)', () => {
  it('auto-creates the chained task on done and clears the parent spec', async () => {
    const { service, actor } = build('auto')
    const parent = await service.create({
      projectId: PROJECT_ID, title: 'Parent', acceptanceCriteria: ['p'], status: 'open',
      nextTask: { title: 'Child', body: 'next step', acceptanceCriteria: ['c'] },
    }, actor)
    expect(parent.nextTask?.title).toBe('Child')

    const done = await service.update(parent.key as string, { status: 'done' }, actor)
    expect(done.nextTask).toBeNull()
    expect(done.notes).toContain('chained →')

    const children = service.list().filter(task => task.title === 'Child')
    expect(children).toHaveLength(1)
    expect(children[0]?.status).toBe('open')
    expect(children[0]?.projectId).toBe(PROJECT_ID)
    expect(children[0]?.spec?.acceptanceCriteria).toEqual(['c'])
  })

  it('chains only once — a repeat done-transition never re-creates', async () => {
    const { service, actor } = build('auto')
    const parent = await service.create({
      projectId: PROJECT_ID, title: 'Once', acceptanceCriteria: ['p'], status: 'open',
      nextTask: { title: 'Only child', acceptanceCriteria: ['c'] },
    }, actor)
    await service.update(parent.key as string, { status: 'done' }, actor)
    await service.update(parent.key as string, { status: 'open' }, actor)
    await service.update(parent.key as string, { status: 'done' }, actor)

    expect(service.list().filter(task => task.title === 'Only child')).toHaveLength(1)
  })

  it('lands in draft when the chain spec has no criteria', async () => {
    const { service, actor } = build('auto')
    const parent = await service.create({
      projectId: PROJECT_ID, title: 'Draft chain', acceptanceCriteria: ['p'], status: 'open',
      nextTask: { title: 'Draft child', acceptanceCriteria: [] },
    }, actor)
    await service.update(parent.key as string, { status: 'done' }, actor)
    const child = service.list().find(task => task.title === 'Draft child')
    expect(child?.status).toBe('draft')
  })
})

describe('stale-claim recovery write (v1.8 M3)', () => {
  it('releases the claim back to open with a recovery note', async () => {
    const { service, actor } = build('auto')
    const t = await service.create({ projectId: PROJECT_ID, title: 'Stuck', acceptanceCriteria: ['s'], status: 'open' }, actor)
    await service.autoClaim(t.key as string, 'dead-session')
    expect(service.get(t.key as string)?.claimedBySessionId).toBe('dead-session')

    const recovered = await service.recoverStaleClaim(t.key as string, 'driver', 90)
    expect(recovered.status).toBe('open')
    expect(recovered.claimedBySessionId).toBeNull()
    expect(recovered.notes).toContain('recovered: session lost (claimed 90 min ago)')
    expect(service.activityOf(t.key as string).some(entry =>
      entry.action === 'noted' && (entry.to ?? '').startsWith('recovered:'))).toBe(true)

    const reclaimed = await service.autoClaim(t.key as string, 'session-2')
    expect(reclaimed?.claimedBySessionId).toBe('session-2')
  })
})

describe('project lifecycle (v1.7 P1)', () => {
  it('creates, renames, and removes an empty project', async () => {
    const { service, actor } = build('auto')
    const created = await service.createProject('Release')
    expect(created.name).toBe('Release')
    expect(service.projects().some(project => project.id === created.id)).toBe(true)

    const renamed = await service.renameProject(created.id, 'Ship')
    expect(renamed.name).toBe('Ship')

    const removed = await service.removeProject(created.id)
    expect(removed.removed).toBe(true)
    expect(service.projects().some(project => project.id === created.id)).toBe(false)
  })

  it('refuses empty/duplicate names and removing a project that holds tasks', async () => {
    const { service, actor } = build('auto')
    await expect(service.createProject('  ')).rejects.toThrow(/must not be empty/)
    await service.createProject('Dupe')
    await expect(service.createProject('Dupe')).rejects.toThrow(/already exists/)

    await service.create({ projectId: PROJECT_ID, title: 'Held', acceptanceCriteria: ['h'] }, actor)
    const inbox = service.projects().find(project => project.id === PROJECT_ID)
    await expect(service.removeProject(inbox?.id as string))
      .rejects.toThrow(/has 1 task/)
  })

  it('migrates a task to another project', async () => {
    const { service, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, title: 'Mover', acceptanceCriteria: ['m'] }, actor)
    const other = await service.createProject('Other')

    const moved = await service.update(task.key as string, { projectId: other.id }, actor)
    expect(moved.projectId).toBe(other.id)
    expect(service.list({ projectId: other.id }).map(t => t.id)).toContain(task.id)

    await expect(service.update(task.key as string, { projectId: 'no-such' }, actor))
      .rejects.toThrow(/does not exist/)
  })
})

describe('manual ordering (v1.4 E3)', () => {
  it('pins a column order, ranks by sortOrder then recency', async () => {
    const { service, actor } = build('auto')
    const a = await service.create({ projectId: PROJECT_ID, title: 'A', acceptanceCriteria: ['a'] }, actor)
    const b = await service.create({ projectId: PROJECT_ID, title: 'B', acceptanceCriteria: ['b'] }, actor)
    const c = await service.create({ projectId: PROJECT_ID, title: 'C', acceptanceCriteria: ['c'] }, actor)
    // Storage order is recency: C, B, A. Pin the reverse.
    await service.reorder([a.key as string, b.key as string, c.key as string])

    const ordered = service.list().map(task => task.title)
    expect(ordered).toEqual(['A', 'B', 'C'])
    expect(service.get(a.key as string)?.sortOrder).toBe(0)
    expect(service.get(c.key as string)?.sortOrder).toBe(2)
  })

  it('unranks every task not named in a later reorder', async () => {
    const { service, actor } = build('auto')
    const a = await service.create({ projectId: PROJECT_ID, title: 'A', acceptanceCriteria: ['a'] }, actor)
    const b = await service.create({ projectId: PROJECT_ID, title: 'B', acceptanceCriteria: ['b'] }, actor)
    const c = await service.create({ projectId: PROJECT_ID, title: 'C', acceptanceCriteria: ['c'] }, actor)
    await service.reorder([a.key as string, b.key as string, c.key as string])
    // Full-column reorder again: the previous ranks are replaced wholesale.
    await service.reorder([c.key as string, b.key as string, a.key as string])
    expect(service.list().map(task => task.title)).toEqual(['C', 'B', 'A'])
  })

  it('refuses a partial, duplicate, or unknown reorder', async () => {
    const { service, actor } = build('auto')
    const a = await service.create({ projectId: PROJECT_ID, title: 'A', acceptanceCriteria: ['a'] }, actor)
    const b = await service.create({ projectId: PROJECT_ID, title: 'B', acceptanceCriteria: ['b'] }, actor)
    await service.create({ projectId: PROJECT_ID, title: 'C', acceptanceCriteria: ['c'] }, actor)

    await expect(service.reorder([a.key as string])).rejects.toThrow(/every task/)
    await expect(service.reorder([a.key as string, a.key as string, b.key as string]))
      .rejects.toThrow(/duplicate/)
    await expect(service.reorder(['no-such-key'])).rejects.toThrow(/does not exist/)
  })

  it('keeps each column order independent', async () => {
    const { service, actor } = build('auto')
    const openA = await service.create({ projectId: PROJECT_ID, title: 'OA', acceptanceCriteria: ['a'] }, actor)
    const openB = await service.create({ projectId: PROJECT_ID, title: 'OB', acceptanceCriteria: ['b'] }, actor)
    const draftX = await service.create({ projectId: PROJECT_ID, title: 'DX', status: 'draft' }, actor)
    // Reordering the open column must not touch the draft column.
    await service.reorder([openB.key as string, openA.key as string])
    expect(service.list({ status: 'open' }).map(task => task.title)).toEqual(['OB', 'OA'])
    expect(service.get(draftX.key as string)?.sortOrder).toBeNull()
  })
})

describe('board statistics (v1.5 S1)', () => {
  /** A service whose clock advances one minute per `now()` call, so activity
   * timestamps and dwells are deterministic. */
  function buildTimed(stuckMinutes?: Partial<Record<'in_progress' | 'awaiting_human' | 'blocked', number>>) {
    const store = fakeStore()
    const approval = fakeApproval('allowed-once')
    let clock = 1_000_000
    let idSeq = 0
    const service = new TaskboardService({
      store,
      approval,
      writePolicy: 'auto',
      maxTasks: 50,
      keyPrefix: 'TB',
      activityRetentionPerTask: 50,
      statsStuckMinutes: stuckMinutes,
      now: () => { clock += 60_000; return clock },
      newId: () => `stats-id-${++idSeq}`,
    })
    const actor: Actor = { kind: 'human', via: 'panel' }
    return { service, store, actor }
  }

  it('derives lead/cycle/awaiting dwell and ratios from the activity stream', async () => {
    const { service, actor } = buildTimed()
    const t = await service.create(
      { projectId: PROJECT_ID, title: 'Loop', acceptanceCriteria: ['ok'], status: 'open' }, actor)
    await service.autoClaim(t.key as string, 'session-1')
    await service.settleDispatch(t.key as string, 'session-1', {
      kind: 'completed',
      evidence: { criteria: [{ criterion: 'ok', met: true, note: '' }], artifacts: [], summary: 'done' },
    })
    await service.update(t.key as string, { status: 'done' }, actor)

    const stats = service.stats()
    expect(stats.ratios.completionRate).toBe(100)
    expect(stats.ratios.agentSuccessRate).toBe(100)
    expect(stats.ratios.reworkRate).toBe(0) // 1 done, 0 bounces
    expect(stats.averages.avgLeadTimeMin).toBe(3)   // created -> done: 3 min of clock
    expect(stats.averages.avgCycleTimeMin).toBe(1)  // in_progress dwell: claim -> settle
    expect(stats.averages.avgAwaitingHumanMin).toBe(1) // awaiting -> done
    expect(stats.trend).toHaveLength(7)
    expect(stats.trend[6]?.created).toBeGreaterThanOrEqual(1)
    expect(stats.trend[6]?.completed).toBeGreaterThanOrEqual(1)
  })

  it('counts a bounce (awaiting_human -> draft) as rework and splits dwell', async () => {
    const { service, actor } = buildTimed()
    const t = await service.create(
      { projectId: PROJECT_ID, title: 'Rework', acceptanceCriteria: ['ok'], status: 'open' }, actor)
    await service.autoClaim(t.key as string, 'session-1')
    await service.settleDispatch(t.key as string, 'session-1', {
      kind: 'completed',
      evidence: { criteria: [{ criterion: 'ok', met: true, note: '' }], artifacts: [], summary: 'first' },
    })
    // Bounce back to draft (the panel's 打回待立项 path).
    await service.update(t.key as string, { status: 'draft', note: 'bounce: redo it' }, actor)
    // Re-spec, re-claim, settle again, confirm done.
    await service.update(t.key as string, { status: 'open' }, actor)
    await service.autoClaim(t.key as string, 'session-1')
    await service.settleDispatch(t.key as string, 'session-1', {
      kind: 'completed',
      evidence: { criteria: [{ criterion: 'ok', met: true, note: '' }], artifacts: [], summary: 'second' },
    })
    await service.update(t.key as string, { status: 'done' }, actor)

    const stats = service.stats()
    expect(stats.ratios.reworkRate).toBe(100) // 1 bounce / 1 done
    expect(stats.ratios.agentSuccessRate).toBe(100) // 2 completed settles, both awaiting_human
    expect(stats.ratios.completionRate).toBe(100)
  })

  it('flags a task stuck past its configured threshold', async () => {
    const { service, actor } = buildTimed({ blocked: 1 })
    const t = await service.create(
      { projectId: PROJECT_ID, title: 'Stuck', acceptanceCriteria: ['ok'], status: 'open' }, actor)
    await service.autoClaim(t.key as string, 'session-1')
    await service.settleDispatch(t.key as string, 'session-1', {
      kind: 'error',
      reason: 'ran out',
      diagnosis: 'subagent failed',
    })

    const stats = service.stats()
    expect(stats.stuck).toHaveLength(1)
    expect(stats.stuck[0]?.key).toBe(t.key)
    expect(stats.stuck[0]?.status).toBe('blocked')
    expect(stats.stuck[0]?.dwellMin).toBeGreaterThanOrEqual(1)
    expect(stats.stuck[0]?.thresholdMin).toBe(1)
  })

  it('reports cost from measured token usage, with over-budget detection', async () => {
    const { service, store, actor } = buildTimed()
    const a = await service.create({ projectId: PROJECT_ID, title: 'A', acceptanceCriteria: ['a'] }, actor)
    const b = await service.create({ projectId: PROJECT_ID, title: 'B', acceptanceCriteria: ['b'] }, actor)
    // No service method sets tokensUsed yet (v1.5 S2); write the records
    // directly to exercise the stats cost dimension.
    store.putTask({ ...store.tasks.get(a.id) as Task, tokensUsed: 500, budgetTokens: 400 })
    store.putTask({ ...store.tasks.get(b.id) as Task, tokensUsed: 100, budgetTokens: null })

    const stats = service.stats()
    expect(stats.cost.totalTokens).toBe(600)
    expect(stats.cost.avgTokensPerTask).toBe(300)
    expect(stats.cost.overBudgetCount).toBe(1)
  })

  it('reports cost as null before any measurement and lists oldest unfinished', async () => {
    const { service, actor } = buildTimed()
    await service.create({ projectId: PROJECT_ID, title: 'Old', acceptanceCriteria: ['o'] }, actor)
    const stats = service.stats()
    expect(stats.cost.totalTokens).toBeNull()
    expect(stats.cost.avgTokensPerTask).toBeNull()
    expect(stats.cost.overBudgetCount).toBeNull()
    expect(stats.oldest).toHaveLength(1)
    expect(stats.oldest[0]?.key).toBe('TB-1')
  })
})

describe('export and import', () => {
  it('round-trips a board and keys keyless imported tasks', async () => {
    const source = build('auto')
    await source.service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Carried over' }, source.actor)
    const doc = source.service.exportAll()

    const target = build('auto')
    const counts = await target.service.importDocument(doc, target.actor)

    expect(counts.tasks).toBe(1)
    const restored = target.service.list()[0]
    expect(restored?.title).toBe('Carried over')
    expect(restored?.key).toBe('TB-1')
  })

  it('imports a v0.1-style document without keys', async () => {
    const target = build('auto')
    const v01 = {
      schema: 'dsh-taskboard-export-v1',
      domainVersion: 1,
      exportedAt: 0,
      projects: [{
        id: 'p1',
        name: 'Inbox',
        description: '',
        workspaceId: null,
        archived: false,
        createdAt: 0,
        updatedAt: 0,
      }],
      tasks: [{
        id: 't1',
        projectId: 'p1',
        title: 'Old task',
        body: '',
        status: 'todo',
        priority: 'normal',
        labels: [],
        workspaceId: null,
        claimedBySessionId: null,
        revision: 0,
        createdAt: 0,
        updatedAt: 0,
      }],
    }
    const counts = await target.service.importDocument(v01, target.actor)
    expect(counts.tasks).toBe(1)
    const restored = target.service.get('t1')
    expect(restored?.status).toBe('open')
    expect(restored?.key).toBe('TB-1')
  })

  it('rejects an unknown document loudly', async () => {
    const { service, actor } = build('auto')
    await expect(service.importDocument({ schema: 'something-else' }, actor))
      .rejects.toMatchObject({ code: 'unsupported-document' })
  })
})
