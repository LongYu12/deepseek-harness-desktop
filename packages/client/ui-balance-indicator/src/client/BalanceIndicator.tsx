import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { BalanceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BalanceState } from './controller.ts'
import { NS } from './locales.ts'
import css from './BalanceIndicator.module.css'

/** Browser operations and state injected into the Session Header contribution. */
export interface BalanceIndicatorInjected {
  hooks: { balance: ObservableSnapshot<BalanceState> }
  load: (sessionId: SessionId) => Promise<void>
  refresh: (sessionId: SessionId) => Promise<void>
}

export type BalanceIndicatorProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>
  & InjectFace<BalanceIndicatorInjected>

/** Presentation symbols for the currencies a balance query may report. */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = { CNY: '¥', USD: '$', EUR: '€' }

/**
 * Present the first reported balance as a currency symbol plus a
 * fixed-precision amount.
 * @param balances - provider-reported account balances.
 * @returns the display parts, or undefined when the query reported none.
 */
export function formatBalance(balances: readonly BalanceView[]): { symbol: string; amount: string } | undefined {
  const first = balances[0]
  if (first === undefined) return undefined
  return {
    symbol: CURRENCY_SYMBOLS[first.currency] ?? `${first.currency} `,
    amount: first.availableBalance.toFixed(2),
  }
}

/**
 * Render the Session Header balance capsule: it fetches once on mount, shows
 * `…` while loading, `--` on failure or an unsupported provider, and the
 * available balance otherwise; a click re-fetches.
 * @param props - Session runtime, bound balance state, actions, and localized copy.
 * @returns the capsule contribution.
 */
export function BalanceIndicator({ sessionId, useBalance, load, refresh, t }: BalanceIndicatorProps): ReactNode {
  const entry = useBalance(state => state.bySession[String(sessionId)])

  useEffect(() => {
    if (entry === undefined) void load(sessionId)
  }, [entry, load, sessionId])

  const formatted = entry?.phase === 'ready' ? formatBalance(entry.balances) : undefined
  const label = entry === undefined || entry.phase === 'loading'
    ? '…'
    : formatted !== undefined
      ? t('capsule.amount', { symbol: formatted.symbol, amount: formatted.amount })
      : '--'

  return (
    <button
      type="button"
      className={formatted !== undefined ? css.balanceCapsule : `${css.balanceCapsule} ${css.dimmed}`}
      title={t('capsule.refreshTitle')}
      aria-busy={entry?.phase === 'loading'}
      onClick={() => { void refresh(sessionId) }}
    >
      <span>{label}</span>
    </button>
  )
}
