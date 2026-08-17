/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-balance-indicator`.
 * @module @deepseek-ai/dsh-client-ui-balance-indicator/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-balance-indicator'

/** Cordis companion plugin name. */
export const name = 'client-ui-balance-indicator-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the capsule only reads wire state into its own
 * per-Session store — it emits no cordis events and owns no cross-plugin
 * mutable relation.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
