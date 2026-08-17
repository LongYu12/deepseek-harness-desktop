/** Plugin store tab registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PluginStoreSettingsTab, type PluginStoreSettingsTabInjected } from './PluginStoreSettingsTab.tsx'
import { en, zh, type PluginStoreLocaleKey } from './locales.ts'

export type { PluginStoreSettingsTabInjected, PluginStoreSettingsTabProps } from './PluginStoreSettingsTab.tsx'
export type { PluginStoreLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin store copy. */
    'settings.pluginStore': PluginStoreLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginStore'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginStore']

/** Contribute the plugin store tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugin-store: dictionaries')

  const t = ctx.locale.bind(NS)
  const failure = (method: string, error: { readonly code: string; readonly message: string }): Error =>
    new Error(`pluginStore.${method} failed: ${error.code}: ${error.message}`)

  const catalog: PluginStoreSettingsTabInjected['catalog'] = async () => {
    const result = await ctx.remote.pluginStore.catalog()
    if (!result.ok) throw failure('catalog', result.error)
    return result.value
  }
  const inventory: PluginStoreSettingsTabInjected['inventory'] = async () => {
    const result = await ctx.remote.pluginStore.inventory()
    if (!result.ok) throw failure('inventory', result.error)
    return result.value
  }
  const install: PluginStoreSettingsTabInjected['install'] = async (packageName) => {
    const result = await ctx.remote.pluginStore.installBundle(packageName)
    if (!result.ok) throw failure('installBundle', result.error)
    return result.value
  }
  const remove: PluginStoreSettingsTabInjected['remove'] = async (packageName) => {
    const result = await ctx.remote.pluginStore.removeBundle(packageName)
    if (!result.ok) throw failure('removeBundle', result.error)
    return result.value
  }
  const update: PluginStoreSettingsTabInjected['update'] = async (packageName) => {
    const result = await ctx.remote.pluginStore.updateBundle(packageName)
    if (!result.ok) throw failure('updateBundle', result.error)
    return result.value
  }
  const setEntryEnabled: PluginStoreSettingsTabInjected['setEntryEnabled'] = async (entryId, enabled) => {
    const result = await ctx.remote.pluginStore.setEntryEnabled(entryId, enabled)
    if (!result.ok) throw failure('setEntryEnabled', result.error)
    return result.value
  }
  const injected = (): PluginStoreSettingsTabInjected =>
    ({ catalog, inventory, install, remove, update, setEntryEnabled })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'store',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PluginStoreSettingsTab))
}
