/**
 * The workspace seam adapter's pure helpers (`src/workspace.ts`): cwd → owning
 * workspace id, and id → display title, over a minimal registry face.
 */

import { describe, expect, it } from 'vitest'
import { sessionWorkspaceId, workspaceTitle, type WorkspaceRegistryLike } from '../src/workspace.ts'

/** A registry double over an owned-path map. */
function registry(owned: Record<string, { id: string, title: string }>): WorkspaceRegistryLike {
  const byPath = new Map(Object.entries(owned))
  const byId = new Map(Object.values(owned).map(ws => [ws.id, ws]))
  return {
    resolveByPath: async (path: string) => byPath.get(path),
    get: (id: string) => byId.get(id),
  }
}

describe('sessionWorkspaceId', () => {
  it('resolves the workspace owning the session cwd', async () => {
    const reg = registry({ '/home/work': { id: 'ws-a', title: 'Work' } })
    await expect(sessionWorkspaceId(reg, '/home/work')).resolves.toBe('ws-a')
  })

  it('resolves undefined for a missing cwd or an unowned directory', async () => {
    const reg = registry({ '/home/work': { id: 'ws-a', title: 'Work' } })
    await expect(sessionWorkspaceId(reg, undefined)).resolves.toBeUndefined()
    await expect(sessionWorkspaceId(reg, '/nowhere')).resolves.toBeUndefined()
  })
})

describe('workspaceTitle', () => {
  it('returns the display title for a bound id', () => {
    expect(workspaceTitle(registry({ '/home/work': { id: 'ws-a', title: 'Work' } }), 'ws-a')).toBe('Work')
  })

  it('returns undefined for null (board-global) or unknown ids', () => {
    const reg = registry({})
    expect(workspaceTitle(reg, null)).toBeUndefined()
    expect(workspaceTitle(reg, 'ws-nope')).toBeUndefined()
  })
})
