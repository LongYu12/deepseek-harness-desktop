// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { PluginImportTab } from '../src/client/PluginImportTab.tsx'
import type { PluginImportTabInjected } from '../src/client/PluginImportTab.tsx'
import { PluginStoreSettingsTab } from '../src/client/PluginStoreSettingsTab.tsx'
import type { PluginStoreSettingsTabInjected } from '../src/client/PluginStoreSettingsTab.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const CATALOG = { source: 'builtin', entries: [] }
const INVENTORY = { bundles: [], entries: [], restartNeeded: false }
const MUTATION = { ok: true, restartNeeded: false, message: 'done' }

type RemoteOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

function remoteFace() {
  return {
    catalog: vi.fn<() => Promise<RemoteOutcome<typeof CATALOG>>>()
      .mockResolvedValue({ ok: true, value: CATALOG }),
    inventory: vi.fn<() => Promise<RemoteOutcome<typeof INVENTORY>>>()
      .mockResolvedValue({ ok: true, value: INVENTORY }),
    installBundle: vi.fn<(packageName: string) => Promise<RemoteOutcome<typeof MUTATION>>>()
      .mockResolvedValue({ ok: true, value: MUTATION }),
    removeBundle: vi.fn<(packageName: string) => Promise<RemoteOutcome<typeof MUTATION>>>()
      .mockResolvedValue({ ok: true, value: MUTATION }),
    updateBundle: vi.fn<(packageName: string) => Promise<RemoteOutcome<typeof MUTATION>>>()
      .mockResolvedValue({ ok: true, value: MUTATION }),
    setEntryEnabled: vi.fn<(entryId: string, enabled: boolean) => Promise<RemoteOutcome<typeof MUTATION>>>()
      .mockResolvedValue({ ok: true, value: MUTATION }),
    importBundle: vi.fn<(gitSpec: string) => Promise<RemoteOutcome<typeof MUTATION>>>()
      .mockResolvedValue({ ok: true, value: MUTATION }),
  }
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const remote = remoteFace()
  ctx.provide('remote.pluginStore', remote)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, remote }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-plugin-store browser plugin', () => {
  it('declares only the services used by the Settings Remote contribution', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.pluginStore'])
  })

  it('registers the store and import tabs and unwraps every Remote method', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entries = b.slots.entries('settings.plugins.tab')
    expect(entries).toHaveLength(2)

    const storeEntry = entries[0]!
    expect(storeEntry.component).toBe(PluginStoreSettingsTab)
    expect(storeEntry.options).toMatchObject({ id: 'store', order: 20 })
    expect(storeEntry.locale).toBe(NS)
    expect(resolveSlotLabel(storeEntry.options.label)).toBe('插件商店')
    expect(b.remote.catalog).not.toHaveBeenCalled()

    const injected = (storeEntry.inject as unknown as () => PluginStoreSettingsTabInjected)()
    await expect(injected.catalog()).resolves.toEqual(CATALOG)
    await expect(injected.inventory()).resolves.toEqual(INVENTORY)
    await expect(injected.install('@fixture/one')).resolves.toEqual(MUTATION)
    await expect(injected.remove('@fixture/one')).resolves.toEqual(MUTATION)
    await expect(injected.update('@fixture/one')).resolves.toEqual(MUTATION)
    await expect(injected.setEntryEnabled('entry-1', false)).resolves.toEqual(MUTATION)
    expect(b.remote.installBundle).toHaveBeenCalledWith('@fixture/one')
    expect(b.remote.setEntryEnabled).toHaveBeenCalledWith('entry-1', false)

    const importEntry = entries[1]!
    expect(importEntry.component).toBe(PluginImportTab)
    expect(importEntry.options).toMatchObject({ id: 'import', order: 30 })
    expect(importEntry.locale).toBe(NS)
    expect(resolveSlotLabel(importEntry.options.label)).toBe('插件导入')
    const importInjected = (importEntry.inject as unknown as () => PluginImportTabInjected)()
    await expect(importInjected.importBundle('github:owner/repo')).resolves.toEqual(MUTATION)
    expect(b.remote.importBundle).toHaveBeenCalledWith('github:owner/repo')
    // A successful import notifies the store tab to re-read its inventory;
    // the notification dies with its subscriber.
    const refresh = vi.fn()
    const unsubscribe = injected.subscribeInventoryChanged(refresh)
    importInjected.notifyInventoryChanged()
    expect(refresh).toHaveBeenCalledTimes(1)
    unsubscribe()
    importInjected.notifyInventoryChanged()
    expect(refresh).toHaveBeenCalledTimes(1)
    await b.ctx.fiber.dispose()
  })

  it('turns every Remote failure into a loud pluginStore error', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entries = b.slots.entries('settings.plugins.tab')
    const injected = ((entries[0]!.inject) as unknown as () => PluginStoreSettingsTabInjected)()
    const importInjected = ((entries[1]!.inject) as unknown as () => PluginImportTabInjected)()

    const failure = { ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } } as const
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['catalog', () => {
        b.remote.catalog.mockResolvedValueOnce(failure)
        return injected.catalog()
      }],
      ['inventory', () => {
        b.remote.inventory.mockResolvedValueOnce(failure)
        return injected.inventory()
      }],
      ['installBundle', () => {
        b.remote.installBundle.mockResolvedValueOnce(failure)
        return injected.install('@fixture/one')
      }],
      ['removeBundle', () => {
        b.remote.removeBundle.mockResolvedValueOnce(failure)
        return injected.remove('@fixture/one')
      }],
      ['updateBundle', () => {
        b.remote.updateBundle.mockResolvedValueOnce(failure)
        return injected.update('@fixture/one')
      }],
      ['setEntryEnabled', () => {
        b.remote.setEntryEnabled.mockResolvedValueOnce(failure)
        return injected.setEntryEnabled('entry-1', true)
      }],
      ['importBundle', () => {
        b.remote.importBundle.mockResolvedValueOnce(failure)
        return importInjected.importBundle('github:owner/repo')
      }],
    ]
    for (const [method, call] of cases) {
      await expect(call()).rejects.toThrow(`pluginStore.${method} failed: REMOTE_ERROR: unavailable`)
    }
    await b.ctx.fiber.dispose()
  })

  it('follows locale and recovers across late declaration and declarer reload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(2) })
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.plugins.tab')[0]!.options.label)).toBe('Plugin store')
    expect(resolveSlotLabel(b.slots.entries('settings.plugins.tab')[1]!.options.label)).toBe('Import plugin')

    stop()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => {
      expect(b.slots.entries('settings.plugins.tab')[0]?.component).toBe(PluginStoreSettingsTab)
    })

    await fiber.dispose()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })
})
