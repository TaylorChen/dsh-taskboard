/**
 * The Provider role: `TaskboardStore` over one open storage domain.
 *
 * This is the only file that names `Domain` / `KvTable`. The storage-domain
 * design note is still `proposed/` upstream, so keeping the seam's types out of
 * the service and the consumers confines a future API change to this adapter.
 * @module @navidid/dsh-taskboard/src/store
 */

import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { TASKBOARD_DOMAIN, Project, ProjectId, Task, TaskId } from './domain.ts'
import type { TaskboardStore } from './service.ts'

/** The opened domain, typed by this package's spec. */
export type TaskboardDomain = Domain<typeof TASKBOARD_DOMAIN>

/**
 * Adapt an open domain to the store face the service depends on.
 *
 * Reads are synchronous because the domain serves authoritative in-memory
 * state; writes resolve only after the record is durable on the routed backend,
 * and the domain serializes them on one per-domain chain — which is what makes
 * the service's read-modify-write sequences safe without a lock of our own.
 * @param domain - the opened `taskboard` domain.
 * @returns the store face.
 */
export function createStore(domain: TaskboardDomain): TaskboardStore {
  const tasks = domain.table('tasks')
  const projects = domain.table('projects')

  return {
    listTasks: () => [...tasks.entries()].map(([, task]) => task),
    getTask: (id: TaskId) => tasks.get(id),
    putTask: (task: Task) => tasks.put(task.id as TaskId, task),
    deleteTask: (id: TaskId) => tasks.delete(id),
    listProjects: () => [...projects.entries()].map(([, project]) => project),
    getProject: (id: ProjectId) => projects.get(id),
    putProject: (project: Project) => projects.put(project.id as ProjectId, project),
  }
}
