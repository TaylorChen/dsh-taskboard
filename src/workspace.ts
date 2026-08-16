/**
 * The workspace seam: `ctx.workspaceRegistry` consumed through a minimal
 * structural interface.
 *
 * Two facts shape this file (ARCHITECTURE decisions 28):
 *
 * 1. `workspaceRegistry` is mounted by the `web` profile only — `dsh-base`
 *    and `dsh-headless` never mount it. No always-active row may inject it;
 *    only the main row's `apply()` (web) and the routes row (web-only, its
 *    headless sibling is disabled) touch it, always through the optional
 *    `ctx.inject` pattern.
 * 2. Session ↔ workspace membership is canonical-cwd equality: a workspace
 *    owns the sessions whose `session.header.cwd` realpaths to the
 *    workspace's `path`.
 *
 * The concrete registry's types stay behind this file's minimal face — like
 * `TaskboardStore` for the storage seam — so an upstream API change costs one
 * adapter.
 * @module @navidid/dsh-taskboard/src/workspace
 */

/** The two registry operations the board needs, structurally. */
export interface WorkspaceRegistryLike {
  /** Resolve the workspace owning a canonical directory path (async realpath). */
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>
  /** Look up one workspace by id. */
  get(id: string): WorkspaceLike | undefined
}

/** The workspace fields the board reads. */
export interface WorkspaceLike {
  readonly id: string
  readonly title: string
}

/**
 * Resolve a session's workspace id from its header cwd, when the directory is
 * owned by a registered workspace. A missing cwd or an unowned directory
 * resolves to `undefined` — the caller keeps the task board-global.
 * @param registry - the workspace registry face (optional seam).
 * @param cwd - the session's absolute working directory, if any.
 * @returns the owning workspace id, or `undefined`.
 */
export async function sessionWorkspaceId(
  registry: WorkspaceRegistryLike,
  cwd: string | undefined,
): Promise<string | undefined> {
  if (cwd === undefined) return undefined
  const workspace = await registry.resolveByPath(cwd)
  return workspace?.id
}

/**
 * Display title for a workspace id, for the panel's meta line.
 * @param registry - the workspace registry face (optional seam).
 * @param id - workspace id, or `null` for a board-global task.
 * @returns the workspace title, or `undefined` when unknown.
 */
export function workspaceTitle(registry: WorkspaceRegistryLike, id: string | null): string | undefined {
  if (id === null) return undefined
  return registry.get(id)?.title
}
