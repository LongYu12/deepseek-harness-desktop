import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  PluginStoreInventory,
  StoreCatalog,
  StoreCatalogEntry,
  StoreMutationProgress,
  StoreMutationResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import { IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PluginStoreSettingsTab.module.css'

/** Registration-side Remote face used by the store tab. */
export interface PluginStoreSettingsTabInjected {
  /** Read the store catalog (built-in or the configured remote index). */
  catalog: () => Promise<StoreCatalog>
  /** Read installed bundles plus loaded-entry enablement state. */
  inventory: () => Promise<PluginStoreInventory>
  /** Install a registry package into the active profile. */
  install: (packageName: string) => Promise<StoreMutationResult>
  /** Remove an installed bundle from the active profile. */
  remove: (packageName: string) => Promise<StoreMutationResult>
  /** Update an installed bundle to its latest registry version. */
  update: (packageName: string) => Promise<StoreMutationResult>
  /** Enable or disable a loaded entry through the store patch layer. */
  setEntryEnabled: (entryId: string, enabled: boolean) => Promise<StoreMutationResult>
  /** Materialize the profile user patch layer and open it in a text editor. */
  openStoreConfig: () => Promise<StoreMutationResult>
  /** Subscribe to live store mutation progress; returns the disposer. */
  subscribeProgress: (listener: (progress: StoreMutationProgress) => void) => () => void
  /** Subscribe to a store inventory refresh request; returns the disposer. */
  subscribeInventoryChanged: (listener: () => void) => () => void
}

/** Full component props assembled by the Settings slot renderer. */
export type PluginStoreSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginStore'>
  & InjectFace<PluginStoreSettingsTabInjected>

type CatalogState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly catalog: StoreCatalog }

type InventoryState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly inventory: PluginStoreInventory }

/** In-flight bundle mutation keyed by package name. */
type BundleMutation = 'install' | 'remove' | 'update'

/** Delay before the post-toggle settle refresh reads the recomposed Loader state. */
const ENTRY_SETTLE_REFRESH_MS = 800

interface Notice {
  readonly kind: 'success' | 'error'
  readonly text: string
}

