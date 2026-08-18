/**
 * `ctx.taskboard` — the Service Definition of the task-board capability.
 *
 * Two contracts are load-bearing here:
 *
 * 1. **The approval gate lives inside the write methods, not in the tools.**
 *    Any caller — the `task_*` tools, a `/task` command, another plugin —
 *    reaches durability only through `create` / `update` / `remove` / `block` /
 *    `import`, so none of them can route around the gate. Putting the gate in a
 *    tool's `execute` would leave `ctx.taskboard.create()` open to every other
 *    plugin.
 * 2. **The provider's types never leave this file.** Consumers see `Task`,
 *    `Project`, and `TaskboardService`; the `Domain` / `KvTable` handles from
 *    the storage-domain seam stay behind `TaskboardStore`, whose design note is
 *    still `proposed/` upstream and may change.
 *
 * v0.2 additions: every write also appends one entry to the task's activity
 * stream (W3) — but only after the write is durable, so a refused write never
 * leaves a trace; task references accept the human-readable `TB-1` key or the
 * full id alike (W2); and moving a task into `blocked` requires a reason while
 * leaving it clears the reason (W1).
 * @module @navidid/dsh-taskboard/src/service
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  EXPORT_SCHEMA,
  DOMAIN_VERSION,
  exportDocumentSchema,
  type TaskExecutor,
  type Activity,
  type ActivityAction,
  type ActivityId,
  type ExportDocument,
  type Project,
  type ProjectId,
  type Task,
  type TaskEvidence,
  type TaskboardGlobal,
  type TaskId,
  type TaskPriority,
  type TaskSpec,
  type NextTaskSpec,
  nextTaskSpecSchema,
  TASK_STATUSES,
  type TaskStatus,
} from './domain.ts'
import { TaskboardError } from './errors.ts'
import {
  APPROVAL_BODY_PREVIEW_CHARS,
  APPROVAL_PREFIX,
  APPROVAL_TOOL_NAME,
  MAX_IMPORT_RECORDS,
  type WritePolicy,
} from './defaults.ts'

/**
 * The provider face this service needs. Implemented over one open storage
 * domain (`src/store.ts`); reads are synchronous, writes resolve after the
 * record is durable.
 */
export interface TaskboardStore {
  /** All stored tasks, in medium order. */
  listTasks(): readonly Task[]
  /** One task, or `undefined` when absent. */
  getTask(id: TaskId): Task | undefined
  /** Insert or replace one task; resolves once durable. */
  putTask(task: Task): Promise<void>
  /** Remove one task; resolves `true` when a record was removed. */
  deleteTask(id: TaskId): Promise<boolean>
  /** All stored projects, in medium order. */
  listProjects(): readonly Project[]
  /** One project, or `undefined` when absent. */
  getProject(id: ProjectId): Project | undefined
  /** Insert or replace one project; resolves once durable. */
  putProject(project: Project): Promise<void>
  /** Remove one project; resolves `true` when a record was removed. */
  deleteProject(id: ProjectId): Promise<boolean>
  /** One task's activity entries, oldest first (medium order). */
  listActivity(taskId: TaskId): readonly Activity[]
  /** Append one activity entry; resolves once durable. */
  putActivity(entry: Activity): Promise<void>
  /** Remove one activity entry; resolves `true` when a record was removed. */
  deleteActivity(id: ActivityId): Promise<boolean>
  /** The board's global singleton (the short-id counter). */
  getGlobal(): TaskboardGlobal
  /** Replace the board's global singleton; resolves once durable. */
  setGlobal(value: TaskboardGlobal): Promise<void>
}

/** The approval face this service needs (`ctx.approval`). */
export interface ApprovalLike {
  /** Ask the composed answerer chain to decide one write. */
  request(req: {
    agent: Agent
    toolName: string
    reason?: string
    signal?: AbortSignal
  }): Promise<ApprovalOutcome>
}

/**
 * Who initiated a write.
 *
 * The approval gate is about the INITIATOR, not the surface. A model asking to
 * write is not the authority over the board, so it passes through
 * `ctx.approval`; a human clicking a control in the panel or typing a `/task`
 * command IS the authority, so asking them to approve their own action is
 * ceremony. `writePolicy: 'off'` still refuses both, because that is a
 * deployment saying the board is read-only.
 */
export type Actor =
  | {
    readonly kind: 'agent'
    /**
     * The agent the approval question is routed to and audited on. Absent for
     * callers outside any agent; under `writePolicy: 'ask'` that combination
     * is refused rather than silently auto-approved.
     */
    readonly agent?: Agent
    /** Withdraws a pending approval question. */
    readonly signal?: AbortSignal
  }
  | {
    readonly kind: 'human'
    /** Which human surface initiated the write; recorded in the activity stream. */
    readonly via: 'panel' | 'command'
  }

/** Everything the service is constructed with. */
export interface TaskboardDeps {
  readonly store: TaskboardStore
  readonly approval: ApprovalLike
  readonly writePolicy: WritePolicy
  readonly maxTasks: number
  /** Short-id prefix; keys look like `<keyPrefix>1`, `TB-1` by default. */
  readonly keyPrefix: string
  /** Activity entries kept per task before the oldest are trimmed. */
  readonly activityRetentionPerTask: number
  /**
   * v1.5 S1: stuck-detection thresholds in minutes, per "waiting" status.
   * Missing keys fall back to the defaults (120 / 1440 / 720).
   */
  readonly statsStuckMinutes?: Partial<Record<'in_progress' | 'awaiting_human' | 'blocked', number>>
  /** Injected for tests; defaults to `Date.now`. */
  readonly now?: () => number
  /** Injected for tests; defaults to `crypto.randomUUID`. */
  readonly newId?: () => string
}

/** Fields accepted when creating a task. */
export interface CreateTaskInput {
  readonly projectId: string
  readonly title: string
  readonly body?: string
  readonly status?: TaskStatus
  readonly priority?: TaskPriority
  readonly labels?: readonly string[]
  readonly workspaceId?: string | null
  /**
   * The creating session's absolute cwd, when known. When `workspaceId` is
   * omitted and the workspace seam is available, an unbound task is bound to
   * the workspace owning this cwd (v0.4 W1 auto-assignment).
   */
  readonly sessionCwd?: string
  readonly blockedReason?: string | null
  /** v0.5 spec: acceptance criteria (the hard gate for entering `open`). */
  readonly acceptanceCriteria?: readonly string[]
  /** v0.5 spec: file/commit/issue references the executor should read. */
  readonly contextRefs?: readonly string[]
  /** v0.5 spec: optional closing conditions text. */
  readonly definitionOfDone?: string
  /** v0.7: prerequisite task references (keys or ids); each must not form a cycle. */
  readonly dependsOn?: readonly string[]
  /** v0.7: output-token budget for the dispatched subagent; null = unlimited. */
  readonly budgetTokens?: number | null
  /** v0.9: intended executor; `human` tasks are excluded from auto-claim. */
  readonly executor?: TaskExecutor
  /** v0.9: planned deadline (epoch ms); null = none. */
  readonly dueAt?: number | null
  /** v0.9: initial process notes. */
  readonly notes?: string
  /** v1.2 B2: input-context budget for the dispatched subagent; null = unlimited. */
  readonly contextBudgetTokens?: number | null
  /** v1.7 P3: the task chained on this one's completion. */
  readonly nextTask?: NextTaskInput | null
}

/** v1.7 P3: the chained task spec as a caller provides it (optional fields;
 * the schema fills defaults on store). */
export type NextTaskInput = {
  title: string
  body?: string
  acceptanceCriteria?: readonly string[]
  contextRefs?: readonly string[]
  definitionOfDone?: string
}

/** Fields accepted when updating a task; omitted fields keep their value. */
export interface UpdateTaskInput {
  readonly title?: string
  readonly body?: string
  /** v1.7 P1: migrate the task to another project (must exist). */
  readonly projectId?: string
  readonly status?: TaskStatus
  readonly priority?: TaskPriority
  readonly labels?: readonly string[]
  readonly workspaceId?: string | null
  readonly claimedBySessionId?: string | null
  /**
   * The acting session's absolute cwd, when known. When `workspaceId` is
   * omitted and the task is unbound, the workspace seam binds it to the
   * workspace owning this cwd (v0.4 W1 auto-assignment, e.g. on claim).
   */
  readonly sessionCwd?: string
  /** Why the task is (or is being moved to) `blocked`; cleared on leaving. */
  readonly blockedReason?: string | null
  /** v0.5 spec partial update: merge onto the existing spec, if any. */
  readonly spec?: {
    readonly acceptanceCriteria?: readonly string[]
    readonly contextRefs?: readonly string[]
    readonly definitionOfDone?: string
  }
  /** v0.7: replace the prerequisite task references (cycle-checked). */
  readonly dependsOn?: readonly string[]
  /** v0.7: replace the output-token budget; null clears it. */
  readonly budgetTokens?: number | null
  /** v0.9: replace the intended executor. */
  readonly executor?: TaskExecutor
  /** v0.9: replace the deadline; null clears it. */
  readonly dueAt?: number | null
  /** v1.2 B2: replace the input-context budget; null clears it. */
  readonly contextBudgetTokens?: number | null
  /** v1.7 P3: replace the chained task spec; null clears it. */
  readonly nextTask?: NextTaskInput | null
  /**
   * v0.9: APPEND one process note (never overwrites). Appending records a
   * `noted` activity entry.
   */
  readonly note?: string
  /**
   * Optimistic-concurrency guard. When present and different from the stored
   * revision the write is refused with `revision-conflict` — reread and retry
   * rather than clobbering a concurrent edit.
   */
  readonly expectedRevision?: number
}

