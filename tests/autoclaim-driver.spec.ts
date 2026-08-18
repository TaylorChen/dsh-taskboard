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
import { apply, estimateInputTokens, staleClaimCandidates } from '../src/autoclaim.ts'
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
    deleteProject: async (id: ProjectId) => projects.delete(id),
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
  const injections: unknown[] = []
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
    inject: (message: unknown): void => { injections.push(message) },
  }
  return { agent, followups, injections }
}

/** A fake subagent seam: records starts and lets the test settle runs. */
function fakeSubagents() {
  const starts: Array<{ name: string, prompt: Array<{ text?: string }>, parentId: string, agentOptions?: unknown }> = []
  let disposed = 0
  const pending: Array<{
    id: string,
    resolve: (result: { stopReason: string, structured?: unknown, output?: Array<{ text?: string }> }) => void,
    reject: (error: Error) => void,
  }> = []
  let seq = 0
  return {
    starts,
    disposed: () => disposed,
    settleNext: (
      stopReason: string,
      structured?: unknown,
      output?: Array<{ text?: string }>,
    ): void => pending.shift()?.resolve({ stopReason, structured, output }),
    failNext: (message: string): void => pending.shift()?.reject(new Error(message)),
    start: (name: string, request: {
      prompt: Array<{ text?: string }>, parent: { id: string }, agentOptions?: unknown,
    }) => {
      starts.push({ name, prompt: request.prompt, parentId: request.parent.id, agentOptions: request.agentOptions })
      const run = {
        id: `sub-${++seq}`,
        result: new Promise<{ stopReason: string, structured?: unknown }>((resolve, reject) => {
          pending.push({ id: `sub-${seq}`, resolve, reject })
        }),
        dispose: async () => { disposed += 1 },
      }
      return run
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
    logger: { warn: () => {}, info: () => {} },
    ...overrides,
  }
}

interface Rig {
  service: TaskboardService
  ctx: ReturnType<typeof fakeCtx>
  actor: Actor
  /** Follow-up turns the driver queued via `agent.followup` (fallback path). */
  followups: unknown[]
  /** Context digests the driver injected via `agent.inject` (v0.8). */
  injections: unknown[]
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
  options: {
    workspaceCwd?: string, withSubagents?: boolean, sessionContext?: boolean,
    dispatchTimeoutMs?: number,
    autoRetry?: { maxRetries: number, backoffMs: number },
    heartbeatMs?: number,
    staleClaimMinutes?: number,
  } = {},
): Rig & { subagents: ReturnType<typeof fakeSubagents>, injections: unknown[] } {
  const store = fakeStore()
  const service = new TaskboardService({
    store,
    approval: { request: async () => 'allowed-once' },
    writePolicy: 'auto',
    maxTasks: 100,
    keyPrefix: 'TB',
    activityRetentionPerTask: 50,
    now: () => Date.now(),
    newId: () => `id-${++seq}`,
  })
  if (options.workspaceCwd !== undefined) {
    service.setWorkspaceResolver(async (cwd) => (cwd === options.workspaceCwd ? 'ws-a' : undefined))
  }
  const subagents = fakeSubagents()
  const { agent, followups, injections } = fakeAgent('session-a', contextWindow, options.workspaceCwd)
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
    sessionContext: options.sessionContext ?? false,
    sessionContextLimit: 5,
    dispatchTimeoutMs: options.dispatchTimeoutMs ?? 3_600_000,
    autoRetry: options.autoRetry ?? { maxRetries: 0, backoffMs: 30_000 },
    heartbeatMs: options.heartbeatMs ?? 0,
    staleClaimMinutes: options.staleClaimMinutes ?? 0,
  })
  const actor: Actor = { kind: 'human', via: 'panel' }
  return {
    service,
    ctx,
    actor,
    followups,
    injections,
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
      { projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Mine', sessionCwd: '/home/work' }, actor)
    const unbound = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Global' }, actor)
    await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Theirs' }, actor)
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
    const first = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Oldest' }, actor)
    await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Newer' }, actor)

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
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Ship it' }, actor)

    emitIdle()
    await settle()
    subagents.settleNext('completed', {
      criteria: [{ criterion: 'ship it', met: true, note: 'verified' }],
      artifacts: ['out.txt'],
      summary: 'done',
    })
    await settle()

    const settled = service.get(task.key as string)
    expect(settled?.status).toBe('awaiting_human')
    expect(settled?.blockedReason).toBeNull()
    expect(settled?.evidence?.criteria[0]).toEqual({
      criterion: 'ship it', met: true, note: 'verified',
    })
    expect(settled?.evidence?.summary).toBe('done')
    expect(service.activityOf(task.id).some(entry => entry.action === 'completed')).toBe(true)
  })

  it('settles a failed dispatch to blocked with a reason', async () => {
    const { service, actor, subagents, emitIdle, settle } = rig(128_000, 0, { withSubagents: true })
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Doomed' }, actor)

    emitIdle()
    await settle()
    subagents.settleNext('error', undefined, [{ text: 'stuck at step 3' }])
    await settle()

    const settled = service.get(task.key as string)
    expect(settled?.status).toBe('blocked')
    expect(settled?.blockedReason).toContain('subagent sub-1 ended with error')
    expect(settled?.evidence?.summary).toContain('stuck at step 3')
  })

  it('does not claim a task whose dependency is unfinished (v0.7)', async () => {
    const { service, actor, emitIdle, settle } = rig(128_000, 0, { withSubagents: true })
    const dep = await service.create(
      { projectId: PROJECT_ID, title: 'Dep', acceptanceCriteria: ['d'] }, actor)
    await service.create({
      projectId: PROJECT_ID,
      title: 'Worker',
      acceptanceCriteria: ['w'],
      dependsOn: [dep.key as string],
    }, actor)

    emitIdle()
    await settle()
    // Nothing is claimable: the only open task waits on its open dependency.
    expect(service.list({ status: 'open' }).every(t => t.claimedBySessionId === null)).toBe(true)

    // Complete the dependency; the next idle event claims the worker.
    await service.update(dep.key as string, { status: 'done' }, actor)
    emitIdle()
    await settle()
    expect(service.list({ status: 'in_progress' })[0]?.title).toBe('Worker')
  })

  it('prefers a higher-priority claimable task (v0.7)', async () => {
    const { service, actor, emitIdle, settle } = rig(128_000, 0, { withSubagents: true })
    const urgent = await service.create(
      { projectId: PROJECT_ID, title: 'Urgent', acceptanceCriteria: ['u'], priority: 'urgent' }, actor)
    const normal = await service.create(
      { projectId: PROJECT_ID, title: 'Normal first', acceptanceCriteria: ['n'] }, actor)

    emitIdle()
    await settle()

    const claimed = service.list({ status: 'in_progress' })[0]
    expect(claimed?.title).toBe('Urgent')
    expect(service.get(normal.key as string)?.claimedBySessionId).toBeNull()
    expect(service.get(urgent.key as string)?.claimedBySessionId).toBe('session-a')
  })

  it('passes the task budget as the subagent maxTokens (v0.7)', async () => {
    const { service, actor, subagents, emitIdle, settle } = rig(128_000, 0, { withSubagents: true })
    await service.create({
      projectId: PROJECT_ID,
      title: 'Budgeted',
      acceptanceCriteria: ['b'],
      budgetTokens: 300,
    }, actor)

    emitIdle()
    await settle()

    expect(subagents.starts[0]?.agentOptions).toEqual({ maxTokens: 300 })
  })

  it('settles a max-tokens stop as a budget overrun (v0.7)', async () => {
    const { service, actor, subagents, emitIdle, settle } = rig(128_000, 0, { withSubagents: true })
    const task = await service.create({
      projectId: PROJECT_ID,
      title: 'Blowup',
      acceptanceCriteria: ['b'],
      budgetTokens: 10,
    }, actor)

    emitIdle()
    await settle()
    subagents.settleNext('max-tokens', undefined, [{ text: 'ran out mid-way' }])
    await settle()

    const settled = service.get(task.key as string)
    expect(settled?.status).toBe('blocked')
    expect(settled?.blockedReason).toContain('token budget')
    expect(settled?.evidence?.summary).toContain('ran out mid-way')
  })

  it('settles as error when the subagent finishes without a structured report', async () => {
    const { service, actor, subagents, emitIdle, settle } = rig(128_000, 0, { withSubagents: true })
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'No report', acceptanceCriteria: ['works'] }, actor)

    emitIdle()
    await settle()
    // 'completed' but no structured value: no half-evidence.
    subagents.settleNext('completed', undefined)
    await settle()

    const settled = service.get(task.key as string)
    expect(settled?.status).toBe('blocked')
    expect(settled?.blockedReason).toContain('without a structured report')
  })

  it('falls back to a follow-up turn when the subagent seam is absent', async () => {
    const { service, actor, followups, emitIdle, settle } = rig(128_000, 5000)
    const first = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Oldest' }, actor)

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
    await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'No budget' }, actor)

    emitIdle()
    await settle()

    expect(service.list({ status: 'open' })).toHaveLength(1)
  })

  it('does nothing when the capacity is unknown', async () => {
    const { service, actor, emitIdle, settle } = rig(undefined, 0)
    await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'No capacity info' }, actor)

    emitIdle()
    await settle()

    expect(service.get('TB-1')?.claimedBySessionId).toBeNull()
  })

  it('does not double-claim on a second idle event', async () => {
    const { service, actor, emitIdle, settle } = rig(128_000, 0)
    const task = await service.create({ projectId: PROJECT_ID, acceptanceCriteria: ['done'], title: 'Once' }, actor)

    emitIdle()
    await settle()
    emitIdle()
    await settle()

    expect(service.get(task.key as string)?.claimedBySessionId).toBe('session-a')
    expect(service.get(task.key as string)?.revision).toBe(1)
  })

  it('cancels the subagent when a dispatched task leaves in_progress (v1.1)', async () => {
    const { service, actor, subagents, emitIdle, settle, ctx } = rig(128_000, 0, { withSubagents: true })
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Running', acceptanceCriteria: ['w'] }, actor)

    emitIdle()
    await settle()
    expect(subagents.starts).toHaveLength(1)
    expect(service.executionOf(task.key as string)?.subagentId).toBe('sub-1')

    // A human moves the task out of in_progress; the driver's
    // domain/changed listener cancels the child.
    const stored = await service.update(task.key as string, { status: 'draft' }, actor)
    ctx.emit('domain/changed', {
      domain: 'taskboard', table: 'tasks', key: stored.id, operation: 'put', value: stored,
    })
    await settle()

    expect(subagents.disposed()).toBe(1)
    expect(service.executionOf(task.key as string)).toBeUndefined()

    // A late child result must not double-settle (task already moved).
    subagents.settleNext('completed', {
      criteria: [{ criterion: 'w', met: true, note: '' }], artifacts: [], summary: 'late',
    })
    await settle()
    expect(service.get(task.key as string)?.status).toBe('draft')
  })

  it('times out a dispatched execution and settles it blocked (v1.1)', async () => {
    const { service, actor, subagents, emitIdle, settle } = rig(128_000, 0, {
      withSubagents: true, dispatchTimeoutMs: 20,
    })
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Slow', acceptanceCriteria: ['w'] }, actor)

    emitIdle()
    await settle()
    expect(subagents.starts).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 80))

    const settled = service.get(task.key as string)
    expect(settled?.status).toBe('blocked')
    expect(settled?.blockedReason).toContain('execution timed out')
    expect(settled?.evidence?.summary).toContain('exceeded 20 ms')
    expect(subagents.disposed()).toBe(1)
  })

  it('refuses a dispatch whose prompt exceeds the context budget and settles blocked (v1.2 B2)', async () => {
    const { service, actor, subagents, emitIdle, settle } = rig(128_000, 0, { withSubagents: true })
    await service.create({
      projectId: PROJECT_ID,
      title: 'Huge',
      acceptanceCriteria: ['big'],
      contextBudgetTokens: 10, // any dispatch prompt is far larger than 10 tokens
    }, actor)

    emitIdle()
    await settle()

    // Refused BEFORE the seam: no subagent was ever started.
    expect(subagents.starts).toHaveLength(0)
    const settled = service.list({ status: 'blocked' })[0]
    expect(settled?.blockedReason).toContain('over budget')
    expect(settled?.evidence?.summary).toContain('estimated')
  })

  it('dispatches normally when the prompt fits the context budget (v1.2 B2)', async () => {
    const { service, actor, subagents, emitIdle, settle } = rig(128_000, 0, { withSubagents: true })
    const task = await service.create({
      projectId: PROJECT_ID,
      title: 'Fits',
      acceptanceCriteria: ['ok'],
      contextBudgetTokens: 1_000_000,
    }, actor)

    emitIdle()
    await settle()

    expect(subagents.starts).toHaveLength(1)
    expect(service.get(task.key as string)?.status).toBe('in_progress')
  })
})

