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
 *
 * v0.2 deliberately does NOT bump this version: the status rework is a value
 * alias, not a schema shape change, and `key` / `blockedReason` are additive
 * fields that keep the no-migration storage layer's tolerance (see
 * `LEGACY_STATUS` and the `global` / `activity` additions, all verified by
 * Spike S1 — ARCHITECTURE decision 18).
 */
export const DOMAIN_VERSION = 1

/** Opaque task id; branded so it cannot be confused with a project id. */
export type TaskId = string & { readonly __taskId: unique symbol }
/** Opaque project id. */
export type ProjectId = string & { readonly __projectId: unique symbol }
/** Opaque activity id. */
export type ActivityId = string & { readonly __activityId: unique symbol }

/**
 * Board columns, in display order. The state machine is organised around
 * "whose turn it is", not "how far the work has progressed": `draft` waits for
 * a human to define it, `open` can be claimed by an agent, `in_progress` is on
 * an agent's hands, `awaiting_human` has the ball back with the human,
 * `blocked` is an agent explicitly stuck, and `done` / `cancelled` are
 * terminal. The human/agent split is what drives notifications, highlighting,
 * and (v0.3) auto-claim.
 */
export const TASK_STATUSES = ['draft', 'open', 'in_progress', 'awaiting_human', 'blocked', 'done', 'cancelled'] as const
/** One board column. */
export type TaskStatus = (typeof TASK_STATUSES)[number]

/**
 * v0.1 status values, mapped onto their v0.2 equivalents at the read boundary.
 * `todo` described "work not started"; in the ball-centric machine that is
 * `open` (waiting to be claimed). `in_review` described "awaiting review";
 * that is `awaiting_human`. Kept to v1.0, then deleted together with the
 * preprocess below.
 */
export const LEGACY_STATUS: Record<string, TaskStatus> = {
  todo: 'open',
  in_review: 'awaiting_human',
}

/** Task priorities, ascending. */
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
/** One task priority. */
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

/**
 * Who a task is intended for (v0.9): an intent declaration, not an ACL.
 * `human` tasks are never picked up by auto-claim (the human is the only
 * intended executor); `agent` tasks are; `any` (default) is whoever is ready.
 */
export const TASK_EXECUTORS = ['agent', 'human', 'any'] as const
/** One task's intended executor. */
export type TaskExecutor = (typeof TASK_EXECUTORS)[number]

/**
 * A task's executable specification (ROADMAP L2, v0.5): the intent, made
 * self-contained enough for an agent that shares no human team memory.
 * `acceptanceCriteria` are the checkable success conditions (the hard gate for
 * entering `open`); `contextRefs` point at files/commits/issues the executor
 * should read (a soft hint); `definitionOfDone` is optional closing text.
 */
export const taskSpecSchema = z.object({
  acceptanceCriteria: z.array(z.string().min(1)).max(32).default([]),
  contextRefs: z.array(z.string().min(1)).max(32).default([]),
  definitionOfDone: z.string().max(2000).default(''),
})
/** One task's executable specification. */
export type TaskSpec = z.infer<typeof taskSpecSchema>

/**
 * A task's execution evidence (ROADMAP L3, v0.6): the structured report a
 * dispatched subagent produces, making "completed" mean "completed with
 * evidence". `criteria` is the per-criterion self-assessment (met + note),
 * `artifacts` the produced paths/commits, `summary` the outcome text (also
 * carries the failure diagnosis on `error` settlements).
 */
export const evidenceSchema = z.object({
  criteria: z.array(z.object({
    criterion: z.string().min(1),
    met: z.boolean(),
    note: z.string().max(2000).default(''),
  })).max(64).default([]),
  artifacts: z.array(z.string().min(1)).max(32).default([]),
  summary: z.string().max(4000).default(''),
})
/** One task's execution evidence. */
export type TaskEvidence = z.infer<typeof evidenceSchema>

/**
 * One persisted task. `revision` is the optimistic-concurrency counter: a
 * caller that read revision N and writes with `expectedRevision: N` loses to
 * any write that landed meanwhile, rather than silently clobbering it.
 */
