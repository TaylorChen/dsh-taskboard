/**
 * Host row of `@navidid/dsh-taskboard`: opens the `taskboard` storage domain,
 * provides `ctx.taskboard`, and registers the `/task` commands.
 *
 * `inject` names `storageDomain`, which the shipped `web` profile mounts and
 * `headless` does not. A row whose injected service never appears does NOT sit
 * quietly inert: dsh fails the whole boot with "N entries did not activate", so
 * installing this bundle where its services are absent is a loud startup
 * failure. That is the intended behaviour for a misconfiguration; the README
 * documents the overlay a headless deployment uses instead.
 *
 * The model-facing tools live in `./tool` and the JSON API in `./routes`, each
 * as its own cordis row, so a deployment can drop either half without patching
 * this one.
 * @module @navidid/dsh-taskboard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { existsSync, readFileSync } from 'node:fs'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { TASKBOARD_DOMAIN, type Project } from './domain.ts'
import { createStore, type MediumGuard, type TaskboardDomain } from './store.ts'
import { TaskboardService } from './service.ts'
import { registerCommands } from './commands.ts'
import {
  DEFAULT_ACTIVITY_RETENTION_PER_TASK,
  DEFAULT_KEY_PREFIX,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_TASKS,
  DEFAULT_WRITE_POLICY,
  type WritePolicy,
} from './defaults.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    taskboard: TaskboardService
  }
}

export { TaskboardService, isSpecComplete } from './service.ts'
export type {
  Actor, ActivityStream, CreateTaskInput, ListFilter, TaskRef, TaskboardStore, UpdateTaskInput,
} from './service.ts'
export { selectClaimCandidate } from './autoclaim.ts'
export { TaskboardError } from './errors.ts'
export type { TaskboardErrorCode } from './errors.ts'
export {
  ACTIVITY_ACTIONS, DOMAIN_VERSION, EXPORT_SCHEMA, TASK_PRIORITIES, TASK_STATUSES, taskSpecSchema,
} from './domain.ts'
export type {
  Activity, ActivityAction, ActivityId, ExportDocument, Project, ProjectId, Task, TaskId,
  TaskPriority, TaskSpec, TaskStatus, TaskboardGlobal,
} from './domain.ts'

/** Cordis plugin name. */
export const name = 'taskboard'

/** Services required before the board can serve. */
export const inject = ['storageDomain', 'approval']

/** Deployment configuration. */
export interface Config {
  /**
   * Write stance. `ask` routes every mutation through `ctx.approval` (the
   * default); `auto` writes without asking, for unattended deployments that
   * accept it; `off` refuses every write, leaving a read-only board.
   */
  writePolicy: WritePolicy
  /** Ceiling on stored tasks. A board is a work queue, not an archive. */
  maxTasks: number
  /** Default page size for `task_list`, bounding what one call can inject. */
  listLimit: number
  /** Name of the project seeded when the board is opened empty. */
  defaultProjectName: string
  /** Short-id prefix; keys look like `<keyPrefix>1`. */
  keyPrefix: string
  /** Activity entries kept per task before the oldest are trimmed. */
  activityRetentionPerTask: number
}

/** Loader schema; the defaults here are the deployment's, not the library's. */
export const Config: z<Config> = z.object({
  writePolicy: z.union(['ask', 'auto', 'off'] as const).default(DEFAULT_WRITE_POLICY),
  maxTasks: z.number().step(1).min(1).default(DEFAULT_MAX_TASKS),
  listLimit: z.number().step(1).min(1).default(DEFAULT_LIST_LIMIT),
  defaultProjectName: z.string().default('Inbox'),
  keyPrefix: z.string().min(1).default(DEFAULT_KEY_PREFIX),
  activityRetentionPerTask: z.number().step(1).min(1).default(DEFAULT_ACTIVITY_RETENTION_PER_TASK),
})

/**
 * Mount the board.
 * @param ctx - plugin context carrying `storageDomain` and `approval`.
 * @param config - validated deployment configuration.
 * @returns resolution once the domain is open and the service is provided.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const domain: TaskboardDomain = await ctx.storageDomain.open(TASKBOARD_DOMAIN)
  // The opening consumer owns the handle's lifecycle; the facility only closes
  // domains left open when it unmounts.
  ctx.effect(() => () => { void domain.close() }, 'dsh-taskboard.domain.close')

  // v1.3 C2: the cross-process write guard reads the JSON unit file directly —
  // the same path the shipped profile config routes the domain to
  // (`dshHomePath('storages')` + the domain's file). Absent file (fresh board
  // or non-JSON backend) -> `null` -> the store disables the guard.
  const mediumPath = dshHomePath('storages', 'taskboard.json')
  const medium: MediumGuard = {
    read: () => {
      try {
        return existsSync(mediumPath) ? readFileSync(mediumPath, 'utf8') : null
      } catch {
        return null
      }
    },
  }

  const store = createStore(domain, medium)

  const service = new TaskboardService({
    store,
    approval: ctx.approval,
    writePolicy: config.writePolicy,
    maxTasks: config.maxTasks,
    keyPrefix: config.keyPrefix,
    activityRetentionPerTask: config.activityRetentionPerTask,
  })

  // One-time short-id backfill. v0.1 records carry no `key`, and a fresh board
  // starts the counter at 1, so the first mount of a v0.1 medium numbers its
  // records in `createdAt` order. This is a plugin-owned bootstrap write, not a
  // user or model write — same standing as the seed project below (the second
  // such write in the package; ARCHITECTURE decision 19). It is idempotent: on
  // later mounts every record already has a key, so nothing is written.
  await service.backfillKeys()

  // Bootstrap seeding, not a user or model write: `create` needs a project to
  // exist, so an empty board gets one. It bypasses the approval gate on purpose
  // — there is nothing for a human to decide about an empty board's first
  // container, and asking on startup would block the mount.
  if (store.listProjects().length === 0) {
    const at = Date.now()
    const seed: Project = {
      id: globalThis.crypto.randomUUID(),
      name: config.defaultProjectName,
      description: '',
      workspaceId: null,
      archived: false,
      createdAt: at,
      updatedAt: at,
    }
    await store.putProject(seed)
  }

  ctx.provide('taskboard', service)
  registerCommands(ctx, service, config.listLimit)

  // Optional workspace seam (v0.4 W1): `workspaceRegistry` is mounted by the
  // web profile only — headless never mounts it, so this must ride the
  // optional `ctx.inject` pattern instead of the row's `inject` list
  // (ARCHITECTURE decision 28). When absent, workspace auto-assignment and
  // scoping fall back to board-global, which is the pre-v0.4 behaviour.
  ctx.inject(['workspaceRegistry'], (scoped: Context) => {
    service.setWorkspaceResolver(async (cwd) => {
      if (cwd === undefined) return undefined
      const workspace = await scoped.workspaceRegistry.resolveByPath(cwd)
      return workspace?.id
    })
  })
}