describe('token usage recording (v1.5 S2)', () => {
  it('records the measurable child session usage at settle', async () => {
    const { service, actor, subagents, emitIdle, settle, ctx } = rig(128_000, 0, { withSubagents: true })
    // The child session is looked up by its run id at settle; make any
    // unknown id resolve to a measurable child, and the meter report 987.
    const mutable = ctx as unknown as {
      agents: { get: (id: string) => unknown }
      tokenMeter: { measure: () => { totalTokens: number } }
    }
    const realGet = mutable.agents.get.bind(mutable.agents)
    mutable.agents.get = (id: string) => realGet(id) ?? ({ session: { id: `child-${id}` } })
    mutable.tokenMeter = { measure: () => ({ totalTokens: 987 }) }

    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Measured', acceptanceCriteria: ['w'] }, actor)
    emitIdle()
    await settle()
    subagents.settleNext('completed', {
      criteria: [{ criterion: 'w', met: true, note: '' }], artifacts: [], summary: 'ok',
    })
    await settle()

    const settled = service.get(task.key as string)
    expect(settled?.status).toBe('awaiting_human')
    expect(settled?.tokensUsed).toBe(987)
  })

  it('falls back to the dispatch-prompt estimate when the child is gone', async () => {
    const { service, actor, subagents, emitIdle, settle } = rig(128_000, 0, { withSubagents: true })
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Gone child', acceptanceCriteria: ['w'] }, actor)
    emitIdle()
    await settle()
    subagents.settleNext('completed', {
      criteria: [{ criterion: 'w', met: true, note: '' }], artifacts: [], summary: 'ok',
    })
    await settle()

    const settled = service.get(task.key as string)
    // The rig's agents.get knows no child id -> deterministic estimate, > 0.
    expect(settled?.tokensUsed).toBeGreaterThan(0)
  })
})

