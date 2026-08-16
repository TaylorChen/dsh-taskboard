/**
 * Behaviour of the write gate and the optimistic-concurrency guard, over an
 * in-memory store. These are the two contracts a consumer relies on, so they
 * are tested against the service rather than through the tools.
 */

import { describe, expect, it } from 'vitest'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { Project, ProjectId, Task, TaskId } from '../src/domain.ts'
import { TaskboardError } from '../src/errors.ts'
import { TaskboardService, type Actor, type ApprovalLike, type TaskboardStore } from '../src/service.ts'
import type { WritePolicy } from '../src/defaults.ts'

const PROJECT_ID = 'project-1'

/** In-memory provider double; mirrors the real store's sync-read/async-write split. */
function fakeStore(): TaskboardStore & { tasks: Map<string, Task> } {
  const tasks = new Map<string, Task>()
  const projects = new Map<string, Project>([[PROJECT_ID, {
    id: PROJECT_ID,
    name: 'Inbox',
    description: '',
    workspaceId: null,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  }]])
  return {
    tasks,
    listTasks: () => [...tasks.values()],
    getTask: (id: TaskId) => tasks.get(id),
    putTask: async (task: Task) => { tasks.set(task.id, task) },
    deleteTask: async (id: TaskId) => tasks.delete(id),
    listProjects: () => [...projects.values()],
    getProject: (id: ProjectId) => projects.get(id),
    putProject: async (project: Project) => { projects.set(project.id, project) },
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
function build(policy: WritePolicy, outcome: ApprovalOutcome | Error = 'allowed-once') {
  const store = fakeStore()
  const approval = fakeApproval(outcome)
  let clock = 1000
  let seq = 0
  const service = new TaskboardService({
    store,
    approval,
    writePolicy: policy,
    maxTasks: 3,
    now: () => ++clock,
    newId: () => `task-${++seq}`,
  })
  // The gate only needs an object identity for routing; the double never reads it.
  const actor: Actor = { kind: 'agent', agent: {} as never }
  const human: Actor = { kind: 'human', via: 'panel' }
  return { service, store, approval, actor, human }
}

describe('write gate', () => {
  it('asks once per write and stores after approval', async () => {
    const { service, store, approval, actor } = build('ask')
    const task = await service.create({ projectId: PROJECT_ID, title: 'Ship it' }, actor)

    expect(approval.asks).toHaveLength(1)
    expect(approval.asks[0]).toContain('[dsh-taskboard] create')
    expect(approval.asks[0]).toContain('Ship it')
    expect(store.tasks.get(task.id)?.title).toBe('Ship it')
  })

  it('stores nothing when the human rejects', async () => {
    const { service, store, actor } = build('ask', 'rejected')
    await expect(service.create({ projectId: PROJECT_ID, title: 'Nope' }, actor))
      .rejects.toThrow(TaskboardError)
    expect(store.tasks.size).toBe(0)
  })

  it("refuses rather than auto-allowing when approval is unavailable", async () => {
    const { service, store, actor } = build('ask', new Error('no open turn'))
    await expect(service.create({ projectId: PROJECT_ID, title: 'Between turns' }, actor))
      .rejects.toMatchObject({ code: 'write-denied' })
    expect(store.tasks.size).toBe(0)
  })

  it("refuses an 'ask' write with no agent to ask through", async () => {
    const { service } = build('ask')
    await expect(service.create({ projectId: PROJECT_ID, title: 'Headless' }, { kind: 'agent' }))
      .rejects.toMatchObject({ code: 'write-denied' })
  })

  it("writes without asking under 'auto'", async () => {
    const { service, approval, actor } = build('auto')
    await service.create({ projectId: PROJECT_ID, title: 'Unattended' }, actor)
    expect(approval.asks).toHaveLength(0)
  })

  it("refuses every write under 'off'", async () => {
    const { service, actor } = build('off')
    await expect(service.create({ projectId: PROJECT_ID, title: 'Read only' }, actor))
      .rejects.toMatchObject({ code: 'write-denied' })
  })

  it('lets a human write without asking anyone', async () => {
    const { service, store, approval, human } = build('ask')
    const task = await service.create({ projectId: PROJECT_ID, title: 'Typed by hand' }, human)

    // The human IS the authority: asking them to approve their own click is
    // ceremony, so the approval seam is never consulted.
    expect(approval.asks).toHaveLength(0)
    expect(store.tasks.get(task.id)?.title).toBe('Typed by hand')
    expect(task.origin).toBe('human')
  })

  it("still refuses a human write under 'off'", async () => {
    const { service, human } = build('off')
    await expect(service.create({ projectId: PROJECT_ID, title: 'Read only' }, human))
      .rejects.toMatchObject({ code: 'write-denied' })
  })

  it('records who created each task', async () => {
    const { service, actor, human } = build('auto')
    const byAgent = await service.create({ projectId: PROJECT_ID, title: 'A' }, actor)
    const byHuman = await service.create({ projectId: PROJECT_ID, title: 'B' }, human)
    expect(byAgent.origin).toBe('agent')
    expect(byHuman.origin).toBe('human')
  })

  it('quotes the complete before/after into an update approval', async () => {
    const { service, approval, actor } = build('auto')
    const task = await service.create({ projectId: PROJECT_ID, title: 'Old title' }, actor)

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
    const created = await service.create({ projectId: PROJECT_ID, title: 'A' }, actor)
    expect(created.revision).toBe(0)

    const updated = await service.update(created.id as TaskId, { status: 'in_progress' }, actor)
    expect(updated.revision).toBe(1)
  })

  it('refuses a stale expectedRevision', async () => {
    const { service, actor } = build('auto')
    const created = await service.create({ projectId: PROJECT_ID, title: 'A' }, actor)
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
    await expect(service.create({ projectId: PROJECT_ID, title: 'd' }, actor))
      .rejects.toMatchObject({ code: 'limit-exceeded' })
  })

  it('refuses a task in a project that does not exist', async () => {
    const { service, actor } = build('auto')
    await expect(service.create({ projectId: 'ghost', title: 'x' }, actor))
      .rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('export and import', () => {
  it('round-trips a board', async () => {
    const source = build('auto')
    await source.service.create({ projectId: PROJECT_ID, title: 'Carried over' }, source.actor)
    const doc = source.service.exportAll()

    const target = build('auto')
    const counts = await target.service.importDocument(doc, target.actor)

    expect(counts.tasks).toBe(1)
    expect(target.service.list()[0]?.title).toBe('Carried over')
  })

  it('rejects an unknown document loudly', async () => {
    const { service, actor } = build('auto')
    await expect(service.importDocument({ schema: 'something-else' }, actor))
      .rejects.toMatchObject({ code: 'unsupported-document' })
  })
})