/** Filter applied by `list`; every field is an AND term. */
export interface ListFilter {
  readonly projectId?: string
  readonly status?: TaskStatus
  readonly workspaceId?: string | null
  readonly label?: string
  readonly limit?: number
  /**
   * v1.2 C1: `undefined`/`false` excludes archived tasks (the active board);
   * `true` returns only archived ones.
   */
  readonly archived?: boolean
}

/**
 * A task reference: its human-readable short key (`TB-1`) or its full id
 * (UUID). Every lookup entry point accepts both; the service resolves the
 * reference once, at the top.
 */
export type TaskRef = string

/** A completed task's experience card (v0.8 L5): what one execution knew. */
export interface ExperienceCard {
  readonly key: string
  readonly title: string
  readonly criteria: readonly string[]
  readonly artifacts: readonly string[]
  readonly summary: string
}

/** A task's live execution (v1.1 A2): which subagent, since when. */
export interface ExecutionInfo {
  readonly subagentId: string
  readonly startedAt: number
}

/** A task's activity stream, newest first (the presentation order). */
export type ActivityStream = readonly Activity[]

/** One ratio or average the stats endpoint reports; `null` when there is
 * no data for it (e.g. no task ever reached a status). */
export type StatsValue = number | null

/** One trend bucket (v1.5 S1): created vs completed on one calendar day. */
export interface StatsTrendPoint {
  /** `YYYY-M-D` local calendar day. */
  readonly day: string
  readonly created: number
  readonly completed: number
}

/** One stuck task (v1.5 S1): waiting longer than its status threshold. */
export interface StuckTask {
  readonly key: string
  readonly title: string
  readonly status: TaskStatus
  readonly dwellMin: number
  readonly thresholdMin: number
}

/** One of the oldest unfinished tasks. */
export interface OldestTask {
  readonly key: string
  readonly title: string
  readonly status: TaskStatus
  readonly ageMin: number
}

/** The board-level statistics payload (v1.5 S1). Everything is derived from
 * the activity stream + current board — no extra instrumentation. */
export interface BoardStats {
  readonly ratios: {
    /** done / all stored tasks (archived + cancelled included). */
    readonly completionRate: StatsValue
    /** awaiting_human → draft bounces / tasks that reached done. */
    readonly reworkRate: StatsValue
    /** settles that landed awaiting_human / all settles. */
    readonly agentSuccessRate: StatsValue
    /** active tasks past their deadline / active tasks. */
    readonly overdueRate: StatsValue
  }
  readonly averages: {
    /** created → done, in minutes, over tasks that reached done. */
    readonly avgLeadTimeMin: StatsValue
    /** total in_progress dwell, in minutes, over tasks that reached done. */
    readonly avgCycleTimeMin: StatsValue
    /** awaiting_human dwell, in minutes, over tasks that ever waited. */
    readonly avgAwaitingHumanMin: StatsValue
    /** blocked dwell, in minutes, over tasks that ever blocked. */
    readonly avgBlockedMin: StatsValue
  }
  /** Last 7 calendar days, oldest first, from activity entries. */
  readonly trend: readonly StatsTrendPoint[]
  /** v1.9 G1: settle-failure classification of currently blocked tasks. */
  readonly failureModes: Record<string, number>
  /** v1.9 G3: last-14-days cumulative-flow — per-status end-of-day counts. */
  readonly cfd: readonly { day: string, counts: Record<string, number> }[]
  /** v1.9 G2: per-claiming-session comparison (success/rework/cycle/cost). */
  readonly byAgent: readonly {
    agent: string, tasks: number, success: number, rework: number,
    avgCycleMin: StatsValue, tokens: number,
  }[]
  /** Waiting tasks past their per-status threshold. */
  readonly stuck: readonly StuckTask[]
  /** The five oldest unfinished (not done/cancelled/archived) tasks. */
  readonly oldest: readonly OldestTask[]
  readonly cost: {
    /** Sum of `tokensUsed`; `null` until any task measured usage (v1.5 S2). */
    readonly totalTokens: StatsValue
    /** `totalTokens / tasks with a measurement`. */
    readonly avgTokensPerTask: StatsValue
    /** Tasks whose `tokensUsed` exceeded `budgetTokens`. */
    readonly overBudgetCount: StatsValue
  }
}

/**
 * The task-board service. Reads are synchronous (the provider serves from
 * authoritative memory); every write passes the approval gate first, then
 * lands durably, then appends one activity entry.
 */
export class TaskboardService {
  private readonly now: () => number
  private readonly newId: () => string
  /**
   * Serializes short-id allocation. The counter lives in the domain's global
   * slot: reads are synchronous from memory, so two concurrent creates could
   * both read the same number before either's `setGlobal` lands. Chaining the
   * allocation keeps `TB-N` unique across parallel sessions.
   */
  private keyChain: Promise<number> = Promise.resolve(0)
  /**
   * Serializes auto-claims. Reads are synchronous from memory, so without a
   * chain two idle agents scanning the same `open` column could both read an
   * unclaimed task before either's `putTask` lands, and both would claim it.
   */
  private claimChain: Promise<Task | null> = Promise.resolve(null)
  /**
   * The workspace seam resolver, injected by `apply()` when `ctx.workspaceRegistry`
   * is mounted (web profile only — see ARCHITECTURE decision 28). Absent in
   * headless: auto-assignment and scoping fall back to board-global.
   */
  private workspaceResolver: ((cwd: string | undefined) => Promise<string | undefined>) | undefined
  /**
   * The execution tracker injected by the auto-claim driver (v1.1 A2): which
   * in-progress task is running under which subagent. Absent when the driver
   * row is not mounted — `executionOf` then returns undefined.
   */
  private executionTracker: { executionOf(taskId: string): ExecutionInfo | undefined } | undefined