describe('stale-claim recovery (v1.8 M3)', () => {
  it('flags claims whose session is gone or idle-with-no-dispatch, past the threshold', async () => {
    const { service, actor } = rig(128_000, 0)
    const gone = await service.create({ projectId: PROJECT_ID, title: 'Gone', acceptanceCriteria: ['g'], status: 'open' }, actor)
    await service.autoClaim(gone.key as string, 'dead-session')
    const idle = await service.create({ projectId: PROJECT_ID, title: 'Idle', acceptanceCriteria: ['i'], status: 'open' }, actor)
    await service.autoClaim(idle.key as string, 'session-a') // the rig's live, idle agent
    const busy = await service.create({ projectId: PROJECT_ID, title: 'Busy', acceptanceCriteria: ['b'], status: 'open' }, actor)
    await service.autoClaim(busy.key as string, 'session-a')
    const fresh = await service.create({ projectId: PROJECT_ID, title: 'Fresh', acceptanceCriteria: ['f'], status: 'open' }, actor)
    await service.autoClaim(fresh.key as string, 'session-a')

    const executions = new Map<string, unknown>()
    executions.set(busy.id, {}) // a live dispatch protects it
    const now = Date.now()
    // Rewrite timestamps so all four claims look old (past the threshold).
    for (const t of [gone, idle, busy, fresh]) {
      const stored = service.get(t.key as string)
      if (stored !== undefined) {
        service['deps'].store.putTask({ ...stored, updatedAt: now - 2 * 60 * 60_000 })
      }
    }
    const agents = { get: (id: string) => id === 'dead-session' ? undefined : { status: 'idle' } }

    const candidates = staleClaimCandidates(service, agents, executions, now, 60)
    const keys = candidates.map(task => task.key).sort()
    // All four are past the threshold (timestamps rewritten above): gone (dead
    // session) and the two idle-no-dispatch claims are stale; busy is protected
    // by its live dispatch.
    expect(keys).toEqual(['TB-1', 'TB-2', 'TB-4'].sort())
  })

  it('returns nothing when disabled or under the threshold', async () => {
    const { service, actor } = rig(128_000, 0)
    const t = await service.create({ projectId: PROJECT_ID, title: 'Safe', acceptanceCriteria: ['s'], status: 'open' }, actor)
    await service.autoClaim(t.key as string, 'gone')
    const agents = { get: () => undefined }
    expect(staleClaimCandidates(service, agents, new Map(), Date.now(), 0)).toHaveLength(0)
    expect(staleClaimCandidates(service, agents, new Map(), Date.now(), 60)).toHaveLength(0) // dwell ~0 < 60
  })
})

