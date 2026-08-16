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
