/**
 * The `taskboard` domain declaration: the single source of the board's
 * persistent layout. Record schemas are zod (the storage-domain seam validates
 * every stored record against them at the durable boundary and `z.infer` keeps
 * the types un-duplicated); plugin `Config` stays schemastery.
 *
 * Names are constrained by the storage hub's `UNIT_NAME_RE`
 * (`/^[a-z][a-z0-9_]*$/`) — lowercase, no hyphens — and `defineDomain`
 * enforces that at module load, before any medium is touched.
 * @module @navidid/dsh-taskboard/src/domain
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/**
 * Domain format version. The storage layer has NO migration path: a medium
 * stamped with a different version rejects at open with `version-mismatch`.
 * Bumping this therefore strands existing boards, which is why `exportAll` /
 * `importDocument` ship in the first release rather than being deferred.
 */
export const DOMAIN_VERSION = 1

/** Opaque task id; branded so it cannot be confused with a project id. */
export type TaskId = string & { readonly __taskId: unique symbol }
/** Opaque project id. */
export type ProjectId = string & { readonly __projectId: unique symbol }

/** Board columns, in display order. */
export const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'] as const
/** One board column. */
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Task priorities, ascending. */
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
/** One task priority. */
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

/**
 * One persisted task. `revision` is the optimistic-concurrency counter: a
 * caller that read revision N and writes with `expectedRevision: N` loses to
 * any write that landed meanwhile, rather than silently clobbering it.
 */
export const taskSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1).max(500),
  body: z.string().max(100_000),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  labels: z.array(z.string().min(1)).max(32),
  /** `ctx.workspaceRegistry` id, or null for a board-global task. */
  workspaceId: z.string().nullable(),
  /** Session that claimed this task, or null while unclaimed. */
  claimedBySessionId: z.string().nullable(),
  /**
   * Who created this task. Added after v1 shipped, so it carries a `default`
   * rather than bumping `DOMAIN_VERSION`: a stored record written before the
   * field existed still parses, and reads back as `agent`. Adding an optional
   * field with a default is the additive change the no-migration storage layer
   * tolerates; anything structural is not.
   */
  origin: z.enum(['agent', 'human']).default('agent'),
  revision: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
/** One persisted task. */
export type Task = z.infer<typeof taskSchema>

/** One project: a named grouping of tasks, optionally pinned to a workspace. */
export const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(10_000),
  workspaceId: z.string().nullable(),
  archived: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
/** One persisted project. */
export type Project = z.infer<typeof projectSchema>

/**
 * The domain declaration handed to `ctx.storageDomain.open()`.
 *
 * No `global` slot: every piece of board state belongs to a task or a project,
 * and a global would be one more thing to version. Counters that a UI wants
 * (per-column totals) are derived from the tables, never stored.
 */
export const TASKBOARD_DOMAIN = defineDomain({
  name: 'taskboard',
  version: DOMAIN_VERSION,
  tables: {
    tasks: domainTable<TaskId, Task>(taskSchema),
    projects: domainTable<ProjectId, Project>(projectSchema),
  },
})

/** Marker identifying an export document produced by this plugin. */
export const EXPORT_SCHEMA = 'dsh-taskboard-export-v1'

/**
 * Backup/migration document. `importDocument` rejects an unknown `schema`
 * loudly rather than guessing, so a future format change stays detectable.
 */
export const exportDocumentSchema = z.object({
  schema: z.literal(EXPORT_SCHEMA),
  domainVersion: z.number().int().nonnegative(),
  exportedAt: z.number().int().nonnegative(),
  projects: z.array(projectSchema),
  tasks: z.array(taskSchema),
})
/** Backup/migration document. */
export type ExportDocument = z.infer<typeof exportDocumentSchema>