describe('bounded auto-retry (v1.6 C2)', () => {
  it('sends a failed dispatch back to open with a retry note, within the limit', async () => {
    const { service, actor, subagents, emitIdle, settle } = rig(128_000, 0, {
      withSubagents: true, autoRetry: { maxRetries: 1, backoffMs: 0 },
    })
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Flaky', acceptanceCriteria: ['w'] }, actor)

    emitIdle()
    await settle()
    subagents.settleNext('error')
    await settle()

    const retried = service.get(task.key as string)
    expect(retried?.status).toBe('open')
    expect(retried?.claimedBySessionId).toBeNull()
    expect(retried?.notes).toContain('retry 1/1')

    // Second failure hits the ceiling -> blocked permanently.
    emitIdle()
    await settle()
    subagents.settleNext('error')
    await settle()
    const settled = service.get(task.key as string)
    expect(settled?.status).toBe('blocked')
    expect(settled?.blockedReason).toContain('ended with error')
  })

  it('leaves completed dispatches untouched when auto-retry is on', async () => {
    const { service, actor, subagents, emitIdle, settle } = rig(128_000, 0, {
      withSubagents: true, autoRetry: { maxRetries: 3, backoffMs: 0 },
    })
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Solid', acceptanceCriteria: ['w'] }, actor)

    emitIdle()
    await settle()
    subagents.settleNext('completed', {
      criteria: [{ criterion: 'w', met: true, note: '' }], artifacts: [], summary: 'ok',
    })
    await settle()

    const settled = service.get(task.key as string)
    expect(settled?.status).toBe('awaiting_human')
    expect(settled?.notes).toBe('')
  })

  it('honours the backoff window before re-claiming a retried task', async () => {
    const { service, actor, subagents, emitIdle, settle } = rig(128_000, 0, {
      withSubagents: true, autoRetry: { maxRetries: 3, backoffMs: 60_000 },
    })
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Cooldown', acceptanceCriteria: ['w'] }, actor)

    emitIdle()
    await settle()
    subagents.settleNext('error')
    await settle()
    expect(service.get(task.key as string)?.status).toBe('open')

    // Within the backoff window the task is not a candidate.
    emitIdle()
    await settle()
    expect(subagents.starts).toHaveLength(1)
    expect(service.get(task.key as string)?.claimedBySessionId).toBeNull()
  })
})

