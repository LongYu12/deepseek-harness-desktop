import { describe, expect, it, vi } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { BalanceIndicatorController } from '../src/client/controller.ts'

const SID = 'session-balance' as SessionId

const BALANCES = [{ currency: 'CNY', availableBalance: 12.5, totalBalance: 100 }]

function ok<T>(value: T) {
  return { result: { ok: true as const, value } }
}

function err(message: string) {
  return { result: { ok: false as const, error: { code: 'balance-query-failed', message } } }
}

function modelsValue(provider = 'deepseek-official') {
  return {
    current: { provider, model: 'deepseek-chat' },
    routable: true,
    groups: [],
    failures: [],
  }
}

interface FakeApi {
  api: IApiClient
  models: ReturnType<typeof vi.fn>
  balance: ReturnType<typeof vi.fn>
}

function fakeApi(overrides: {
  models?: () => Promise<unknown>
  balance?: () => Promise<unknown>
} = {}): FakeApi {
  const models = vi.fn(overrides.models ?? (async () => ok(modelsValue())))
  const balance = vi.fn(overrides.balance ?? (async () => ok({ balances: BALANCES })))
  const api = { sessions: { models }, llm: { balance } } as unknown as IApiClient
  return { api, models, balance }
}

describe('BalanceIndicatorController', () => {
  it('resolves the provider through the model selection and publishes the balance', async () => {
    const fake = fakeApi()
    const controller = new BalanceIndicatorController(fake.api)
    await controller.load(SID)
    expect(fake.models).toHaveBeenCalledWith({ sessionId: SID }, expect.any(AbortSignal))
    expect(fake.balance).toHaveBeenCalledWith({ provider: 'deepseek-official' }, expect.any(AbortSignal))
    expect(controller.store.getSnapshot().bySession[SID]).toEqual({
      phase: 'ready',
      provider: 'deepseek-official',
      balances: BALANCES,
    })
  })

  it('publishes a failure when the model selection rejects', async () => {
    const fake = fakeApi({ models: async () => err('no such session') })
    const controller = new BalanceIndicatorController(fake.api)
    await controller.load(SID)
    expect(fake.balance).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().bySession[SID]).toEqual({
      phase: 'failed',
      provider: null,
      balances: [],
    })
  })

  it('publishes a failure keeping the resolved provider when the balance query rejects', async () => {
    const fake = fakeApi({ balance: async () => err('balance-unsupported') })
    const controller = new BalanceIndicatorController(fake.api)
    await controller.load(SID)
    expect(controller.store.getSnapshot().bySession[SID]).toEqual({
      phase: 'failed',
      provider: 'deepseek-official',
      balances: [],
    })
  })

  it('publishes a failure when the balance query throws', async () => {
    const fake = fakeApi({ balance: async () => { throw new Error('transport down') } })
    const controller = new BalanceIndicatorController(fake.api)
    await controller.load(SID)
    expect(controller.store.getSnapshot().bySession[SID]?.phase).toBe('failed')
  })

  it('refresh reuses the resolved provider without a second model selection', async () => {
    const fake = fakeApi()
    const controller = new BalanceIndicatorController(fake.api)
    await controller.load(SID)
    await controller.refresh(SID)
    expect(fake.models).toHaveBeenCalledOnce()
    expect(fake.balance).toHaveBeenCalledTimes(2)
  })

  it('refresh without prior state falls back to the full load', async () => {
    const fake = fakeApi()
    const controller = new BalanceIndicatorController(fake.api)
    await controller.refresh(SID)
    expect(fake.models).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().bySession[SID]?.phase).toBe('ready')
  })

  it('collapses concurrent loads of one Session into a single operation', async () => {
    const fake = fakeApi()
    const controller = new BalanceIndicatorController(fake.api)
    await Promise.all([controller.load(SID), controller.load(SID)])
    expect(fake.models).toHaveBeenCalledOnce()
    expect(fake.balance).toHaveBeenCalledOnce()
  })

  it('dispose aborts in-flight queries and ignores their late resolutions', async () => {
    let releaseModels!: (value: unknown) => void
    const fake = fakeApi({
      models: () => new Promise((resolve) => { releaseModels = resolve }),
    })
    const controller = new BalanceIndicatorController(fake.api)
    const done = controller.load(SID)
    controller.dispose()
    expect(controller.store.getSnapshot().bySession[SID]?.phase).toBe('loading')
    releaseModels(ok(modelsValue()))
    await done
    expect(fake.balance).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().bySession[SID]?.phase).toBe('loading')
    // Post-disposal requests settle immediately without touching the wire.
    await controller.load(SID)
    await controller.refresh(SID)
    expect(fake.models).toHaveBeenCalledTimes(1)
  })

  it('ignores carrier rejections landing after disposal', async () => {
    let rejectModels!: (error: unknown) => void
    const fake = fakeApi({
      models: () => new Promise((_, reject) => { rejectModels = reject }),
    })
    const controller = new BalanceIndicatorController(fake.api)
    const done = controller.load(SID)
    controller.dispose()
    rejectModels(new Error('carrier aborted'))
    await done
    expect(controller.store.getSnapshot().bySession[SID]?.phase).toBe('loading')
  })

  it('passes the abort signal through to the balance query', async () => {
    let releaseBalance!: (value: unknown) => void
    const fake = fakeApi({
      balance: () => new Promise((resolve) => { releaseBalance = resolve }),
    })
    const controller = new BalanceIndicatorController(fake.api)
    const done = controller.load(SID)
    await vi.waitFor(() => { expect(fake.balance).toHaveBeenCalledOnce() })
    const signal = fake.balance.mock.calls[0]?.[1] as AbortSignal
    expect(signal.aborted).toBe(false)
    controller.dispose()
    expect(signal.aborted).toBe(true)
    releaseBalance(ok({ balances: BALANCES }))
    await done
    expect(controller.store.getSnapshot().bySession[SID]?.phase).toBe('loading')
  })
})
