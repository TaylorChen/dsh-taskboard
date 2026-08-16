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
}

/** Fields accepted when updating a task; omitted fields keep their value. */
export interface UpdateTaskInput {
  readonly title?: string
  readonly body?: string
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

/** A task's activity stream, newest first (the presentation order). */
export type ActivityStream = readonly Activity[]

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
      return true
    })
    matched.sort((a, b) => b.updatedAt - a.updatedAt)
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

    const next: Task = {
      ...current,
      title: patch.title ?? current.title,
      body: patch.body ?? current.body,
      status,
      priority: patch.priority ?? current.priority,
      labels: patch.labels === undefined ? current.labels : [...patch.labels],
      workspaceId,
      claimedBySessionId: patch.claimedBySessionId === undefined
        ? current.claimedBySessionId
        : patch.claimedBySessionId,
      blockedReason,
      spec,
      dependsOn,
      budgetTokens,
      executor: patch.executor ?? current.executor,
      dueAt: patch.dueAt === undefined ? current.dueAt : patch.dueAt,
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
    await this.deps.store.putTask(next)
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
      return next
    }
    const change = activityFor(current, next)
    await this.recordActivity(next.id as TaskId, change.action, change.from, change.to, actor, next.updatedAt)
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