  /**
   * @param deps - provider, approval seam, and validated deployment config.
   */
  constructor(private readonly deps: TaskboardDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID())
  }

  /**
   * Inject the workspace resolver (optional seam; call from `apply()` inside
   * `ctx.inject(['workspaceRegistry'], …)` so headless boots stay unaffected).
   * @param resolver - resolves a session cwd to its owning workspace id.
   */
  setWorkspaceResolver(resolver: (cwd: string | undefined) => Promise<string | undefined>): void {
    this.workspaceResolver = resolver
  }

  /**
   * Resolve a session cwd to a workspace id through the injected seam.
   * @param cwd - the session's absolute working directory, if any.
   * @returns the owning workspace id, or `undefined` when the seam is absent
   * or the cwd is unowned.
   */
  async workspaceIdOfCwd(cwd: string | undefined): Promise<string | undefined> {
    return this.workspaceResolver?.(cwd)
  }

  /**
   * Inject the execution tracker (v1.1 A2). The auto-claim driver calls this
   * on mount, so the panel can show which subagent is running a task.
   * @param tracker - resolves a task id to its live execution, if any.
   */
  setExecutionTracker(tracker: { executionOf(taskId: string): ExecutionInfo | undefined }): void {
    this.executionTracker = tracker
  }

  /**
   * Read one task's live execution (v1.1 A2).
   * @param ref - short key or full id.
   * @returns the running subagent id and start time, or `undefined` when the
   * task is not dispatched or the driver row is not mounted.
   */
  executionOf(ref: TaskRef): ExecutionInfo | undefined {
    const task = this.require(ref)
    return this.executionTracker?.executionOf(task.id)
  }

  /**
   * Every task's live execution, for the panel (v1.1 A2).
   * @returns a map of task id to execution info for dispatched tasks.
   */
  executions(): Readonly<Record<string, ExecutionInfo>> {
    const result: Record<string, ExecutionInfo> = {}
    if (this.executionTracker === undefined) return result
    for (const task of this.deps.store.listTasks()) {
      const info = this.executionTracker.executionOf(task.id)
      if (info !== undefined) result[task.id] = info
    }
    return result
  }

  /**
   * Read tasks matching a filter, newest update first.
   * @param filter - AND-combined filter terms.
   * @returns the matching tasks, capped by `filter.limit`.
   */
  list(filter: ListFilter = {}): readonly Task[] {
    const matched = this.deps.store.listTasks().filter((task) => {
      if (filter.projectId !== undefined && task.projectId !== filter.projectId) return false
      if (filter.status !== undefined && task.status !== filter.status) return false
      if (filter.workspaceId !== undefined && task.workspaceId !== filter.workspaceId) return false
      if (filter.label !== undefined && !task.labels.includes(filter.label)) return false
      if (filter.archived === undefined || filter.archived === false) {
        if (task.archivedAt !== null) return false
      } else if (task.archivedAt === null) return false
      return true
    })
    // v1.4 E3: ranked tasks first (ascending sortOrder), then by recency;
    // unranked tasks (sortOrder null) sit after every ranked one.
    matched.sort((a, b) => {
      const ar = a.sortOrder ?? Number.MAX_SAFE_INTEGER
      const br = b.sortOrder ?? Number.MAX_SAFE_INTEGER
      if (ar !== br) return ar - br
      return b.updatedAt - a.updatedAt
    })
    return filter.limit === undefined ? matched : matched.slice(0, filter.limit)
  }

  /**
   * Resolve a task reference — short key (`TB-1`) or full id — to the stored
   * task.
   * @param ref - the reference.
   * @returns the task, or `undefined` when absent.
   */
  resolve(ref: TaskRef): Task | undefined {
    return this.isKey(ref)
      ? this.deps.store.listTasks().find(task => task.key === ref)
      : this.deps.store.getTask(ref as TaskId)
  }

  /**
   * Read one task.
   * @param ref - short key or full id.
   * @returns the task, or `undefined` when absent.
   */
  get(ref: TaskRef): Task | undefined {
    return this.resolve(ref)
  }

  /**
   * Read every project.
   * @returns all stored projects.
   */
  projects(): readonly Project[] {
    return this.deps.store.listProjects()
  }

  /**
   * v1.7 P1: create a project — the board's first-class container. A
   * governance write like archiving: human-initiated, no approval gate.
   * @param name - display name (trimmed, non-empty, unique).
   * @returns the stored project.
   */
  async createProject(name: string): Promise<Project> {
    const trimmed = name.trim()
    if (trimmed === '') throw new TaskboardError('invalid-input', 'project name must not be empty')
    if (this.deps.store.listProjects().some(project => project.name === trimmed)) {
      throw new TaskboardError('invalid-input', `project '${trimmed}' already exists`)
    }
    const at = this.now()
    const project: Project = {
      id: this.newId(),
      name: trimmed,
      description: '',
      workspaceId: null,
      archived: false,
      createdAt: at,
      updatedAt: at,
    }
    await this.deps.store.putProject(project)
    return project
  }

  /**
   * v1.7 P1: rename a project.
   * @param id - the project id.
   * @param name - the new display name.
   * @returns the stored project.
   */
  async renameProject(id: string, name: string): Promise<Project> {
    const trimmed = name.trim()
    if (trimmed === '') throw new TaskboardError('invalid-input', 'project name must not be empty')
    const project = this.deps.store.getProject(id as ProjectId)
    if (project === undefined) throw new TaskboardError('not-found', `project '${id}' does not exist`)
    if (this.deps.store.listProjects().some(other => other.id !== id && other.name === trimmed)) {
      throw new TaskboardError('invalid-input', `project '${trimmed}' already exists`)
    }
    const next: Project = { ...project, name: trimmed, updatedAt: this.now() }
    await this.deps.store.putProject(next)
    return next
  }

  /**
   * v1.7 P1: remove an EMPTY project. A project that still holds tasks is
   * refused (`invalid-input` with the count) — deletion must never orphan
   * tasks silently.
   * @param id - the project id.
   * @returns how many tasks blocked the removal (always 0 on success).
   */
  async removeProject(id: string): Promise<{ removed: boolean, taskCount: number }> {
    const project = this.deps.store.getProject(id as ProjectId)
    if (project === undefined) throw new TaskboardError('not-found', `project '${id}' does not exist`)
    const taskCount = this.deps.store.listTasks().filter(task => task.projectId === id).length
    if (taskCount > 0) {
      throw new TaskboardError('invalid-input', `project '${project.name}' has ${taskCount} task(s); move or delete them first`)
    }
    await this.deps.store.deleteProject(id as ProjectId)
    return { removed: true, taskCount: 0 }
  }

  /**
   * Read the session a task is claimed by.
   * @param ref - short key or full id.
   * @returns the claiming session id, `null` while unclaimed.
   */
  sessionOf(ref: TaskRef): string | null {
    return this.require(ref).claimedBySessionId
  }

  /**
   * Read one task's activity stream, newest first. A removed task's stream
   * stays queryable by its id — the audit trail outlives the card (the panel's
   * route still answers 404 for a removed task, since there is nothing to
   * click).
   * @param ref - short key or full id.
   * @returns the task's activity entries in presentation order.
   */
  activityOf(ref: TaskRef): ActivityStream {
    const task = this.resolve(ref)
    const taskId = task?.id ?? ref
    return [...this.deps.store.listActivity(taskId as TaskId)].sort((a, b) => b.at - a.at)
  }

  /**
   * Create one task behind the approval gate.
   * @param input - the new task's fields.
   * @param actor - who is asking.
   * @returns the stored task.
   */
  async create(input: CreateTaskInput, actor: Actor): Promise<Task> {
    if (input.title.trim() === '') {
      throw new TaskboardError('invalid-input', 'title must not be empty')
    }
    if (this.deps.store.getProject(input.projectId as ProjectId) === undefined) {
      throw new TaskboardError('not-found', `project '${input.projectId}' does not exist`)
    }
    const spec = buildSpec(input)
    // v0.5: `open` means executable, and executable means a complete spec. A
    // create that asks for `open` without acceptance criteria lands in
    // `draft` instead of failing — the model creates tasks far more often than
    // it specs them, so this is a graceful queue, not an error.
    const requested = input.status ?? 'open'
    const status = requested === 'open' && !isSpecComplete(spec) ? 'draft' : requested
    assertBlockedInvariant(status, input.blockedReason)
    // v0.7: resolve dependencies to ids and reject cycles.
    const dependsOn = resolveDependencies(input.dependsOn, ref => this.resolve(ref))
    assertAcyclic('create', dependsOn, ref => this.resolve(ref))
    // Pre-check before disturbing a human; re-checked after approval below,
    // because concurrent writes may land while the question is open.
    this.assertCapacity()

    await this.gate('create', `${input.title}\n\n${preview(input.body ?? '')}`, actor)

    this.assertCapacity()
    const at = this.now()
    const task: Task = {
      id: this.newId(),
      key: await this.allocateKey(),
      projectId: input.projectId,
      title: input.title,
      body: input.body ?? '',
      status,
      priority: input.priority ?? 'normal',
      labels: [...(input.labels ?? [])],
      workspaceId: await this.resolveWorkspaceId(input.workspaceId, input.sessionCwd),
      claimedBySessionId: null,
      origin: actor.kind,
      blockedReason: input.blockedReason ?? null,
      spec,
      evidence: null,
      dependsOn,
      budgetTokens: input.budgetTokens ?? null,
      executor: input.executor ?? 'any',
      dueAt: input.dueAt ?? null,
      notes: input.notes ?? '',
      archivedAt: null,
      contextBudgetTokens: input.contextBudgetTokens ?? null,
      sortOrder: null,
      tokensUsed: null,
      nextTask: input.nextTask === undefined ? null : nextTaskSpecSchema.parse(input.nextTask),
      revision: 0,
      createdAt: at,
      updatedAt: at,
    }
    await this.deps.store.putTask(task)
    await this.recordActivity(task.id as TaskId, 'created', null, status, actor, at)
    return task
  }

  /**
   * Update one task behind the approval gate.
   * @param ref - short key or full id.
   * @param patch - fields to change; omitted fields keep their value.
   * @param actor - who is asking.
   * @returns the stored task after the change.
   */
  async update(ref: TaskRef, patch: UpdateTaskInput, actor: Actor): Promise<Task> {
    const current = this.require(ref)
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.revision) {
      throw new TaskboardError(
        'revision-conflict',
        `task '${ref}' is at revision ${current.revision}, not ${patch.expectedRevision}; reread and retry`,
      )
    }

    const status = patch.status ?? current.status
    // v1.7 P3: entering `done` with a chained spec triggers the chain.
    const chainSpec = status === 'done' && current.nextTask !== null ? current.nextTask : null
    // v1.7 P1: migrating a task validates the target project up front.
    const projectId = patch.projectId === undefined
      ? current.projectId
      : (() => {
        if (this.deps.store.getProject(patch.projectId as ProjectId) === undefined) {
          throw new TaskboardError('not-found', `project '${patch.projectId}' does not exist`)
        }
        return patch.projectId as string
      })()
    // Leaving `blocked` clears the reason — a task can only be blocked for one
    // reason at a time, and the reason belongs to the state it describes.
    const blockedReason = current.status === 'blocked' && status !== 'blocked'
      ? null
      : patch.blockedReason === undefined ? current.blockedReason : patch.blockedReason
    assertBlockedInvariant(status, blockedReason)
    // v0.5 spec: a partial update merges onto the existing spec (or creates
    // one); entering `open` requires a complete spec. The gate is on the
    // TRANSITION only — a task already in `open` without a spec (pre-v0.5) is
    // not blocked from other edits, per the migration note in the plan.
    const spec = mergeSpec(current.spec, patch.spec)
    if (status === 'open' && current.status !== 'open' && !isSpecComplete(spec)) {
      throw new TaskboardError(
        'invalid-input',
        'a task entering open needs a complete spec: at least one acceptance criterion',
      )
    }
    // An explicit workspaceId wins; an unbound task binds to the acting
    // session's workspace when the seam can resolve it (v0.4 W1).
    const workspaceId = patch.workspaceId !== undefined
      ? patch.workspaceId
      : current.workspaceId !== null
        ? current.workspaceId
        : await this.resolveWorkspaceId(undefined, patch.sessionCwd)

    // v0.7: replace dependencies (cycle-checked) and the budget.
    const dependsOn = patch.dependsOn === undefined
      ? current.dependsOn
      : resolveDependencies(patch.dependsOn, ref => this.resolve(ref))
    assertAcyclic(current.id, dependsOn, ref => this.resolve(ref))
    const budgetTokens = patch.budgetTokens === undefined ? current.budgetTokens : patch.budgetTokens
    // v0.9: append, never overwrite — notes are a process log, not a field.
    const notes = patch.note === undefined
      ? current.notes
      : current.notes === '' ? patch.note : `${current.notes}\n${patch.note}`

    let next: Task = {
      ...current,
      title: patch.title ?? current.title,
      body: patch.body ?? current.body,
      status,
      projectId,
      priority: patch.priority ?? current.priority,
      labels: patch.labels === undefined ? current.labels : [...patch.labels],
      workspaceId,
      // Leaving `in_progress` releases the claim — a cancelled, bounced, or
      // completed task is no longer on that session's hands and must be
      // re-claimable (v1.5: the rework loop would otherwise stall forever,
      // because autoClaim refuses an already-claimed task). Symmetric with
      // `blockedReason`, which clears on leaving `blocked`.
      claimedBySessionId: status === 'in_progress'
        ? patch.claimedBySessionId === undefined
          ? current.claimedBySessionId
          : patch.claimedBySessionId
        : patch.claimedBySessionId === undefined ? null : patch.claimedBySessionId,
      blockedReason,
      spec,
      dependsOn,
      budgetTokens,
      executor: patch.executor ?? current.executor,
      dueAt: patch.dueAt === undefined ? current.dueAt : patch.dueAt,
      contextBudgetTokens: patch.contextBudgetTokens === undefined
        ? current.contextBudgetTokens
        : patch.contextBudgetTokens,
      // v1.7 P3: a `done` transition chains the next task and clears the spec
      // (idempotent — a second confirm cannot re-chain).
      nextTask: chainSpec === null
        ? patch.nextTask === undefined
          ? current.nextTask
          : patch.nextTask === null ? null : nextTaskSpecSchema.parse(patch.nextTask)
        : null,
      notes,
      revision: current.revision + 1,
      updatedAt: this.now(),
    }

    // approve-what-you-see: the human decides a concrete before/after, not the
    // abstract verb "update".
    await this.gate('update', `from:\n${describe(current)}\n\nto:\n${describe(next)}`, actor)

    // The stored record may have moved while the question was open; the guard
    // is authoritative at commit time, not at ask time.
    const atCommit = this.require(ref)
    if (atCommit.revision !== current.revision) {
      throw new TaskboardError(
        'revision-conflict',
        `task '${ref}' changed while the approval was open (now revision ${atCommit.revision}); reread and retry`,
      )
    }
    // v1.7 P3: chain the next task (a system write, like autoClaim) BEFORE
    // the parent lands, so the `chained → <key>` note rides the same record.
    if (chainSpec !== null) {
      const child = await this.chainFrom(next, chainSpec, actor)
      const at = this.now()
      next = {
        ...next,
        notes: next.notes === '' ? `chained → ${child.key}` : `${next.notes}\nchained → ${child.key}`,
        updatedAt: at,
      }
    }
    await this.deps.store.putTask(next)
    const change = activityFor(current, next)
    // v0.9: an appended note is its own activity entry, not a plain edit.
    if (patch.note !== undefined) {
      await this.recordActivity(
        next.id as TaskId,
        'noted',
        null,
        preview(patch.note),
        actor,
        next.updatedAt,
      )
    }
    // The note does NOT swallow a concurrent status change: a bounce (status →
    // draft + note) must still leave its `status` entry, or the activity
    // stream cannot reconstruct the timeline (v1.5 S1 relies on it). Only a
    // note-only edit skips the 'edited' branch — there the note IS the edit.
    if (change.action !== 'edited' || patch.note === undefined) {
      await this.recordActivity(next.id as TaskId, change.action, change.from, change.to, actor, next.updatedAt)
    }
    return next
  }

  /**
   * Report a task as blocked, behind the approval gate.
   * @param ref - short key or full id.
   * @param reason - why the agent is stuck; required and stored on the task.
   * @param actor - who is asking (an agent).
   * @returns the stored task after the change.
   */
  async block(ref: TaskRef, reason: string, actor: Actor): Promise<Task> {
    if (reason.trim() === '') {
      throw new TaskboardError('invalid-input', 'blockedReason must not be empty')
    }
    return this.update(ref, { status: 'blocked', blockedReason: reason }, actor)
  }

  /**
   * Automatically claim an open task for a session (the auto-claim driver's
   * write). This is the package's THIRD write that does not pass `gate()` —
   * the deployment opts in by mounting the `taskboard-autoclaim` row, and the
   * claim is a system automation, not a model asking (ARCHITECTURE decision
   * 25). `writePolicy: 'off'` still refuses, because that is a deployment
   * declaring the board read-only.
   *
   * Race safety: claims are serialized on `claimChain`, so two idle agents
   * scanning the same `open` column cannot both claim one task — the loser's
   * read sees the winner's committed write and returns `null`.
   * @param ref - short key or full id.
   * @param sessionId - the claiming session.
   * @param sessionCwd - the claiming session's cwd, when known; an unbound
   * task is bound to the workspace owning it (v0.4 W1).
   * @returns the claimed task, or `null` when the task is not claimable
   * (missing, not `open`, or already claimed).
   */
  async autoClaim(ref: TaskRef, sessionId: string, sessionCwd?: string): Promise<Task | null> {
    const claimed = this.claimChain.then(async () => {
      if (this.deps.writePolicy === 'off') {
        throw new TaskboardError('write-denied', "writePolicy is 'off': auto-claim refused")
      }
      const current = this.resolve(ref)
      if (current === undefined) return null
      if (current.status !== 'open' || current.claimedBySessionId !== null) return null

      const at = this.now()
      const next: Task = {
        ...current,
        status: 'in_progress',
        claimedBySessionId: sessionId,
        workspaceId: current.workspaceId ?? await this.resolveWorkspaceId(undefined, sessionCwd),
        revision: current.revision + 1,
        updatedAt: at,
      }
      await this.deps.store.putTask(next)
      await this.recordActivityLabeled(
        current.id as TaskId,
        'claimed',
        null,
        sessionId,
        { actor: 'agent', actorLabel: sessionId },
        at,
      )
      return next
    })
    // Keep the chain alive even when a claim fails, so one failure does not
    // wedge every later auto-claim.
    this.claimChain = claimed.then(() => null, () => null)
    return claimed
  }

  /**
   * Record that a claimed task has been handed to a background subagent
   * (v0.4 W2). A system automation write like `autoClaim`: the task stays
   * `in_progress`; the activity entry names the subagent's session. Refuses
   * (returns `null`) when the task is no longer claimed by the given session —
   * a human may have taken it over meanwhile.
   * @param ref - short key or full id.
   * @param sessionId - the claiming session.
   * @param subagentId - the background subagent's session id.
   * @returns the task, or `null` when the dispatch does not apply.
   */
  async recordDispatched(ref: TaskRef, sessionId: string, subagentId: string): Promise<Task | null> {
    const recorded = this.claimChain.then(async () => {
      const current = this.resolve(ref)
      if (current === undefined) return null
      if (current.status !== 'in_progress' || current.claimedBySessionId !== sessionId) return null
      await this.recordActivityLabeled(
        current.id as TaskId,
        'dispatched',
        null,
        subagentId,
        { actor: 'agent', actorLabel: sessionId },
        this.now(),
      )
      return current
    })
    this.claimChain = recorded.then(() => null, () => null)
    return recorded
  }

  /**
   * Write back a dispatched task's outcome once the background subagent
   * settles (v0.4 W2, v0.6 evidence). A system automation write like
   * `autoClaim`: `completed` moves the task to `awaiting_human` and stores the
   * structured evidence; `error` moves it to `blocked` with the reason and a
   * diagnosis. The write only applies while the task is still `in_progress`
   * and claimed by the given session — a human who moved it meanwhile is never
   * overwritten.
   * @param ref - short key or full id.
   * @param sessionId - the claiming session.
   * @param outcome - the subagent's terminal outcome, with evidence.
   * @returns the settled task, or `null` when the write does not apply.
   */
  async settleDispatch(
    ref: TaskRef,
    sessionId: string,
    outcome:
      | { kind: 'completed', evidence: TaskEvidence }
      | { kind: 'error', reason: string, diagnosis: string },
    tokensUsed?: number | null,
  ): Promise<Task | null> {
    const settled = this.claimChain.then(async () => {
      const current = this.resolve(ref)
      if (current === undefined) return null
      if (current.status !== 'in_progress' || current.claimedBySessionId !== sessionId) return null

      const at = this.now()
      const next: Task = {
        ...current,
        status: outcome.kind === 'completed' ? 'awaiting_human' : 'blocked',
        blockedReason: outcome.kind === 'error' ? outcome.reason : null,
        evidence: outcome.kind === 'completed'
          ? outcome.evidence
          : {
            criteria: [],
            artifacts: [],
            summary: outcome.diagnosis,
          },
        // v1.5 S2: the driver measures the child's actual usage at settle;
        // absent a measurement the field stays as-is (null for fresh tasks).
        tokensUsed: tokensUsed === undefined ? current.tokensUsed : tokensUsed,
        revision: current.revision + 1,
        updatedAt: at,
      }
      await this.deps.store.putTask(next)
      await this.recordActivityLabeled(
        current.id as TaskId,
        'completed',
        current.status,
        next.status,
        { actor: 'agent', actorLabel: sessionId },
        at,
      )
      return next
    })
    this.claimChain = settled.then(() => null, () => null)
    return settled
  }

  /**
   * Read one task's execution evidence.
   * @param ref - short key or full id.
   * @returns the evidence, or `null` when none has been recorded.
   */
  evidenceOf(ref: TaskRef): TaskEvidence | null {
    return this.require(ref).evidence ?? null
  }

  /**
   * v1.7 P3: auto-create the task chained from a completing parent. A SYSTEM
   * write like `autoClaim` — no approval gate (the deployment's configured
   * automation). Lands in `open` when the chain spec has criteria, else
   * `draft`, in the parent's project and workspace.
   * @param parent - the completing task (its chain spec is already cleared).
   * @param spec - the chained task's spec (from the parent's `nextTask`).
   * @param actor - who confirmed the parent (the chain's origin label).
   * @returns the created child.
   */
  private async chainFrom(parent: Task, spec: NextTaskSpec, actor: Actor): Promise<Task> {
    const at = this.now()
    const child: Task = {
      id: this.newId(),
      key: await this.allocateKey(),
      projectId: parent.projectId,
      title: spec.title,
      body: spec.body,
      status: spec.acceptanceCriteria.length > 0 ? 'open' : 'draft',
      priority: 'normal',
      labels: [],
      workspaceId: parent.workspaceId,
      claimedBySessionId: null,
      origin: actor.kind,
      blockedReason: null,
      spec: {
        acceptanceCriteria: spec.acceptanceCriteria,
        contextRefs: spec.contextRefs,
        definitionOfDone: spec.definitionOfDone,
      },
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
      createdAt: at,
      updatedAt: at,
    }
    await this.deps.store.putTask(child)
    await this.recordActivity(child.id as TaskId, 'created', null, child.status, actor, at)
    return child
  }

  /**
   * v1.8 M3: recover a stale claim — a task stuck in `in_progress` whose
   * claiming session is gone (or idle with nothing dispatched) is released
   * back to `open` with a recovery note, so it can be re-claimed and
   * re-dispatched (the notes carry the context). A SYSTEM write like
   * `markForRetry`: refuses only under `writePolicy: 'off'`.
   * @param ref - short key or full id.
   * @param driver - the recovery driver's label.
   * @param dwellMin - how long the claim had been held.
   * @returns the stored task.
   */
  async recoverStaleClaim(ref: TaskRef, driver: string, dwellMin: number): Promise<Task> {
    const current = this.require(ref)
    if (this.deps.writePolicy === 'off') {
      throw new TaskboardError('write-denied', "writePolicy is 'off': stale recovery refused")
    }
    const note = `recovered: session lost (claimed ${dwellMin} min ago)`
    const at = this.now()
    const next: Task = {
      ...current,
      status: 'open',
      blockedReason: null,
      claimedBySessionId: null,
      notes: current.notes === '' ? note : `${current.notes}\n${note}`,
      revision: current.revision + 1,
      updatedAt: at,
    }
    await this.deps.store.putTask(next)
    await this.recordActivityLabeled(
      current.id as TaskId,
      'noted',
      null,
      note,
      { actor: 'agent', actorLabel: driver },
      at,
    )
    return next
  }

  /**
   * v1.6 C3: a liveness beat for a dispatched task — appends a `noted`
   * activity entry (`heartbeat: running <n> min`) WITHOUT touching the task,
   * so the activity stream proves the execution is alive between settle
   * points. A SYSTEM write (the driver's configured automation), like
   * `markForRetry`.
   * @param ref - short key or full id.
   * @param driver - the driver's session id (the actor label).
   */
  async heartbeat(ref: TaskRef, driver: string): Promise<void> {
    const task = this.require(ref)
    const at = this.now()
    const minutes = Math.max(1, Math.round((at - task.updatedAt) / 60_000))
    await this.recordActivityLabeled(
      task.id as TaskId,
      'noted',
      null,
      `heartbeat: running ${minutes} min`,
      { actor: 'agent', actorLabel: driver },
      at,
    )
  }

  /**
   * v1.6 C2: send a failed dispatch back to `open` for one more auto-claim —
   * bounded auto-retry. A SYSTEM write like `autoClaim` (it is the deployment's
   * configured automation, not the model asking): it refuses only under
   * `writePolicy: 'off'`, never asks a human per attempt. The retry is
   * recorded both in the notes (`retry <attempt>/<max>`, which the next
   * dispatch prompt quotes) and as a `noted` activity entry, so attempts are
   * auditable and countable. The claim is released (leaving in_progress).
   * @param ref - short key or full id.
   * @param attempt - the attempt number this retry starts (1-based).
   * @param max - the configured retry ceiling (for the note).
   * @returns the stored task.
   */
  async markForRetry(ref: TaskRef, attempt: number, max: number, driver: string): Promise<Task> {
    const current = this.require(ref)
    if (this.deps.writePolicy === 'off') {
      throw new TaskboardError('write-denied', "writePolicy is 'off': retry refused")
    }
    const note = `retry ${attempt}/${max}`
    const at = this.now()
    const next: Task = {
      ...current,
      status: 'open',
      blockedReason: null,
      claimedBySessionId: null,
      notes: current.notes === '' ? note : `${current.notes}\n${note}`,
      revision: current.revision + 1,
      updatedAt: at,
    }
    await this.deps.store.putTask(next)
    await this.recordActivityLabeled(
      current.id as TaskId,
      'noted',
      null,
      note,
      { actor: 'agent', actorLabel: driver },
      at,
    )
    return next
  }

  /**
   * Soft-archive a done task (v1.2 C1): it leaves the active board view but is
   * never deleted. A governance write, not a data change — no approval gate
   * (archiving is reversible and touches only `archivedAt`).
   * @param ref - short key or full id.
   * @param archived - `true` archives, `false` restores.
   * @returns the stored task.
   */
  async archive(ref: TaskRef, archived: boolean): Promise<Task> {
    const current = this.require(ref)
    if (archived && current.status !== 'done') {
      throw new TaskboardError('invalid-input', 'only done tasks can be archived')
    }
    const at = this.now()
    const next: Task = {
      ...current,
      archivedAt: archived ? at : null,
      revision: current.revision + 1,
      updatedAt: at,
    }
    await this.deps.store.putTask(next)
    await this.recordActivity(current.id as TaskId, 'edited', null, null, { kind: 'human', via: 'panel' }, at)
    return next
  }

  /**
   * Archive every done task (v1.2 C1).
   * @returns how many tasks were archived.
   */
  async archiveAllDone(): Promise<number> {
    const at = this.now()
    let count = 0
    for (const task of this.deps.store.listTasks()) {
      if (task.status !== 'done' || task.archivedAt !== null) continue
      await this.deps.store.putTask({ ...task, archivedAt: at, revision: task.revision + 1, updatedAt: at })
      count += 1
    }
    return count
  }

  /**
   * Pin one column's manual order (v1.4 E3): the given task refs become that
   * column's `sortOrder` 0..n-1, and every other task of the same column loses
   * its rank (`sortOrder = null`) — a dragged column's order is authoritative.
   *
   * A governance write like archiving: human-initiated, reversible (set the
   * same column's order again, or reorder an empty column is a no-op), touches
   * only `sortOrder`, so it needs no approval gate.
   * @param refs - the column's full ordered list (every task of the column).
   * @returns how many tasks were rewritten.
   */
  async reorder(refs: readonly TaskRef[]): Promise<number> {
    if (refs.length === 0) throw new TaskboardError('invalid-input', 'reorder needs at least one task')
    const ids = refs.map(ref => this.resolve(ref)?.id)
    if (ids.some(id => id === undefined)) {
      throw new TaskboardError('not-found', 'a reordered task does not exist')
    }
    const unique = new Set(ids as string[])
    if (unique.size !== ids.length) {
      throw new TaskboardError('invalid-input', 'reorder carries a duplicate task')
    }
    const tasks = (ids as string[]).map(id => this.deps.store.getTask(id as TaskId))
    const first = tasks[0]
    if (first === undefined) throw new TaskboardError('not-found', 'a reordered task does not exist')
    // The batch must cover the WHOLE column — partial reorders would silently
    // demote every task left out, so refuse instead. The "column" is the
    // status (and archived state), not status+project: the panel's column is
    // one status, and a project filter hides other projects' ids from it.
    const column = this.deps.store.listTasks().filter(task =>
      task.status === first.status
      && (task.archivedAt === null) === (first.archivedAt === null))
    if (column.length !== unique.size) {
      throw new TaskboardError(
        'invalid-input',
        `reorder must name every task of the column (${unique.size} given, ${column.length} in column)`,
      )
    }

    const at = this.now()
    const ranked = new Set(ids as string[])
    let written = 0
    for (const task of column) {
      const next: Task = {
        ...task,
        sortOrder: ranked.has(task.id) ? (ids as string[]).indexOf(task.id) : null,
        revision: task.revision + 1,
        updatedAt: at,
      }
      await this.deps.store.putTask(next)
      written += 1
    }
    return written
  }

  /**
   * Whether a task's dependencies are all satisfied (v0.7 W2): every
   * `dependsOn` task is `done` or `cancelled`. A missing dependency counts as
   * not ready (deleting a prerequisite must not crash the dependent — the
   * panel prompts to clear it instead).
   * @param ref - short key or full id.
   * @returns `true` when the task may be claimed.
   */
  isReady(ref: TaskRef): boolean {
    const task = this.require(ref)
    return task.dependsOn.every(dependencyId => {
      const dependency = this.deps.store.getTask(dependencyId as TaskId)
      return dependency !== undefined
        && (dependency.status === 'done' || dependency.status === 'cancelled')
    })
  }

  /**
   * Retrieve relevant completed tasks as experience cards (ROADMAP L5, v0.8):
   * done tasks carry the full knowledge of one execution — what was to be done
   * (spec criteria), what was produced and concluded (evidence) — and can feed
   * the next task instead of forcing a fresh exploration. Tasks without a
   * summary are excluded (no content, no injection value).
   * @param filter - narrowing terms; every field is an AND term.
   * @returns done-task experience cards, newest completion first, capped by
   * `limit` (default 5).
   */
  relatedExperience(filter: {
    projectId?: string
    workspaceId?: string | null
    label?: string
    limit?: number
  } = {}): readonly ExperienceCard[] {
    const limit = filter.limit ?? 5
    return this.deps.store.listTasks()
      .filter(task => task.status === 'done')
      .filter(task => task.evidence !== null && task.evidence.summary !== '')
      .filter(task => filter.projectId === undefined || task.projectId === filter.projectId)
      .filter(task => filter.workspaceId === undefined || task.workspaceId === filter.workspaceId)
      .filter(task => filter.label === undefined || task.labels.includes(filter.label))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map(task => ({
        key: task.key ?? task.id,
        title: task.title,
        criteria: task.spec?.acceptanceCriteria ?? [],
        artifacts: task.evidence?.artifacts ?? [],
        summary: task.evidence?.summary ?? '',
      }))
  }

  /**
   * Board-level statistics (v1.5 S1): ratios, averages, a 7-day trend, stuck
   * detection, and cost — ALL derived from the activity stream + the current
   * board, no extra instrumentation. See {@link BoardStats}.
   *
   * Status dwell is reconstructed by walking each task's activity in
   * chronological order: `created`/`status`/`completed`/`blocked` entries
   * enter the status in `to` (a `claimed` entry enters `in_progress` — the
   * claim path records no `status` entry), and a segment closes at the next
   * enter. The activity retention cap means the earliest segments of very old
   * tasks may be missing; the averages then cover the available data.
   * @returns the statistics payload.
   */
  stats(): BoardStats {
    const now = this.now()
    const MIN = 60_000
    const threshold = {
      in_progress: this.deps.statsStuckMinutes?.in_progress ?? 120,
      awaiting_human: this.deps.statsStuckMinutes?.awaiting_human ?? 1440,
      blocked: this.deps.statsStuckMinutes?.blocked ?? 720,
    }
    const tasks = this.deps.store.listTasks()
    const total = tasks.length

    const ratios = { completion: 0, bounces: 0, agentSuccess: 0, agentError: 0, overdue: 0, active: 0 }
    const failureModes: Record<string, number> = {}
    const byAgent = new Map<string, {
      tasks: number, success: number, rework: number, cycleTotal: number, cycleCount: number, tokens: number,
    }>()
    const leadTimes: number[] = []
    const cycleTimes: number[] = []
    const awaitingDwells: number[] = []
    const blockedDwells: number[] = []
    const createdByDay = new Map<string, number>()
    const doneByDay = new Map<string, number>()
    const stuck: StuckTask[] = []
    const oldest: OldestTask[] = []
    let tokensTotal = 0
    let tokensTasks = 0
    let overBudget = 0

    const dayKey = (at: number): string => {
      const d = new Date(at)
      return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    }
    const trendDays: string[] = []
    for (let i = 6; i >= 0; i -= 1) trendDays.push(dayKey(now - i * 24 * 60 * MIN))
    const mean = (xs: number[]): StatsValue =>
      xs.length === 0 ? null : Math.round(xs.reduce((sum, value) => sum + value, 0) / xs.length)

    for (const task of tasks) {
      const done = task.status === 'done'
      if (done) ratios.completion += 1
      const active = task.archivedAt === null && !done && task.status !== 'cancelled'
      if (active) {
        ratios.active += 1
        if (task.dueAt !== null && task.dueAt < now) ratios.overdue += 1
        oldest.push({
          key: task.key ?? task.id,
          title: task.title,
          status: task.status,
          ageMin: Math.max(0, Math.round((now - task.createdAt) / MIN)),
        })
      }
      if (task.tokensUsed !== null) {
        tokensTotal += task.tokensUsed
        tokensTasks += 1
        if (task.budgetTokens !== null && task.tokensUsed > task.budgetTokens) overBudget += 1
      }

      const entries = this.deps.store.listActivity(task.id as TaskId)
      const dwell = this.dwellByStatus(entries, now)

      // v1.9 G1: classify currently-blocked tasks by their settle reason.
      if (task.status === 'blocked' && task.blockedReason !== null) {
        const mode = TaskboardService.classifyFailure(task.blockedReason)
        failureModes[mode] = (failureModes[mode] ?? 0) + 1
      }

      // v1.9 G2: attribute to the claiming session (the latest claim).
      const claimed = [...entries].filter(entry => entry.action === 'claimed')
        .sort((a, b) => b.at - a.at)[0]?.actorLabel
      if (claimed !== undefined) {
        const entry = byAgent.get(claimed) ?? {
          tasks: 0, success: 0, rework: 0, cycleTotal: 0, cycleCount: 0, tokens: 0,
        }
        entry.tasks += 1
        if (done || task.status === 'awaiting_human') entry.success += 1
        if (dwell.in_progress !== undefined) {
          entry.cycleTotal += dwell.in_progress
          entry.cycleCount += 1
        }
        entry.tokens += task.tokensUsed ?? 0
        byAgent.set(claimed, entry)
      }

      if (dwell.in_progress !== undefined && done) cycleTimes.push(dwell.in_progress / MIN)
      if (dwell.awaiting_human !== undefined) awaitingDwells.push(dwell.awaiting_human / MIN)
      if (dwell.blocked !== undefined) blockedDwells.push(dwell.blocked / MIN)
      const doneEnter = [...entries]
        .filter(entry => entry.action === 'status' && entry.to === 'done')
        .sort((a, b) => a.at - b.at)[0]?.at
      if (doneEnter !== undefined) leadTimes.push((doneEnter - task.createdAt) / MIN)

      for (const entry of entries) {
        if (entry.action === 'status' && entry.from === 'awaiting_human' && entry.to === 'draft') {
          ratios.bounces += 1
        }
        if (entry.action === 'completed' && entry.to === 'awaiting_human') ratios.agentSuccess += 1
        if (entry.action === 'completed' && entry.to === 'blocked') ratios.agentError += 1
        const day = dayKey(entry.at)
        if (entry.action === 'created') createdByDay.set(day, (createdByDay.get(day) ?? 0) + 1)
        if (entry.action === 'status' && entry.to === 'done') doneByDay.set(day, (doneByDay.get(day) ?? 0) + 1)
      }

      const statusThreshold = threshold[task.status as keyof typeof threshold]
      const dwellHere = dwell[task.status]
      if (statusThreshold !== undefined && task.archivedAt === null
        && dwellHere !== undefined && dwellHere >= statusThreshold * MIN) {
        stuck.push({
          key: task.key ?? task.id,
          title: task.title,
          status: task.status,
          dwellMin: Math.round(dwellHere / MIN),
          thresholdMin: statusThreshold,
        })
      }
    }

    oldest.sort((a, b) => a.ageMin - b.ageMin)
    const settles = ratios.agentSuccess + ratios.agentError
    return {
      ratios: {
        completionRate: total === 0 ? null : Math.round((ratios.completion / total) * 1000) / 10,
        reworkRate: ratios.completion === 0
          ? null
          : Math.round((ratios.bounces / ratios.completion) * 1000) / 10,
        agentSuccessRate: settles === 0
          ? null
          : Math.round((ratios.agentSuccess / settles) * 1000) / 10,
        overdueRate: ratios.active === 0
          ? null
          : Math.round((ratios.overdue / ratios.active) * 1000) / 10,
      },
      averages: {
        avgLeadTimeMin: mean(leadTimes),
        avgCycleTimeMin: mean(cycleTimes),
        avgAwaitingHumanMin: mean(awaitingDwells),
        avgBlockedMin: mean(blockedDwells),
      },
      trend: trendDays.map(day => ({
        day,
        created: createdByDay.get(day) ?? 0,
        completed: doneByDay.get(day) ?? 0,
      })),
      failureModes,
      // v1.9 G3: end-of-day per-status counts over the last 14 days.
      cfd: (() => {
        const days: string[] = []
        for (let i = 13; i >= 0; i -= 1) days.push(dayKey(now - i * 24 * 60 * MIN))
        const todayStart = new Date(now)
        todayStart.setHours(0, 0, 0, 0)
        const cfdMap: Record<string, Record<string, number>> = {}
        for (const task of tasks) {
          const segments = this.statusSegments(
            this.deps.store.listActivity(task.id as TaskId), now,
          )
          if (segments.length === 0) continue
          for (let i = 0; i < days.length; i += 1) {
            const day = days[i]
            if (day === undefined) continue
            // End-of-day boundary: today counts at the present moment (its
            // end is in the future); earlier days at midnight.
            const dayStart = todayStart.getTime() + (i - (days.length - 1)) * 24 * 60 * MIN
            const end = i === days.length - 1 ? now : dayStart + 24 * 60 * MIN
            const segment = segments.find(seg => seg.start <= end && end <= seg.end)
            if (segment === undefined) continue
            const bucket = cfdMap[day] ?? (cfdMap[day] = {})
            bucket[segment.status] = ((bucket[segment.status] ?? 0) as number) + 1
          }
        }
        return days.map(day => ({ day, counts: cfdMap[day] ?? {} }))
      })(),
      byAgent: [...byAgent.entries()].map(([agent, entry]) => ({
        agent,
        tasks: entry.tasks,
        success: entry.success,
        rework: entry.rework,
        avgCycleMin: entry.cycleCount === 0
          ? null
          : Math.round(entry.cycleTotal / entry.cycleCount / MIN),
        tokens: entry.tokens,
      })).sort((a, b) => b.tasks - a.tasks),
      stuck: stuck.sort((a, b) => b.dwellMin - a.dwellMin),
      oldest: oldest.slice(0, 5),
      cost: tokensTasks === 0
        ? { totalTokens: null, avgTokensPerTask: null, overBudgetCount: null }
        : {
          totalTokens: tokensTotal,
          avgTokensPerTask: Math.round(tokensTotal / tokensTasks),
          overBudgetCount: overBudget,
        },
    }
  }

  /**
   * v1.5 S1: dwell in each status, in ms, reconstructed from one task's
   * activity stream. See {@link TaskboardService.stats} for the rules.
   */
  private dwellByStatus(entries: readonly Activity[], now: number): Record<string, number> {
    const dwell: Record<string, number> = {}
    for (const segment of this.statusSegments(entries, now)) {
      dwell[segment.status] = (dwell[segment.status] ?? 0) + (segment.end - segment.start)
    }
    return dwell
  }

  /**
   * v1.9 G1: classify a settle-failure reason into a diagnostic bucket.
   */
  private static classifyFailure(reason: string): string {
    if (reason.includes('execution timed out') || reason.includes('timed out')) return 'timeout'
    if (reason.includes('token budget') || reason.includes('over budget') || reason.includes('context budget')) return 'budget'
    if (reason.includes('without a structured report')) return 'no-report'
    if (reason.includes('failed to run')) return 'infra'
    return 'other'
  }

  /**
   * v1.9 G3: one task's status timeline as half-open segments
   * `[start, end)`, reconstructed from its activity stream (the same walk
   * `dwellByStatus` uses, but segment-preserving for per-day queries).
   */
  private statusSegments(
    entries: readonly Activity[], now: number,
  ): Array<{ status: TaskStatus, start: number, end: number }> {
    const segments: Array<{ status: TaskStatus, start: number, end: number }> = []
    const ordered = [...entries].sort((a, b) => a.at - b.at)
    let current: TaskStatus | undefined
    let start = 0
    for (const entry of ordered) {
      const entered = this.enteredStatus(entry)
      if (entered === undefined) continue
      if (current === undefined) { current = entered; start = entry.at; continue }
      if (entered !== current) {
        segments.push({ status: current, start, end: entry.at })
        current = entered
        start = entry.at
      }
    }
    if (current !== undefined) segments.push({ status: current, start, end: now })
    return segments
  }

  /** The status a task enters at one activity entry, or `undefined`. */
  private enteredStatus(entry: Activity): TaskStatus | undefined {
    if (entry.action === 'claimed') return 'in_progress'
    if (entry.action === 'status' || entry.action === 'created' || entry.action === 'completed') {
      return TASK_STATUSES.includes(entry.to as TaskStatus) ? entry.to as TaskStatus : undefined
    }
    if (entry.action === 'blocked') {
      return TASK_STATUSES.includes(entry.to as TaskStatus) ? entry.to as TaskStatus : 'blocked'
    }
    return undefined
  }

  /**
   * Remove one task behind the approval gate.
   * @param ref - short key or full id.
   * @param actor - who is asking.
   * @returns nothing; a missing task raises `not-found`.
   */
  async remove(ref: TaskRef, actor: Actor): Promise<void> {
    const current = this.require(ref)
    await this.gate('remove', describe(current), actor)
    await this.deps.store.deleteTask(current.id as TaskId)
    await this.recordActivity(current.id as TaskId, 'removed', current.status, null, actor, this.now())
  }

  /**
   * Read-only backup of the whole board. No approval and no medium write: this
   * is the escape hatch for the storage layer's no-migration stance, so it must
   * stay usable even when a board can no longer be opened by a newer build.
   * @returns the export document.
   */
  exportAll(): ExportDocument {
    return {
      schema: EXPORT_SCHEMA,
      domainVersion: DOMAIN_VERSION,
      exportedAt: this.now(),
      projects: [...this.deps.store.listProjects()],
      tasks: [...this.deps.store.listTasks()],
    }
  }

  /**
   * Restore an export document behind a single approval for the whole batch.
   * Records keep their ids so a restore is idempotent against the same medium;
   * tasks without a short key (v0.1 exports) get one allocated from the
   * counter, so a restored board is fully keyed.
   * @param raw - the parsed JSON document.
   * @param actor - who is asking.
   * @returns how many records were written.
   */
  async importDocument(raw: unknown, actor: Actor): Promise<{ projects: number, tasks: number }> {
    const parsed = exportDocumentSchema.safeParse(raw)
    if (!parsed.success) {
      throw new TaskboardError(
        'unsupported-document',
        `not a ${EXPORT_SCHEMA} document: ${parsed.error.message}`,
      )
    }
    const doc = parsed.data
    const total = doc.projects.length + doc.tasks.length
    if (total > MAX_IMPORT_RECORDS) {
      throw new TaskboardError(
        'limit-exceeded',
        `import carries ${total} records, over the ${MAX_IMPORT_RECORDS} ceiling`,
      )
    }

    await this.gate(
      'import',
      `${doc.projects.length} project(s) and ${doc.tasks.length} task(s) from a `
      + `${new Date(doc.exportedAt).toISOString()} export (domain v${doc.domainVersion})`,
      actor,
    )

    for (const project of doc.projects) await this.deps.store.putProject(project)
    for (const task of doc.tasks) {
      const keyed = task.key === undefined ? { ...task, key: await this.allocateKey() } : task
      await this.deps.store.putTask(keyed)
    }
    return { projects: doc.projects.length, tasks: doc.tasks.length }
  }

  /**
   * The single write gate. Every mutating method above calls it before touching
   * the medium; nothing else in this package may write.
   * @param action - verb recorded in the approval reason.
   * @param payload - the complete change, so a human approves what they see.
   * @param actor - who is asking.
   * @returns nothing; a refusal raises `write-denied`.
   */
  private async gate(action: string, payload: string, actor: Actor): Promise<void> {
    const policy = this.deps.writePolicy
    if (policy === 'off') {
      throw new TaskboardError('write-denied', `writePolicy is 'off': ${action} refused`)
    }
    // A human initiated this write, so there is no second party to ask. The
    // gate exists to put a human between the MODEL and durability, not between
    // a human and their own click.
    if (actor.kind === 'human') return
    if (policy === 'auto') return
    if (actor.agent === undefined) {
      throw new TaskboardError(
        'write-denied',
        `writePolicy is 'ask' but this caller has no agent to ask through; `
        + `run the change through a task tool, or set writePolicy to 'auto' for unattended writes`,
      )
    }

    let outcome: ApprovalOutcome
    try {
      outcome = await this.deps.approval.request({
        agent: actor.agent,
        toolName: APPROVAL_TOOL_NAME,
        reason: `${APPROVAL_PREFIX} ${action}\n${payload}`,
        signal: actor.signal,
      })
    } catch (error) {
      // The approval seam requires an open turn so its asked/decided audit pair
      // stays inside one. A command dispatched between turns lands here; that is
      // a refusal, never a silent allow.
      throw new TaskboardError(
        'write-denied',
        `approval unavailable for ${action} (an approval must be asked inside an open turn)`,
        { cause: error },
      )
    }
    if (outcome !== 'allowed-once') {
      throw new TaskboardError('write-denied', `${action} was ${outcome}`)
    }
  }

  /**
   * One-time short-id backfill for records written before keys existed (v0.1
   * mediums). Numbers records in `createdAt` order, then advances the counter
   * past them. Idempotent: on later mounts every record already has a key and
   * nothing is written. This is the package's SECOND write that does not pass
   * `gate()` — a plugin-owned bootstrap write, same standing as the seed
   * project (ARCHITECTURE decision 19), so it must not be callable by users or
   * the model through any other path.
   * @returns how many records were keyed.
   */
  async backfillKeys(): Promise<number> {
    const keyless = this.deps.store.listTasks()
      .filter(task => task.key === undefined)
      .sort((a, b) => a.createdAt - b.createdAt)
    if (keyless.length === 0) return 0
    let next = this.deps.store.getGlobal().nextTaskNumber
    for (const task of keyless) {
      await this.deps.store.putTask({ ...task, key: `${this.deps.keyPrefix}-${next++}` })
    }
    await this.deps.store.setGlobal({ nextTaskNumber: next })
    return keyless.length
  }

  /**
   * Reserve the next short-id number and persist the advanced counter. The
   * reservation precedes the task write, so a failed write burns a number —
   * keys are never reused, gaps are natural. Allocation is serialized on
   * `keyChain` so two parallel creates cannot read the same counter value.
   * @returns the short key (`TB-7`, per the configured prefix).
   */
  private async allocateKey(): Promise<string> {
    const allocated = this.keyChain.then(async () => {
      const current = this.deps.store.getGlobal().nextTaskNumber
      await this.deps.store.setGlobal({ nextTaskNumber: current + 1 })
      return current
    })
    // Keep the chain alive even when an allocation fails, so one failure does
    // not wedge every later create.
    this.keyChain = allocated.then(() => 0, () => 0)
    return allocated.then(number => `${this.deps.keyPrefix}-${number}`)
  }

  /**
   * Append one activity entry for a successful write, then enforce retention.
   * Called only after the write is durable, so a refused or failed write never
   * leaves a trace in the stream (the refusal itself lives in the session log's
   * `approval/asked` + `approval/decided` pair).
   */
  private async recordActivity(
    taskId: TaskId,
    action: ActivityAction,
    from: string | null,
    to: string | null,
    actor: Actor,
    at: number,
  ): Promise<void> {
    await this.recordActivityLabeled(taskId, action, from, to, actorFields(actor), at)
  }

  /** `recordActivity` with the who/label resolved by the caller (automation paths). */
  private async recordActivityLabeled(
    taskId: TaskId,
    action: ActivityAction,
    from: string | null,
    to: string | null,
    who: { actor: 'human' | 'agent', actorLabel: string },
    at: number,
  ): Promise<void> {
    const entry: Activity = {
      id: this.newId(),
      taskId,
      at,
      ...who,
      action,
      from,
      to,
    }
    await this.deps.store.putActivity(entry)
    await this.trimActivity(taskId)
  }

  /** Drop the oldest entries past `activityRetentionPerTask`. */
  private async trimActivity(taskId: TaskId): Promise<void> {
    const cap = this.deps.activityRetentionPerTask
    const entries = this.deps.store.listActivity(taskId)
    const excess = entries.length - cap
    if (excess <= 0) return
    for (const entry of entries.slice(0, excess)) {
      await this.deps.store.deleteActivity(entry.id as ActivityId)
    }
  }

  /**
   * Resolve a task's workspace: an explicit value wins; otherwise an unbound
   * task is bound to the workspace owning the acting session's cwd when the
   * optional seam is available; otherwise it stays board-global (`null`).
   */
  private async resolveWorkspaceId(
    explicit: string | null | undefined,
    sessionCwd: string | undefined,
  ): Promise<string | null> {
    if (explicit !== undefined) return explicit
    if (sessionCwd === undefined || this.workspaceResolver === undefined) return null
    return (await this.workspaceResolver(sessionCwd)) ?? null
  }

  /** Read one task by reference or raise `not-found`. */
  private require(ref: TaskRef): Task {
    const task = this.resolve(ref)
    if (task === undefined) throw new TaskboardError('not-found', `task '${ref}' does not exist`)
    return task
  }

  /** Whether a reference looks like a short key rather than a full id. */
  private isKey(ref: string): boolean {
    const prefix = this.deps.keyPrefix
    return prefix !== '' && ref.startsWith(`${prefix}-`) && /^\d+$/.test(ref.slice(prefix.length + 1))
  }

  /** Refuse a create that would cross the configured ceiling. */
  private assertCapacity(): void {
    const used = this.deps.store.listTasks().length
    if (used >= this.deps.maxTasks) {
      throw new TaskboardError(
        'limit-exceeded',
        `board holds ${used} tasks, at the configured maxTasks (${this.deps.maxTasks}); `
        + 'close or remove tasks, or raise maxTasks',
      )
    }
  }
}

