/** Plugin store tab and header hot-reload action registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { StoreMutationProgress } from '@deepseek-ai/dsh-api-remotes/client'
import { HotReloadAction, type HotReloadActionInjected } from './HotReloadAction.tsx'
import { desktopShell } from './desktop-shell.ts'
import { PluginImportTab, type PluginImportTabInjected } from './PluginImportTab.tsx'
import { PluginStoreSettingsTab, type PluginStoreSettingsTabInjected } from './PluginStoreSettingsTab.tsx'
import { en, zh, type PluginStoreLocaleKey } from './locales.ts'

export type { HotReloadActionInjected, HotReloadActionProps } from './HotReloadAction.tsx'
export type { PluginImportTabInjected, PluginImportTabProps } from './PluginImportTab.tsx'
export type { PluginStoreSettingsTabInjected, PluginStoreSettingsTabProps } from './PluginStoreSettingsTab.tsx'
export type { PluginStoreLocaleKey } from './locales.ts'

/** Subscribe to live store mutation progress; returns the disposer. */
export type SubscribeStoreProgress = (listener: (progress: StoreMutationProgress) => void) => () => void

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
  const openStoreConfig: PluginStoreSettingsTabInjected['openStoreConfig'] = async () => {
    const result = await ctx.remote.pluginStore.openStoreConfig()
    if (!result.ok) throw failure('openStoreConfig', result.error)
    return result.value
  }
  const subscribeProgress: SubscribeStoreProgress = listener =>
    ctx.remote.$on('plugin-store/progress', listener)
  // Local inventory-changed bus: the import tab runs in a sibling panel of
  // the store tab, and a successful import mutates the same profile manifest
  // the store tab's inventory reads, so the import notifies the store tab to
  // re-read it.
  const inventoryListeners = new Set<() => void>()
  const notifyInventoryChanged = (): void => {
    for (const listener of [...inventoryListeners]) listener()
  }
  const subscribeInventoryChanged = (listener: () => void): () => void => {
    inventoryListeners.add(listener)
    return () => { inventoryListeners.delete(listener) }
  }
  const injected = (): PluginStoreSettingsTabInjected =>
    ({ catalog, inventory, install, remove, update, setEntryEnabled, openStoreConfig, subscribeProgress, subscribeInventoryChanged })

  const importBundle: PluginImportTabInjected['importBundle'] = async (input) => {
    const result = await ctx.remote.pluginStore.importBundle(input)
    if (!result.ok) throw failure('importBundle', result.error)
    return result.value
  }
  const importInjected = (): PluginImportTabInjected => ({ importBundle, subscribeProgress, notifyInventoryChanged })

  const hotReload: HotReloadActionInjected['hotReload'] = async () => {
    const result = await ctx.remote.pluginStore.hotReload()
    if (!result.ok) throw failure('hotReload', result.error)
    return result.value
  }
  // The desktop shell (Electron preload) restarts the app when the host
  // reports a restart is the only way to apply pending changes.
  const restartApp = desktopShell()?.restartApp

  ctx.slots.inject('settings.action', () => ctx.slots.register({
    name: 'settings.action',
    id: 'plugin-store-hot-reload',
    order: 10,
    locale: NS,
    inject: () => ({ hotReload, ...(restartApp === undefined ? {} : { restartApp }) }),
  }, HotReloadAction))

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'store',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PluginStoreSettingsTab))

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'import',
    order: 30,
    label: () => t('importTab'),
    locale: NS,
    inject: importInjected,
  }, PluginImportTab))
}
