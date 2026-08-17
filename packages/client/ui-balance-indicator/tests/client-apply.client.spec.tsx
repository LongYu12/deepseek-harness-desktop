import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { BalanceIndicator } from '../src/client/BalanceIndicator.tsx'
import type { BalanceIndicatorInjected } from '../src/client/BalanceIndicator.tsx'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'

const SID = 'session-balance-apply' as SessionId

function ok<T>(value: T) {
  return { result: { ok: true as const, value } }
}

const BALANCES = [{ currency: 'CNY', availableBalance: 12.5, totalBalance: 100 }]

function fakeApi(): { api: IApiClient; balance: ReturnType<typeof vi.fn> } {
  const models = vi.fn(async () => ok({
    current: { provider: 'deepseek-official', model: 'deepseek-chat' },
    routable: true,
    groups: [],
    failures: [],
  }))
  const balance = vi.fn(async () => ok({ balances: BALANCES }))
  return { api: { sessions: { models }, llm: { balance } } as unknown as IApiClient, balance }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
}

async function bench(api: IApiClient) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declaration = declare(slots)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('connection', { api })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, declaration, fiber }
}

describe('ui-balance-indicator browser plugin', () => {
  it('contributes one capsule left of the default-order entries and removes it on disposal', async () => {
    const fake = fakeApi()
    const b = await bench(fake.api)
    expect(inject).toEqual(['slots', 'locale', 'connection'])
    applyNode()
    expect(b.slots.entries('conversation.session.header.actions')).toHaveLength(0)
    const entry = b.slots.entries('conversation.session.header.utilities')[0]
    expect(entry?.component).toBe(BalanceIndicator)
    expect(entry?.options).toMatchObject({ id: 'balance-indicator', order: -10 })

    const injected = (entry?.inject as unknown as () => BalanceIndicatorInjected)()
    await injected.load(SID)
    expect(b.ctx.slots).toBeDefined()
    const snapshot = (injected.hooks.balance.getSnapshot())
    expect(snapshot.bySession[SID]).toEqual({ phase: 'ready', provider: 'deepseek-official', balances: BALANCES })
    await injected.refresh(SID)
    expect(fake.balance).toHaveBeenCalledTimes(2)

    await b.fiber.dispose()
    expect(b.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
  })

  it('re-registers after the declaring Header slot collapses and returns', async () => {
    const b = await bench(fakeApi().api)
    b.declaration()
    expect(b.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
    const redeclare = declare(b.slots)
    await Promise.resolve()
    const entry = b.slots.entries('conversation.session.header.utilities')[0]
    expect(entry?.component).toBe(BalanceIndicator)
    expect(entry?.options).toMatchObject({ id: 'balance-indicator' })
    redeclare()
    await b.fiber.dispose()
  })
})
