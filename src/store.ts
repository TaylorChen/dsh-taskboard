/**
 * The Provider role: `TaskboardStore` over one open storage domain.
 *
 * This is the only file that names `Domain` / `KvTable`. The storage-domain
 * design note is still `proposed/` upstream, so keeping the seam's types out of
 * the service and the consumers confines a future API change to this adapter.
 *
 * Since v1.3 (C2) the adapter also carries a cross-process write guard: the
 * JSON backend rewrites the whole unit file on every write, so two processes
 * sharing one home can silently clobber each other (a stale snapshot's rewrite
 * loses the other process's changes, including short-id counter advances). The
 * guard re-reads the medium before every durable write and refuses when its
 * state diverges from the domain's in-memory snapshot — a loud
 * `concurrent-modification` instead of silent data loss. It is scoped to the
 * JSON backend by construction: the injected reader returns `null` (guard off)
 * when the file is absent or unparseable.
 * @module @navidid/dsh-taskboard/src/store
 */

import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { TaskboardError } from './errors.ts'
import {
  activitySchema, globalSchema, projectSchema, taskSchema,
  type Activity, type ActivityId, type Project, type ProjectId, type Task, type TaskId,
  type TaskboardGlobal, TASKBOARD_DOMAIN,
} from './domain.ts'
import type { TaskboardStore } from './service.ts'

/** The opened domain, typed by this package's spec. */
export type TaskboardDomain = Domain<typeof TASKBOARD_DOMAIN>

/**
 * v1.3 C2: the cross-process write guard's view of the medium. The plugin
 * injects a reader bound to the JSON unit file; `null` means "no readable JSON
 * medium" and disables the guard (fresh board, or a non-JSON backend).
 */
export interface MediumGuard {
  /**
   * Raw JSON unit file content, or `null` when there is nothing to compare
   * against (file not yet created, or the backend is not JSON).
   */
  read(): string | null
}

/**
 * Canonicalize one record for fingerprinting: keys sorted, values in key
 * order — so two serializations of the same record (backend write order vs
 * in-memory insertion order) compare equal.
 */
function canonicalRecord(record: unknown): string {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return JSON.stringify(record)
  }
  const entries = Object.entries(record as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => [key, canonicalRecord(value)])
  return JSON.stringify(entries)
}

/**
 * Fingerprint of one side (medium or memory): global plus every table's
 * records, records key-sorted and canonicalized. The two sides must produce
 * identical strings when they hold the same state.
 */
function fingerprint(
  global: TaskboardGlobal,
  tables: Array<[string, Iterable<[string | number, unknown]>]>,
): string {
  return JSON.stringify({
    g: canonicalRecord(global),
    t: tables
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, entries]) => [
        name,
        // Sort by the canonical record, never by the table key: the domain's
        // key scheme (activity uses numeric indices) must not leak into the
        // comparison, or identical content in different key orders diverges.
        [...entries]
          .map(([, record]) => canonicalRecord(record))
          .sort(),
      ]),
  })
}

/**
 * Normalize one table of raw medium records through the domain schema, so a
 * record an older build wrote WITHOUT today's `.default()` fields compares
 * equal to the schema-normalized in-memory copy the domain serves. `undefined`
 * when any record fails the schema — the medium holds state this build does
 * not understand, which must never be clobbered.
 */
function normalizeTable<T>(schema: { safeParse(value: unknown): { success: true, data: T } | { success: false } }, records: Record<string, unknown>): T[] | undefined {
  const out: T[] = []
  for (const record of Object.values(records)) {
    const parsed = schema.safeParse(record)
    if (!parsed.success) return undefined
    out.push(parsed.data)
  }
  return out
}

/**
 * Adapt an open domain to the store face the service depends on.
 *
 * Reads are synchronous because the domain serves authoritative in-memory
 * state; writes resolve only after the record is durable on the routed backend,
 * and the domain serializes them on one per-domain chain — which is what makes
 * the service's read-modify-write sequences safe without a lock of our own.
 * @param domain - the opened `taskboard` domain.
 * @param medium - optional v1.3 C2 cross-process guard; when provided, every
 * durable write first compares the medium against the in-memory snapshot and
 * refuses a divergent write. Omit (or return `null` from `read`) to disable.
 * @returns the store face.
 */