/**
 * Classify a status transition for the activity stream. A move into `blocked`
 * is its own action (the reason lives on the task); any other status change is
 * `status`; a fresh claim is `claimed`; anything else is a plain edit.
 */
function activityFor(
  current: Task,
  next: Task,
): { action: ActivityAction, from: string | null, to: string | null } {
  if (current.status !== next.status) {
    return next.status === 'blocked'
      ? { action: 'blocked', from: current.status, to: 'blocked' }
      : { action: 'status', from: current.status, to: next.status }
  }
  if (current.claimedBySessionId !== next.claimedBySessionId && next.claimedBySessionId !== null) {
    return { action: 'claimed', from: null, to: next.claimedBySessionId }
  }
  return { action: 'edited', from: null, to: null }
}

/** Project an actor onto the activity stream's who/label fields. */
function actorFields(actor: Actor): { actor: 'human' | 'agent', actorLabel: string } {
  return actor.kind === 'human'
    ? { actor: 'human', actorLabel: actor.via }
    : { actor: 'agent', actorLabel: actor.agent?.session?.id ?? 'agent' }
}

/**
 * Whether a spec is executable (v0.5): present and carrying at least one
 * acceptance criterion. `contextRefs` are a soft hint — verification-style
 * tasks may legitimately have no file references — so they are not part of
 * the hard gate; the panel surfaces their absence as a suggestion.
 * @param spec - the task's spec, or `null` when unspecified.
 * @returns `true` when the task may enter `open`.
 */
