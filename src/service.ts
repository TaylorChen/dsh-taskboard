/**
 * `ctx.taskboard` — the Service Definition of the task-board capability.
 *
 * Two contracts are load-bearing here:
 *
 * 1. **The approval gate lives inside the write methods, not in the tools.**
 *    Any caller — the `task_*` tools, a `/task` command, another plugin —
 *    reaches durability only through `create` / `update` / `remove` / `import`,
 *    so none of them can route around the gate. Putting the gate in a tool's
 *    `execute` would leave `ctx.taskboard.create()` open to every other plugin.
 * 2. **The provider's types never leave this file.** Consumers see `Task`,
 *    `Project`, and `TaskboardService`; the `Domain` / `KvTable` handles from
 *    the storage-domain seam stay behind `TaskboardStore`, whose design note is
 *    still `proposed/` upstream and may change.
 * @module @navidid/dsh-taskboard/src/service
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  EXPORT_SCHEMA,
  DOMAIN_VERSION,
  exportDocumentSchema,
  type ExportDocument,
  type Project,
  type ProjectId,
  type Task,
  type TaskId,
  type TaskPriority,
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
    /** Which human surface initiated the write; recorded for diagnostics. */
    readonly via: 'panel' | 'command'
  }

/** Everything the service is constructed with. */
export interface TaskboardDeps {
  readonly store: TaskboardStore
  readonly approval: ApprovalLike
  readonly writePolicy: WritePolicy
  readonly maxTasks: number
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
 * The task-board service. Reads are synchronous (the provider serves from
 * authoritative memory); every write passes the approval gate first.
 */
export class TaskboardService {
  private readonly now: () => number
  private readonly newId: () => string

  /**
   * @param deps - provider, approval seam, and validated deployment config.
   */
  constructor(private readonly deps: TaskboardDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID())
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
   * Read one task.
   * @param id - task id.
   * @returns the task, or `undefined` when absent.
   */
  get(id: TaskId): Task | undefined {
    return this.deps.store.getTask(id)
  }

  /**
   * Read every project.
   * @returns all stored projects.
   */
  projects(): readonly Project[] {
    return this.deps.store.listProjects()
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
    // Pre-check before disturbing a human; re-checked after approval below,
    // because concurrent writes may land while the question is open.
    this.assertCapacity()

    await this.gate('create', `${input.title}\n\n${preview(input.body ?? '')}`, actor)

    this.assertCapacity()
    const at = this.now()
    const task: Task = {
      id: this.newId(),
      projectId: input.projectId,
      title: input.title,
      body: input.body ?? '',
      status: input.status ?? 'todo',
      priority: input.priority ?? 'normal',
      labels: [...(input.labels ?? [])],
      workspaceId: input.workspaceId ?? null,
      claimedBySessionId: null,
      origin: actor.kind,
      revision: 0,
      createdAt: at,
      updatedAt: at,
    }
    await this.deps.store.putTask(task)
    return task
  }

  /**
   * Update one task behind the approval gate.
   * @param id - task id.
   * @param patch - fields to change; omitted fields keep their value.
   * @param actor - who is asking.
   * @returns the stored task after the change.
   */
  async update(id: TaskId, patch: UpdateTaskInput, actor: Actor): Promise<Task> {
    const current = this.require(id)
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.revision) {
      throw new TaskboardError(
        'revision-conflict',
        `task '${id}' is at revision ${current.revision}, not ${patch.expectedRevision}; reread and retry`,
      )
    }

    const next: Task = {
      ...current,
      title: patch.title ?? current.title,
      body: patch.body ?? current.body,
      status: patch.status ?? current.status,
      priority: patch.priority ?? current.priority,
      labels: patch.labels === undefined ? current.labels : [...patch.labels],
      workspaceId: patch.workspaceId === undefined ? current.workspaceId : patch.workspaceId,
      claimedBySessionId: patch.claimedBySessionId === undefined
        ? current.claimedBySessionId
        : patch.claimedBySessionId,
      revision: current.revision + 1,
      updatedAt: this.now(),
    }

    // approve-what-you-see: the human decides a concrete before/after, not the
    // abstract verb "update".
    await this.gate('update', `from:\n${describe(current)}\n\nto:\n${describe(next)}`, actor)

    // The stored record may have moved while the question was open; the guard
    // is authoritative at commit time, not at ask time.
    const atCommit = this.require(id)
    if (atCommit.revision !== current.revision) {
      throw new TaskboardError(
        'revision-conflict',
        `task '${id}' changed while the approval was open (now revision ${atCommit.revision}); reread and retry`,
      )
    }
    await this.deps.store.putTask(next)
    return next
  }

  /**
   * Remove one task behind the approval gate.
   * @param id - task id.
   * @param actor - who is asking.
   * @returns nothing; a missing task raises `not-found`.
   */
  async remove(id: TaskId, actor: Actor): Promise<void> {
    const current = this.require(id)
    await this.gate('remove', describe(current), actor)
    await this.deps.store.deleteTask(id)
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
   * Records keep their ids so a restore is idempotent against the same medium.
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
    for (const task of doc.tasks) await this.deps.store.putTask(task)
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

  /** Read one task or raise `not-found`. */
  private require(id: TaskId): Task {
    const task = this.deps.store.getTask(id)
    if (task === undefined) throw new TaskboardError('not-found', `task '${id}' does not exist`)
    return task
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

/** One-paragraph rendering of a task for an approval payload. */
function describe(task: Task): string {
  return [
    `title: ${task.title}`,
    `status: ${task.status}  priority: ${task.priority}`,
    task.labels.length > 0 ? `labels: ${task.labels.join(', ')}` : undefined,
    task.body === '' ? undefined : `body: ${preview(task.body)}`,
  ].filter(line => line !== undefined).join('\n')
}

/** Bound a free-text field quoted into an approval payload. */
function preview(text: string): string {
  return text.length <= APPROVAL_BODY_PREVIEW_CHARS
    ? text
    : `${text.slice(0, APPROVAL_BODY_PREVIEW_CHARS)}… (${text.length} chars total)`
}