export const taskSchema = z.object({
  id: z.string().min(1),
  /**
   * Human-readable short id (`TB-1`), unique board-wide, monotonically
   * increasing, never reused after deletion. Optional at the durable boundary:
   * v0.1 records carry no key, and open must succeed so `apply()` can backfill
   * them (the one-time backfill is the package's second non-approval write —
   * ARCHITECTURE decision 19). Uniqueness is enforced by the service's
   * counter, not by this schema.
   */
  key: z.string().min(1).optional(),
  projectId: z.string().min(1),
  title: z.string().min(1).max(500),
  body: z.string().max(100_000),
  status: z.preprocess(
    (value) => (typeof value === 'string' && value in LEGACY_STATUS)
      ? LEGACY_STATUS[value]
      : value,
    z.enum(TASK_STATUSES),
  ),
  priority: z.enum(TASK_PRIORITIES),
  labels: z.array(z.string().min(1)).max(32),
  /** `ctx.workspaceRegistry` id, or null for a board-global task. */
  workspaceId: z.string().nullable(),
  /** Session that claimed this task, or null while unclaimed. */
  claimedBySessionId: z.string().nullable(),
  /**
   * Prerequisite task ids (ROADMAP L4, v0.7): a task is claimable only when
   * every dependency is `done` or `cancelled`. Additive with `.default([])`,
   * so v0.6 records read back with no dependencies.
   */
  dependsOn: z.array(z.string().min(1)).max(32).default([]),
  /**
   * Per-task output-token budget for the dispatched subagent (v0.7 W3);
   * `null` = unlimited. A child that hits the ceiling settles the task
   * `blocked` with a budget-exceeded diagnosis.
   */
  budgetTokens: z.number().int().nonnegative().nullable().default(null),
  /**
   * Intended executor (v0.9 W1): `human` tasks are excluded from auto-claim.
   * Additive with `.default('any')`.
   */
  executor: z.enum(TASK_EXECUTORS).default('any'),
  /**
   * Planned deadline (v0.9 W2): a human's commitment, not an estimate. Feeds
   * the scheduling weight (earlier due first) and the panel's overdue hint.
   * `null` = no deadline. Additive.
   */
  dueAt: z.number().int().nonnegative().nullable().default(null),
  /**
   * Append-only process notes (v0.9 W3): observations made while executing —
   * an agent's mid-way finding, a human's clarification. Distinct from `body`
   * (the original intent) and the activity stream (structured events).
   * Additive with `.default('')`.
   */
  notes: z.string().max(100_000).default(''),
  /**
   * Who created this task. Added after v1 shipped, so it carries a `default`
   * rather than bumping `DOMAIN_VERSION`: a stored record written before the
   * field existed still parses, and reads back as `agent`. Adding an optional
   * field with a default is the additive change the no-migration storage layer
   * tolerates; anything structural is not.
   */
  origin: z.enum(['agent', 'human']).default('agent'),
  /**
   * Why a task is in `blocked`. Additive with `.default(null)` for the same
   * no-migration reason as `origin`; cleared when the task leaves `blocked`.
   * Model-visible text — see SECURITY.md.
   */
  blockedReason: z.string().max(2000).nullable().default(null),
  /**
   * The executable specification (v0.5, ROADMAP L2). `null` = not specified
   * yet — a task can only enter `open` when its spec is complete (see
   * `isSpecComplete` in the service). Additive with `.default(null)`, so v0.4
   * records read back as unspecified.
   */
  spec: taskSpecSchema.nullable().default(null),
  /**
   * Execution evidence from the dispatched subagent (v0.6, ROADMAP L3).
   * `null` until the first settlement with a structured report. Additive with
   * `.default(null)`, so v0.5 records read back as evidence-free.
   */
  evidence: evidenceSchema.nullable().default(null),
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
 * Activity actions; `blocked` and `claimed` are the statuses they imply.
 * v0.4 adds `dispatched` (a claimed task handed to a background subagent) and
 * `completed` (the subagent's outcome written back). Adding enum values is
 * backwards-compatible at the durable boundary — stored records keep their old
 * values, which remain legal.
 */
export const ACTIVITY_ACTIONS = [
  'created', 'status', 'edited', 'removed', 'blocked', 'claimed', 'dispatched', 'completed', 'noted',
] as const
/** One activity action. */
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number]

/**
 * One entry in a task's activity stream: who (human or agent, same shape for
 * both — no "system operation" special-casing), when, and what. `from` / `to`
 * carry the transition's endpoints: statuses for `status`/`blocked`, the
 * claiming session for `claimed`, the initial status for `created`, the final
 * status for `removed`, and null for plain `edited`.
 */
export const activitySchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  at: z.number().int().nonnegative(),
  /** Who acted: a human or an agent — recorded in the same format. */
  actor: z.enum(['human', 'agent']),
  /** Session id for an agent, or `'panel'` / `'command'` for a human surface. */
  actorLabel: z.string(),
  action: z.enum(ACTIVITY_ACTIONS),
  from: z.string().nullable(),
  to: z.string().nullable(),
})
/** One persisted activity entry. */
export type Activity = z.infer<typeof activitySchema>

/**
 * The board-wide global singleton: the short-id counter. `nextTaskNumber` is
 * the next `TB-N` number to hand out; keys are never reused, so it only moves
 * forward. Held in the domain `global` slot (Spike S1 verified the slot is
 * compatible with v0.1 mediums — ARCHITECTURE decision 18).
 */
export const globalSchema = z.object({
  nextTaskNumber: z.number().int().nonnegative(),
})
/** The board's global singleton. */
export type TaskboardGlobal = z.infer<typeof globalSchema>

/** Initial global value; served before the first write materializes it. */
export const INITIAL_GLOBAL: TaskboardGlobal = { nextTaskNumber: 1 }

/**
 * The domain declaration handed to `ctx.storageDomain.open()`.
 *
 * The `global` slot was added in v0.2 (it was deliberately absent in v0.1 —
 * see ARCHITECTURE decision 7) to hold the short-id counter. Spike S1
 * confirmed that adding the slot and the `activity` table does not reject an
 * existing medium: the JSON backend's `open` validates only `name` and
 * `version` against the stored header, and a table missing from the medium is
 * initialized empty on load.
 */
export const TASKBOARD_DOMAIN = defineDomain({
  name: 'taskboard',
  version: DOMAIN_VERSION,
  global: {
    schema: globalSchema,
    initial: INITIAL_GLOBAL,
  },
  tables: {
    tasks: domainTable<TaskId, Task>(taskSchema),
    projects: domainTable<ProjectId, Project>(projectSchema),
    activity: domainTable<ActivityId, Activity>(activitySchema),
  },
})

/** Marker identifying an export document produced by this plugin. */
export const EXPORT_SCHEMA = 'dsh-taskboard-export-v1'

/**
 * Backup/migration document. `importDocument` rejects an unknown `schema`
 * loudly rather than guessing, so a future format change stays detectable.
 * Activity is deliberately NOT exported: it is derived history, not state that
 * needs carrying across a migration.
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
