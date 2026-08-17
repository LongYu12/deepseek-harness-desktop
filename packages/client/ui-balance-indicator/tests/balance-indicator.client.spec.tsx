// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { BalanceIndicatorController } from '../src/client/controller.ts'
import { BalanceIndicator, formatBalance, type BalanceIndicatorProps } from '../src/client/BalanceIndicator.tsx'
import { en } from '../src/client/locales.ts'

const SID = 'session-balance-capsule' as SessionId

const BALANCES = [{ currency: 'CNY', availableBalance: 12.5, totalBalance: 100 }]

function ok<T>(value: T) {
  return { result: { ok: true as const, value } }
}

function err(message: string) {
  return { result: { ok: false as const, error: { code: 'balance-query-failed', message } } }
}

function fakeApi(balanceResult: () => Promise<unknown> = async () => ok({ balances: BALANCES })) {
  const models = vi.fn(async () => ok({
    current: { provider: 'deepseek-official', model: 'deepseek-chat' },
    routable: true,
    groups: [],
    failures: [],
  }))
  const balance = vi.fn(balanceResult)
  return { api: { sessions: { models }, llm: { balance } } as unknown as IApiClient, models, balance }
}

function bindBalance(controller: BalanceIndicatorController) {
  return function useBalance<T>(selector: (state: ReturnType<typeof controller.store.getSnapshot>) => T): T {
    return useSyncExternalStore(
      listener => controller.store.subscribe(listener),
      () => selector(controller.store.getSnapshot()),
    )
  }
}

const t = (key: keyof typeof en, params?: Record<string, unknown>): string =>
  en[key].replace(/\{(\w+)\}/g, (match, name: string) => (params !== undefined && name in params ? String(params[name]) : match))

function bench(api: IApiClient) {
  const controller = new BalanceIndicatorController(api)
  const load = vi.fn((sessionId: SessionId) => controller.load(sessionId))
  const refresh = vi.fn((sessionId: SessionId) => controller.refresh(sessionId))
  const props = {
    sessionId: SID,
    useBalance: bindBalance(controller),
    load,
    refresh,
    t,
  } as unknown as BalanceIndicatorProps
  const view = render(<BalanceIndicator {...props} />)
  return { controller, load, refresh, view }
}

afterEach(cleanup)

describe('formatBalance', () => {
  it('maps known currencies to their symbols and pins two decimals', () => {
    expect(formatBalance(BALANCES)).toEqual({ symbol: '¥', amount: '12.50' })
    expect(formatBalance([{ currency: 'USD', availableBalance: 3, totalBalance: 5 }])).toEqual({ symbol: '$', amount: '3.00' })
    expect(formatBalance([{ currency: 'EUR', availableBalance: 1, totalBalance: 2 }])).toEqual({ symbol: '€', amount: '1.00' })
  })

  it('prefixes an unknown currency code and reports no display for an empty list', () => {
    expect(formatBalance([{ currency: 'JPY', availableBalance: 4, totalBalance: 4 }])).toEqual({ symbol: 'JPY ', amount: '4.00' })
    expect(formatBalance([])).toBeUndefined()
  })
})

describe('BalanceIndicator capsule', () => {
  it('fetches once on mount and presents the localized available balance', async () => {
    const b = bench(fakeApi().api)
    expect(b.view.getByRole('button').textContent).toBe('…')
    await waitFor(() => { expect(b.view.getByRole('button').textContent).toBe('Balance ¥12.50') })
    expect(b.load).toHaveBeenCalledWith(SID)
  })

  it('presents the unsupported/failure state as dashes and refreshes on click', async () => {
    const fake = fakeApi(async () => err('balance-unsupported'))
    const b = bench(fake.api)
    await waitFor(() => { expect(b.view.getByRole('button').textContent).toBe('--') })
    fireEvent.click(b.view.getByRole('button'))
    await waitFor(() => { expect(fake.balance).toHaveBeenCalledTimes(2) })
    expect(b.refresh).toHaveBeenCalledWith(SID)
    expect(b.view.getByRole('button').textContent).toBe('--')
  })

  it('marks the capsule busy while the balance query is in flight', async () => {
    let release!: (value: unknown) => void
    const fake = fakeApi(() => new Promise((resolve) => { release = resolve }))
    const b = bench(fake.api)
    const button = b.view.getByRole('button')
    await waitFor(() => { expect(button.getAttribute('aria-busy')).toBe('true') })
    release(ok({ balances: BALANCES }))
    await waitFor(() => { expect(button.getAttribute('aria-busy')).toBe('false') })
  })
})
