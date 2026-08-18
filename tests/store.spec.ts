/**
 * v1.3 C2: the cross-process write guard. The JSON backend rewrites the whole
 * unit file per write, so a stale-snapshot process must be refused — loudly —
 * instead of silently clobbering another process's changes. The guard lives in
 * `createStore`'s medium comparison: memory fingerprint vs medium fingerprint,
 * canonicalized so serialization order never matters.
 */

import { describe, expect, it } from 'vitest'
import { createStore, type MediumGuard, type TaskboardDomain } from '../src/store.ts'
import type { Task } from '../src/domain.ts'

/** A minimal domain double: three in-memory tables + a global singleton. */
function fakeDomain(seed: {
  global?: { nextTaskNumber: number },
  tasks?: Map<string, unknown>,
  projects?: Map<string, unknown>,
  activity?: Map<string, unknown>,
}) {
  const tasks = seed.tasks ?? new Map<string, unknown>()
  const projects = seed.projects ?? new Map<string, unknown>()
  const activity = seed.activity ?? new Map<string, unknown>()
  let globalValue = seed.global ?? { nextTaskNumber: 1 }
  const tables = { tasks, projects, activity }
  return {
    name: 'taskboard',
    close: async () => {},
    table: (name: 'tasks' | 'projects' | 'activity') => {
      const table = tables[name]
      return {
        get: (key: string) => table.get(key),
        entries: () => table.entries(),
        keys: () => table.keys(),
        get size() { return table.size },
        put: async (key: string, value: unknown) => { table.set(key, value) },
        delete: async (key: string) => table.delete(key),
        update: async (key: string, fn: (current: unknown) => unknown) => {
          const next = fn(table.get(key))
          table.set(key, next)
          return next
        },
      }
    },
    global: {
      get: () => globalValue,
      set: async (value: { nextTaskNumber: number }) => { globalValue = value },
    },
    // The generic Domain surface is wider than the store's use of it; the
    // double implements exactly what createStore touches (cast is deliberate).
  } as unknown as TaskboardDomain
}

/** Serialize a fake medium the way the JSON backend would (unit shape). */
function serializeMedium(
  global: unknown,
  tables: Record<string, Record<string, unknown>>,
  shuffleKeys = false,
): string {
  const obj = { unit: { name: 'taskboard', version: 1 }, global, tables }
  return JSON.stringify(shuffleKeys ? JSON.parse(JSON.stringify(obj)) : obj)
}

/** One stored task, minimal but revision-bearing. */
function task(id: string, revision: number): Task {
  return {
    id, key: `TB-${revision}`, projectId: 'project-1', title: `T ${id}`, body: '',
    status: 'draft', priority: 'normal', labels: [], origin: 'human', revision,
    updatedAt: 0, workspaceId: null, blockedReason: null, claimedBySessionId: null,
    spec: null, evidence: null, executor: 'any', dueAt: null, notes: '',
    archivedAt: null, contextBudgetTokens: null,
        sortOrder: null,
        tokensUsed: null, dependsOn: [], budgetTokens: null,
    createdAt: 0,
  }
}

describe('cross-process write guard (v1.3 C2)', () => {
  it('refuses a write when the medium moved on since the snapshot', async () => {
    const inMemory = new Map<string, Task>([['a', task('a', 1)]])
    // Another process added task b and bumped a to rev 2 on the file.
    const mediumState = {
      global: { nextTaskNumber: 3 },
      tasks: {
        a: { ...task('a', 2), title: 'changed elsewhere' },
        b: task('b', 1),
      },
      projects: {},
      activity: {},
    }
    const domain = fakeDomain({ global: { nextTaskNumber: 1 }, tasks: inMemory })
    const store = createStore(domain, {
      read: () => serializeMedium(mediumState.global, mediumState.tasks
        ? { tasks: mediumState.tasks, projects: {}, activity: {} } : {}),
    })

    await expect(store.putTask(task('a', 2)))
      .rejects.toMatchObject({ code: 'concurrent-modification' })
  })

  it('refuses a global-counter write when another process advanced it', async () => {
    const domain = fakeDomain({ global: { nextTaskNumber: 5 } })
    const store = createStore(domain, {
      read: () => serializeMedium({ nextTaskNumber: 6 }, { tasks: {}, projects: {}, activity: {} }),
    })

    await expect(store.setGlobal({ nextTaskNumber: 5 }))
      .rejects.toMatchObject({ code: 'concurrent-modification' })
  })

  it('lets the write through when medium and memory agree', async () => {
    const record = task('a', 1)
    const inMemory = new Map<string, Task>([['a', record]])
    const domain = fakeDomain({ global: { nextTaskNumber: 1 }, tasks: inMemory })
    const store = createStore(domain, {
      read: () => serializeMedium(
        { nextTaskNumber: 1 },
        { tasks: { a: record }, projects: {}, activity: {} },
      ),
    })

    await expect(store.putTask(task('a', 2))).resolves.toBeUndefined()
  })

  it('ignores serialization key order in the comparison', async () => {
    const record = task('a', 1)
    const inMemory = new Map<string, Task>([['a', record]])
    const domain = fakeDomain({ global: { nextTaskNumber: 1 }, tasks: inMemory })
    // The medium rewrote the file with a different key order; the guard must
    // still see "same state" and let the write through.
    const store = createStore(domain, {
      read: () => serializeMedium(
        { nextTaskNumber: 1 },
        { tasks: { a: record }, projects: {}, activity: {} },
        true,
      ),
    })

    await expect(store.putTask(task('a', 2))).resolves.toBeUndefined()
  })

  it('disables the guard when the medium reader returns null', async () => {
    const domain = fakeDomain({ global: { nextTaskNumber: 1 } })
    const store = createStore(domain, { read: () => null })

    await expect(store.putTask(task('a', 1))).resolves.toBeUndefined()
    await expect(store.setGlobal({ nextTaskNumber: 9 })).resolves.toBeUndefined()
  })

  it('lets the write through when the medium global is the storage-domain\'s null sentinel', async () => {
    // A pre-v0.2 medium never had a global slot durably written: the
    // storage-domain library serializes that as `global: null` (its own
    // documented "never written" sentinel), not as foreign/unparseable state.
    const record = task('a', 1)
    const inMemory = new Map<string, Task>([['a', record]])
    const domain = fakeDomain({ global: { nextTaskNumber: 1 }, tasks: inMemory })
    const store = createStore(domain, {
      read: () => serializeMedium(null, { tasks: { a: record }, projects: {}, activity: {} }),
    })

    await expect(store.putTask(task('a', 2))).resolves.toBeUndefined()
  })

  it('disables the guard without a medium argument at all', async () => {
    const domain = fakeDomain({ global: { nextTaskNumber: 1 } })
    const store = createStore(domain)

    await expect(store.putTask(task('a', 1))).resolves.toBeUndefined()
  })

  it('leaves the guard off when the medium file is unparseable', async () => {
    const domain = fakeDomain({ global: { nextTaskNumber: 1 } })
    const store = createStore(domain, { read: () => 'not json at all {' })

    await expect(store.putTask(task('a', 1))).resolves.toBeUndefined()
  })
})