export function isSpecComplete(spec: TaskSpec | null): boolean {
  return spec !== null && spec.acceptanceCriteria.length > 0
}

/** Build a spec block from create input; `null` when no spec field was given. */
function buildSpec(input: CreateTaskInput): TaskSpec | null {
  if (
    input.acceptanceCriteria === undefined
    && input.contextRefs === undefined
    && input.definitionOfDone === undefined
  ) return null
  return {
    acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
    contextRefs: [...(input.contextRefs ?? [])],
    definitionOfDone: input.definitionOfDone ?? '',
  }
}

/** Merge a partial spec update onto the existing spec (or create one). */
function mergeSpec(current: TaskSpec | null, patch: UpdateTaskInput['spec']): TaskSpec | null {
  if (patch === undefined) return current
  return {
    acceptanceCriteria: patch.acceptanceCriteria === undefined
      ? current?.acceptanceCriteria ?? []
      : [...patch.acceptanceCriteria],
    contextRefs: patch.contextRefs === undefined
      ? current?.contextRefs ?? []
      : [...patch.contextRefs],
    definitionOfDone: patch.definitionOfDone === undefined
      ? current?.definitionOfDone ?? ''
      : patch.definitionOfDone,
  }
}

/**
 * Resolve a task's dependency references (keys or ids) to canonical ids.
 * Unresolvable references are KEPT as-is: a dependency may have been deleted,
 * and the dependent's readiness check treats a missing dependency as not-ready
 * (the panel prompts to clear it) rather than wedging the board.
 */