export function createStore(domain: TaskboardDomain, medium?: MediumGuard): TaskboardStore {
  const tasks = domain.table('tasks')
  const projects = domain.table('projects')
  const activity = domain.table('activity')

  /**
   * v1.3 C2: refuse a write when the medium moved on since our snapshot.
   * Runs before the write queues; the memory side is the domain's current
   * state, the medium side is the file as another process last left it. The
   * medium records are normalized through the domain schema first, because the
   * in-memory copies carry `.default()` fields the raw file may not.
   */
  async function assertMediumUnchanged(): Promise<void> {
    if (medium === undefined) return
    const raw = medium.read()
    if (raw === null) return // fresh board or non-JSON backend: nothing to compare
    let mediumUnit: { global?: unknown, tables?: Record<string, Record<string, unknown>> }
    try {
      mediumUnit = JSON.parse(raw) as typeof mediumUnit
    } catch {
      return // unparseable file: leave the guard off rather than blocking writes
    }
    const mediumTables = mediumUnit.tables
    // `null` is the storage-domain library's documented "never written"
    // sentinel for the global slot (a pre-v0.2 medium, or a fresh domain that
    // has not yet had `global.set` durably applied) — not foreign state.
    if (mediumTables === undefined || mediumUnit.global === undefined || mediumUnit.global === null) return

    const global = globalSchema.safeParse(mediumUnit.global)
    const tasks = normalizeTable(taskSchema, mediumTables.tasks ?? {})
    const projects = normalizeTable(projectSchema, mediumTables.projects ?? {})
    const activity = normalizeTable(activitySchema, mediumTables.activity ?? {})
    if (!global.success || tasks === undefined || projects === undefined || activity === undefined) {
      // The medium holds records this build does not understand — never
      // clobber them; a newer process wrote this file.
      throw new TaskboardError(
        'concurrent-modification',
        'the board changed in another process (storage state is not readable by this build); '
        + 'refresh and retry the write',
      )
    }

    const memoryFingerprint = fingerprint(domain.global.get(), [
      ['tasks', tasks.entries()],
      ['projects', projects.entries()],
      ['activity', activity.entries()],
    ])
    const mediumFingerprint = fingerprint(global.data, [
      ['tasks', tasks.map(task => [task.id, task])],
      ['projects', projects.map(project => [project.id, project])],
      ['activity', activity.map(entry => [entry.id, entry])],
    ])
    if (memoryFingerprint !== mediumFingerprint) {
      throw new TaskboardError(
        'concurrent-modification',
        'the board changed in another process (the storage file was rewritten); '
        + 'refresh and retry the write',
      )
    }
  }

  return {
    listTasks: () => [...tasks.entries()].map(([, task]) => task),
    getTask: (id: TaskId) => tasks.get(id),
    putTask: async (task: Task) => {
      await assertMediumUnchanged()
      await tasks.put(task.id as TaskId, task)
    },
    deleteTask: async (id: TaskId) => {
      await assertMediumUnchanged()
      return tasks.delete(id)
    },
    listProjects: () => [...projects.entries()].map(([, project]) => project),
    getProject: (id: ProjectId) => projects.get(id),
    putProject: async (project: Project) => {
      await assertMediumUnchanged()
      await projects.put(project.id as ProjectId, project)
    },
    listActivity: (taskId: TaskId) => [...activity.entries()]
      .map(([, entry]) => entry)
      .filter(entry => entry.taskId === taskId),
    putActivity: async (entry: Activity) => {
      await assertMediumUnchanged()
      await activity.put(entry.id as ActivityId, entry)
    },
    deleteActivity: async (id: ActivityId) => {
      await assertMediumUnchanged()
      return activity.delete(id)
    },
    getGlobal: () => domain.global.get(),
    setGlobal: async (value: TaskboardGlobal) => {
      await assertMediumUnchanged()
      await domain.global.set(value)
    },
  }
}
