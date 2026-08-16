/**
 * Package-owned invariant companion for `@navidid/dsh-taskboard`.
 * @module @navidid/dsh-taskboard/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@navidid/dsh-taskboard'

/** Cordis companion plugin name. */
export const name = 'taskboard-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant. The relationships this package owns are already
 * enforced upstream of any assertion point: stored records are validated
 * against their zod schemas by the storage-domain seam at every load and write,
 * revision monotonicity is enforced inside `TaskboardService.update` and
 * covered by unit tests, and the approval gate's own audit pair lives on the
 * session log rather than in state this package could cross-check.
 *
 * An explained empty companion is the correct shape when no owned relationship
 * is assertable over an authoritative event stream or mutable data.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