function resolveDependencies(
  refs: readonly string[] | undefined,
  resolve: (ref: TaskRef) => Task | undefined,
): string[] {
  if (refs === undefined) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const ref of refs) {
    const task = resolve(ref)
    const canonical = task?.id ?? ref
    if (!seen.has(canonical)) {
      seen.add(canonical)
      result.push(canonical)
    }
  }
  return result
}

/**
 * Reject a dependency cycle: walking `dependsOn` from the task must never
 * revisit the task itself. The walk is bounded by the board's task count.
 */
function assertAcyclic(
  owner: TaskRef,
  dependsOn: readonly string[],
  resolve: (ref: TaskRef) => Task | undefined,
): void {
  const stack = [...dependsOn]
  const visited = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (id === owner) {
      throw new TaskboardError('invalid-input', `task '${owner}' would depend on itself (cycle)`)
    }
    if (visited.has(id)) continue
    visited.add(id)
    const task = resolve(id)
    if (task !== undefined) stack.push(...task.dependsOn)
  }
}

/** The invariant that ties the status to its reason. */
function assertBlockedInvariant(status: TaskStatus, reason: string | null | undefined): void {
  if (status === 'blocked' && (reason === undefined || reason === null || reason.trim() === '')) {
    throw new TaskboardError(
      'invalid-input',
      'a task entering blocked must carry a non-empty blockedReason',
    )
  }
}

/** One-paragraph rendering of a task for an approval payload. */
function describe(task: Task): string {
  return [
    `title: ${task.key === undefined ? task.title : `${task.key} ${task.title}`}`,
    `status: ${task.status}  priority: ${task.priority}`,
    task.labels.length > 0 ? `labels: ${task.labels.join(', ')}` : undefined,
    task.blockedReason === null ? undefined : `blocked: ${preview(task.blockedReason)}`,
    task.spec === null || task.spec.acceptanceCriteria.length === 0
      ? undefined
      : `criteria: ${task.spec.acceptanceCriteria.join('; ')}`,
    task.body === '' ? undefined : `body: ${preview(task.body)}`,
  ].filter(line => line !== undefined).join('\n')
}

/** Bound a free-text field quoted into an approval payload. */
function preview(text: string): string {
  return text.length <= APPROVAL_BODY_PREVIEW_CHARS
    ? text
    : `${text.slice(0, APPROVAL_BODY_PREVIEW_CHARS)}… (${text.length} chars total)`
}