/** Whether a catalog entry matches the local search query. */
function matches(entry: StoreCatalogEntry, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [entry.name, entry.description, entry.descriptionZh, entry.author, ...entry.tags]
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

/** Render the plugin store: catalog browsing plus installed bundle and entry management. */
export function PluginStoreSettingsTab(injected: PluginStoreSettingsTabProps): ReactNode {
  const {
    catalog, inventory, install, remove, update, setEntryEnabled, openStoreConfig,
    subscribeProgress, subscribeInventoryChanged, t,
  } = injected

  const [catalogRequest, setCatalogRequest] = useState(0)
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: 'loading' })
  const [inventoryRequest, setInventoryRequest] = useState(0)
  const [inventoryState, setInventoryState] = useState<InventoryState>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<Record<string, BundleMutation>>({})
  const [entryBusy, setEntryBusy] = useState<Record<string, boolean>>({})
  const [configBusy, setConfigBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  /** Latest progress line per mutation target (bundle name on the wire). */
  const [progressByTarget, setProgressByTarget] = useState<Record<string, StoreMutationProgress>>({})
  const settleTimers = useRef(new Set<ReturnType<typeof setTimeout>>())

  useEffect(() => subscribeProgress((next) => {
    setProgressByTarget(previous => ({ ...previous, [next.target]: next }))
  }), [subscribeProgress])

  useEffect(() => {
    const timers = settleTimers.current
    return () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => catalog()).then(
      (loaded) => { if (current) setCatalogState({ status: 'ready', catalog: loaded }) },
      () => { if (current) setCatalogState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [catalog, catalogRequest])

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => inventory()).then(
      (loaded) => { if (current) setInventoryState({ status: 'ready', inventory: loaded }) },
      () => { if (current) setInventoryState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [inventory, inventoryRequest])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredEntries = useMemo(
    () => catalogState.status === 'ready'
      ? catalogState.catalog.entries.filter(entry => matches(entry, normalizedQuery))
      : [],
    [normalizedQuery, catalogState],
  )

  const installedNames = useMemo(() => {
    const names = new Set<string>()
    if (inventoryState.status === 'ready') {
      for (const bundle of inventoryState.inventory.bundles) names.add(bundle.packageName)
    }
    return names
  }, [inventoryState])

  const zhActive = t('localeId') === 'zh'

  const refreshInventory = (): void => {
    setInventoryState({ status: 'loading' })
    setInventoryRequest(value => value + 1)
  }

  // An import in the sibling tab mutates the same profile manifest this
  // inventory reads, so the host-side success notifies a re-read here.
  useEffect(() => subscribeInventoryChanged(() => { refreshInventory() }), [subscribeInventoryChanged])

  // The patch layer recomposes hot after a toggle; a second read picks up the
  // Loader state once that settles.
  const scheduleSettleRefresh = (): void => {
    const timer = setTimeout(() => {
      settleTimers.current.delete(timer)
      refreshInventory()
    }, ENTRY_SETTLE_REFRESH_MS)
    settleTimers.current.add(timer)
  }

  const mutate = async (mutation: BundleMutation, packageName: string): Promise<void> => {
    setBusy(previous => ({ ...previous, [packageName]: mutation }))
    try {
      const operation = mutation === 'install' ? install : mutation === 'remove' ? remove : update
      const result = await operation(packageName)
      setNotice({ kind: result.ok ? 'success' : 'error', text: result.message })
      refreshInventory()
    } catch (error) {
      // The host Remote failure carries the pnpm or validation diagnostic;
      // a generic notice without it left every failed install unexplained.
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('mutationFailed') })
    } finally {
      setBusy((previous) => {
        return Object.fromEntries(Object.entries(previous).filter(([key]) => key !== packageName))
      })
    }
  }

  const toggleEntry = async (entryId: string, enabled: boolean): Promise<void> => {
    setEntryBusy(previous => ({ ...previous, [entryId]: true }))
    try {
      const result = await setEntryEnabled(entryId, enabled)
      setNotice({ kind: result.ok ? 'success' : 'error', text: result.message })
      refreshInventory()
      if (result.ok) scheduleSettleRefresh()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('mutationFailed') })
    } finally {
      setEntryBusy(previous => ({ ...previous, [entryId]: false }))
    }
  }

  const openConfig = async (): Promise<void> => {
    setConfigBusy(true)
    try {
      const result = await openStoreConfig()
      setNotice({ kind: result.ok ? 'success' : 'error', text: result.message })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('openConfigFailed') })
    } finally {
      setConfigBusy(false)
    }
  }

  const retryCatalog = (): void => {
    setCatalogState({ status: 'loading' })
    setCatalogRequest(value => value + 1)
  }

  const retryInventory = (): void => {
    refreshInventory()
  }

  return (
    <div className={css.section} aria-busy={catalogState.status === 'loading' || inventoryState.status === 'loading'}>
      <div className={css.toolbar}>
        <button
          type="button"
          disabled={configBusy}
          data-action="open-config"
          onClick={() => { void openConfig() }}
        >
          {configBusy ? t('openingConfig') : t('openConfig')}
        </button>
      </div>
      {notice !== null ? (
        <p
          className={css.notice}
          role="status"
          data-notice={notice.kind}
        >
          {notice.text}
        </p>
      ) : null}
      {catalogState.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {catalogState.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retryCatalog}>{t('retry')}</button>
        </div>
      ) : null}
      {catalogState.status === 'ready' ? (
        <div className={css.catalog}>
          <label className={css.search}>
            <IconSearchOutline16 aria-hidden="true" />
            <span className={css.visuallyHidden}>{t('search')}</span>
            <input
              type="search"
              value={query}
              placeholder={t('search')}
              aria-label={t('search')}
              onChange={(event) => { setQuery(event.currentTarget.value) }}
            />
          </label>
          <div className={css.catalogHeading}>
            <h3>{t('catalog')}</h3>
            <span data-catalog-count={filteredEntries.length}>{filteredEntries.length}</span>
          </div>
          {catalogState.catalog.entries.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
          {catalogState.catalog.entries.length > 0 && filteredEntries.length === 0
            ? <p className={css.status}>{t('emptySearch')}</p>
            : null}
          {filteredEntries.length > 0 ? (
            <ul className={css.cards}>
              {filteredEntries.map((entry) => {
                const isInstalled = installedNames.has(entry.name)
                const pending = busy[entry.name]
                const cardProgress = progressByTarget[entry.name]
                const description = zhActive ? entry.descriptionZh : entry.description
                return (
                  <li className={css.card} key={entry.name} data-store-entry={entry.name}>
                    <div className={css.cardContent}>
                      <strong className={css.cardTitle} title={entry.name}>{entry.name}</strong>
                      {isInstalled
                        ? (
                          <div className={css.cardActions}>
                            <span className={css.configTag} data-installed="true">{t('installedTag')}</span>
                            <button
                              type="button"
                              disabled={pending !== undefined}
                              data-action="uninstall"
                              onClick={() => { void mutate('remove', entry.name) }}
                            >
                              {pending === 'remove' ? t('uninstalling') : t('uninstall')}
                            </button>
                          </div>
                        )
                        : (
                          <button
                            type="button"
                            disabled={pending !== undefined}
                            data-action="install"
                            onClick={() => { void mutate('install', entry.name) }}
                          >
                            {pending === 'install' ? t('installing') : t('install')}
                          </button>
                        )}
                    </div>
                    {pending !== undefined ? (
                      <div className={css.cardProgress} role="status" data-progress-target={entry.name}>
                        <progress aria-label={t('progressLabel')} />
                        {cardProgress !== undefined
                          ? <p className={css.progressLine}>{cardProgress.line}</p>
                          : <p className={css.progressLine}>{pending === 'remove' ? t('uninstalling') : t('installing')}</p>}
                      </div>
                    ) : null}
                    <div className={css.cardDetails}>
                      <p className={css.description}>{description}</p>
                      {entry.author !== '' ? <p className={css.meta}>{entry.author}</p> : null}
                      {entry.tags.length > 0 ? (
                        <ul className={css.tags}>
                          {entry.tags.map(tag => <li key={tag}>{tag}</li>)}
                        </ul>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
      {inventoryState.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retryInventory}>{t('retry')}</button>
        </div>
      ) : null}
      {inventoryState.status === 'ready' ? (
        <div className={css.installed}>
          {inventoryState.inventory.restartNeeded ? <p className={css.restart}>{t('restartHint')}</p> : null}
          <div className={css.catalogHeading}>
            <h3>{t('installed')}</h3>
            <span data-bundle-count={inventoryState.inventory.bundles.length}>
              {inventoryState.inventory.bundles.length}
            </span>
          </div>
          {inventoryState.inventory.bundles.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
          {inventoryState.inventory.bundles.length > 0 ? (
            <ul className={css.rows}>
              {inventoryState.inventory.bundles.map((bundle) => {
                const pending = busy[bundle.packageName]
                return (
                  <li className={css.row} key={bundle.packageName} data-bundle={bundle.packageName}>
                    <div className={css.rowIdentity}>
                      <strong className={css.cardTitle}>{bundle.packageName}</strong>
                      <span className={css.meta}>
                        {t('version')}
                        :
                        {' '}
                        {bundle.version ?? t('unknownVersion')}
                      </span>
                      {bundle.restartNeeded ? <span className={css.restartTag}>{t('restartHint')}</span> : null}
                    </div>
                    <div className={css.rowActions}>
                      <button
                        type="button"
                        disabled={pending !== undefined}
                        data-action="update"
                        onClick={() => { void mutate('update', bundle.packageName) }}
                      >
                        {pending === 'update' ? t('updating') : t('update')}
                      </button>
                      <button
                        type="button"
                        disabled={pending !== undefined}
                        data-action="uninstall"
                        onClick={() => { void mutate('remove', bundle.packageName) }}
                      >
                        {pending === 'remove' ? t('uninstalling') : t('uninstall')}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : null}
          {inventoryState.inventory.entries.length > 0 ? (
            <>
              <div className={css.catalogHeading}>
                <h3>{t('entries')}</h3>
                <span data-entry-count={inventoryState.inventory.entries.length}>
                  {inventoryState.inventory.entries.length}
                </span>
              </div>
              <ul className={css.rows}>
                {inventoryState.inventory.entries.map((entry) => {
                  const pending = entryBusy[entry.entryId] === true
                  // The store layer only removes its own disable mark, so an
                  // entry disabled elsewhere cannot be re-enabled from here.
                  const locked = !entry.enabled && !entry.storeDisabled
                  return (
                    <li className={css.row} key={entry.entryId} data-entry-toggle={entry.entryId}>
                      <div className={css.rowIdentity}>
                        <strong className={css.cardTitle}>{entry.moduleName}</strong>
                        <span className={css.configTag} data-enabled={entry.enabled ? 'true' : 'false'}>
                          {entry.enabled ? t('enabledTag') : t('disabledTag')}
                        </span>
                        {locked ? <span className={css.lockedHint}>{t('lockedHint')}</span> : null}
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={entry.enabled}
                        disabled={pending || locked}
                        title={locked ? t('lockedHint') : undefined}
                        data-action="toggle"
                        onClick={() => { void toggleEntry(entry.entryId, !entry.enabled) }}
                      >
                        {pending ? t('toggling') : entry.enabled ? t('disable') : t('enable')}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

    </div>
  )
}