describe('liveness heartbeat (v1.6 C3)', () => {
  it('appends heartbeat activity entries while dispatched and stops at settle', async () => {
    const { service, actor, subagents, emitIdle, settle } = rig(128_000, 0, {
      withSubagents: true, heartbeatMs: 30,
    })
    const task = await service.create(
      { projectId: PROJECT_ID, title: 'Alive', acceptanceCriteria: ['w'] }, actor)
    emitIdle()
    await settle()
    expect(subagents.starts).toHaveLength(1)

    // Wait past two heartbeat intervals while the child is still running.
    await new Promise(resolve => setTimeout(resolve, 90))
    const during = service.activityOf(task.key as string)
      .filter(entry => entry.action === 'noted' && (entry.to ?? '').startsWith('heartbeat'))
    expect(during.length).toBeGreaterThanOrEqual(1)

    subagents.settleNext('completed', {
      criteria: [{ criterion: 'w', met: true, note: '' }], artifacts: [], summary: 'ok',
    })
    await settle()
    await new Promise(resolve => setTimeout(resolve, 90))
    const after = service.activityOf(task.key as string)
      .filter(entry => entry.action === 'noted' && (entry.to ?? '').startsWith('heartbeat'))
    // No new beats after settle.
    expect(after.length).toBe(during.length)
  })
})

describe('notes reach the dispatched agent (v1.5 S3)', () => {
  it('quotes the task notes (incl. bounce reasons) into the dispatch prompt', async () => {
    const { service, actor, subagents, emitIdle, settle } = rig(128_000, 0, { withSubagents: true })
    await service.create({
      projectId: PROJECT_ID,
      title: 'Noted work',
      acceptanceCriteria: ['w'],
      notes: 'bounce: please use the sqlite path this time',
    }, actor)

    emitIdle()
    await settle()

    expect(subagents.starts).toHaveLength(1)
    const prompt = subagents.starts[0]?.prompt[0]?.text ?? ''
    expect(prompt).toContain('bounce: please use the sqlite path this time')
    expect(prompt).toContain('Notes from the human')
  })

  it('omits the notes section when the task has none', async () => {
    const { service, actor, subagents, emitIdle, settle } = rig(128_000, 0, { withSubagents: true })
    await service.create({ projectId: PROJECT_ID, title: 'Plain', acceptanceCriteria: ['w'] }, actor)
    emitIdle()
    await settle()
    const prompt = subagents.starts[0]?.prompt[0]?.text ?? ''
    expect(prompt).not.toContain('Notes from the human')
  })
})

describe('input-context estimate (v1.2 B2)', () => {
  it('approximates tokens as ceil(chars / 4)', () => {
    expect(estimateInputTokens('')).toBe(0)
    expect(estimateInputTokens('a')).toBe(1)
    expect(estimateInputTokens('abcd')).toBe(1)
    expect(estimateInputTokens('abcde')).toBe(2)
    expect(estimateInputTokens('x'.repeat(4000))).toBe(1000)
  })
})
