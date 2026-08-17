/** Browser plugin owning the Session Header balance capsule. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the conversation shell's SlotMap merge (the Header utilities slot).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BalanceIndicatorController } from './controller.ts'
import { BalanceIndicator, type BalanceIndicatorInjected } from './BalanceIndicator.tsx'
import { en, NS, zh, type BalanceIndicatorKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Session Header balance capsule copy. */
    'balance-indicator': BalanceIndicatorKey
  }
}

export type { BalanceEntry, BalancePhase, BalanceState } from './controller.ts'
export type { BalanceIndicatorInjected, BalanceIndicatorProps } from './BalanceIndicator.tsx'
export { formatBalance } from './BalanceIndicator.tsx'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-conversation's apply, whose activation order relative to this one is NOT
 * constrained; registration depends on the slot through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'connection']

/**
 * Provide the balance capsule left of the Session log button: a negative
 * order places it before the default-order entries of the utilities list.
 * @param ctx - browser context carrying slots, locale, and connection services.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new BalanceIndicatorController(connection.api)
  ctx.effect(() => () => { controller.dispose() }, 'ui-balance-indicator: browser balance lifecycle')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-balance-indicator: copy dictionaries')
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'balance-indicator',
    order: -10,
    locale: NS,
    inject: (): BalanceIndicatorInjected => ({
      hooks: { balance: controller.store },
      load: sessionId => controller.load(sessionId),
      refresh: sessionId => controller.refresh(sessionId),
    }),
  }, BalanceIndicator))
}
