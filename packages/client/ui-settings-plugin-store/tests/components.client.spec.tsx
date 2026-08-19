// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoreMutationProgress } from '@deepseek-ai/dsh-api-remotes/client'
import { HotReloadAction } from '../src/client/HotReloadAction.tsx'
import type { HotReloadActionInjected, HotReloadActionProps } from '../src/client/HotReloadAction.tsx'
import { PluginImportTab } from '../src/client/PluginImportTab.tsx'
import type {
  PluginImportTabInjected,
  PluginImportTabProps,
} from '../src/client/PluginImportTab.tsx'
import { PluginStoreSettingsTab } from '../src/client/PluginStoreSettingsTab.tsx'
import type {
  PluginStoreSettingsTabInjected,
  PluginStoreSettingsTabProps,
} from '../src/client/PluginStoreSettingsTab.tsx'
import { en, zh, type PluginStoreLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

type Catalog = Awaited<ReturnType<PluginStoreSettingsTabInjected['catalog']>>
type Inventory = Awaited<ReturnType<PluginStoreSettingsTabInjected['inventory']>>
type Mutation = Awaited<ReturnType<PluginStoreSettingsTabInjected['install']>>

type TabT = (key: PluginStoreLocaleKey) => string

const enT: TabT = key => en[key]
const zhT: TabT = key => zh[key]

const CATALOG = {
  source: 'builtin',
  entries: [
    {
      name: '@deepseek-ai/dsh-base',
      description: 'Base bundle',
      descriptionZh: '基础包',
      author: 'DeepSeek',
      tags: ['core', 'boot'],
    },
    {
      name: '@fixture/empty-meta',
      description: 'No meta entry',
      descriptionZh: '无元信息条目',
      author: '',
      tags: [],
    },
  ],
} as unknown as Catalog

const INVENTORY: Inventory = {
  bundles: [
    { packageName: '@deepseek-ai/dsh-base', version: '0.1.0', restartNeeded: true },
    { packageName: '@fixture/ghost', version: null, restartNeeded: false },
  ],
  entries: [
    { entryId: 'entry-active', moduleName: '@deepseek-ai/dsh-host-plugin-store', enabled: true, storeDisabled: false },
    { entryId: 'entry-disabled', moduleName: '@fixture/disabled-module', enabled: false, storeDisabled: true },
  ],
  restartNeeded: true,
}

const OK_MUTATION = { ok: true, restartNeeded: true, message: 'mutation done' } as Mutation
const FAILED_MUTATION = { ok: false, restartNeeded: false, message: 'pnpm exploded' } as Mutation

function face(overrides: Partial<PluginStoreSettingsTabInjected> = {}): PluginStoreSettingsTabInjected {
  return {
    catalog: vi.fn<PluginStoreSettingsTabInjected['catalog']>().mockResolvedValue(CATALOG),
    inventory: vi.fn<PluginStoreSettingsTabInjected['inventory']>().mockResolvedValue(INVENTORY),
    install: vi.fn<PluginStoreSettingsTabInjected['install']>().mockResolvedValue(OK_MUTATION),
    remove: vi.fn<PluginStoreSettingsTabInjected['remove']>().mockResolvedValue(OK_MUTATION),
    update: vi.fn<PluginStoreSettingsTabInjected['update']>().mockResolvedValue(OK_MUTATION),
    setEntryEnabled: vi.fn<PluginStoreSettingsTabInjected['setEntryEnabled']>().mockResolvedValue(OK_MUTATION),
    openStoreConfig: vi.fn<PluginStoreSettingsTabInjected['openStoreConfig']>().mockResolvedValue(OK_MUTATION),
    subscribeProgress: vi.fn<PluginStoreSettingsTabInjected['subscribeProgress']>().mockReturnValue(() => {}),
    subscribeInventoryChanged: vi.fn<PluginStoreSettingsTabInjected['subscribeInventoryChanged']>().mockReturnValue(() => {}),
    ...overrides,
  }
}

/** A subscribe mock capturing listeners for manual progress emission. */
function captureSubscriptions(): {
  subscribe: (listener: (progress: StoreMutationProgress) => void) => () => void
  listeners: ((progress: StoreMutationProgress) => void)[]
  emit: (progress: StoreMutationProgress) => void
} {
  const listeners: ((progress: StoreMutationProgress) => void)[] = []
  return {
    subscribe: (listener) => { listeners.push(listener); return () => {} },
    listeners,
    emit: (progress) => { for (const listener of listeners) listener(progress) },
  }
}

function renderTab(
  injected: PluginStoreSettingsTabInjected,
  t: TabT = enT,
) {
  return render(<PluginStoreSettingsTab {...({ t, ...injected } as unknown as PluginStoreSettingsTabProps)} />)
}

function importFace(overrides: Partial<PluginImportTabInjected> = {}): PluginImportTabInjected {
  return {
    importBundle: vi.fn<PluginImportTabInjected['importBundle']>().mockResolvedValue(OK_MUTATION),
    subscribeProgress: vi.fn<PluginImportTabInjected['subscribeProgress']>().mockReturnValue(() => {}),
    notifyInventoryChanged: vi.fn<PluginImportTabInjected['notifyInventoryChanged']>(),
    ...overrides,
  }
}

function renderImport(injected: PluginImportTabInjected, t: TabT = enT): { container: HTMLElement } {
  return render(<PluginImportTab {...({ t, ...injected } as unknown as PluginImportTabProps)} />)
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

function catalogCards(view: { container: HTMLElement }): NodeListOf<Element> {
  return view.container.querySelectorAll('[data-store-entry]')
}

describe('PluginStoreSettingsTab', () => {
  it('renders the catalog and installed sections after both loads settle', async () => {
    const injected = face()
    const view = renderTab(injected)
    expect(screen.getByText(en.loading)).toBeTruthy()
    expect(view.container.firstElementChild!.getAttribute('aria-busy')).toBe('true')

    await settle()
    expect(injected.catalog).toHaveBeenCalledOnce()
    expect(injected.inventory).toHaveBeenCalledOnce()
    expect(view.container.firstElementChild!.getAttribute('aria-busy')).toBe('false')
    expect(screen.getByRole('searchbox', { name: en.search })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.catalog })).toBeTruthy()
    expect(view.container.querySelector('[data-catalog-count]')?.textContent).toBe('2')

    // English copy drives the zh/en description pick.
    expect(screen.getByText('Base bundle')).toBeTruthy()
    expect(screen.getByText('DeepSeek')).toBeTruthy()
    expect(screen.getByText('core')).toBeTruthy()
    expect(screen.getByText('boot')).toBeTruthy()
    // The empty-meta card omits author and tag lists.
    expect(screen.getByText('No meta entry')).toBeTruthy()

    // Install button only for the not-installed entry.
    expect(screen.getAllByRole('button', { name: en.install })).toHaveLength(1)
    expect(view.container.querySelector('[data-installed]')?.textContent).toBe(en.installedTag)
    // An installed catalog card offers its own uninstall action next to the tag.
    const installedCard = view.container.querySelector('[data-store-entry="@deepseek-ai/dsh-base"]')!
    expect(installedCard.querySelector('[data-action="uninstall"]')?.textContent).toBe(en.uninstall)

    // Installed section: versions, restart hints, and row actions.
    expect(screen.getByRole('heading', { name: en.installed })).toBeTruthy()
    expect(view.container.querySelector('[data-bundle-count]')?.textContent).toBe('2')
    expect(view.container.querySelector('[data-bundle="@deepseek-ai/dsh-base"]')?.textContent).toContain('0.1.0')
    expect(view.container.querySelector('[data-bundle="@fixture/ghost"]')?.textContent).toContain(en.unknownVersion)
    expect(screen.getAllByText(en.restartHint).length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByRole('button', { name: en.update })).toHaveLength(2)
    // One card-level uninstall plus the two installed-bundle rows.
    expect(screen.getAllByRole('button', { name: en.uninstall })).toHaveLength(3)

    // Entry switches reflect enabled state; tags show state, buttons show the action.
    expect(screen.getByRole('heading', { name: en.entries })).toBeTruthy()
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(2)
    expect(switches[0]?.getAttribute('aria-checked')).toBe('true')
    expect(switches[0]?.textContent).toBe(en.disable)
    expect(switches[1]?.getAttribute('aria-checked')).toBe('false')
    expect(switches[1]?.textContent).toBe(en.enable)
    expect(screen.getByText(en.enabledTag)).toBeTruthy()
    expect(screen.getByText(en.disabledTag)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.openConfig })).toBeTruthy()
  })

  it('picks the Chinese description when the locale dictionary says zh', async () => {
    renderTab(face(), zhT)
    await settle()
    expect(screen.getByText('基础包')).toBeTruthy()
    expect(screen.queryByText('Base bundle')).toBeNull()
  })

  it('filters the catalog by name, description, and tags', async () => {
    const view = renderTab(face())
    const search = await screen.findByRole('searchbox', { name: en.search })

    fireEvent.change(search, { target: { value: 'empty-meta' } })
    expect(catalogCards(view)).toHaveLength(1)

    fireEvent.change(search, { target: { value: 'BASE BUNDLE' } })
    expect(catalogCards(view)).toHaveLength(1)
    expect(screen.getByText('Base bundle')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'core' } })
    expect(catalogCards(view)).toHaveLength(1)

    fireEvent.change(search, { target: { value: 'nothing-here' } })
    expect(catalogCards(view)).toHaveLength(0)
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
  })

  it('shows empty states for an empty catalog and an empty installed section', async () => {
    renderTab(face({
      catalog: vi.fn<PluginStoreSettingsTabInjected['catalog']>()
        .mockResolvedValue({ source: 'builtin', entries: [] } as unknown as Catalog),
      inventory: vi.fn<PluginStoreSettingsTabInjected['inventory']>()
        .mockResolvedValue({ bundles: [], entries: [], restartNeeded: false }),
    }))
    await settle()
    expect(screen.getAllByText(en.empty).length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByText(en.restartHint)).toBeNull()
  })

  it('installs a package, surfaces the result notice, and refreshes the inventory', async () => {
    const deferred = Promise.withResolvers<Mutation>()
    const inventory = vi.fn<PluginStoreSettingsTabInjected['inventory']>()
      .mockResolvedValueOnce(INVENTORY)
      .mockResolvedValue({
        ...INVENTORY,
        bundles: [
          ...INVENTORY.bundles,
          { packageName: '@fixture/empty-meta', version: '1.0.0', restartNeeded: true },
        ],
      })
    const install = vi.fn<PluginStoreSettingsTabInjected['install']>().mockReturnValue(deferred.promise)
    const view = renderTab(face({ install, inventory }))
    await settle()

    const button = screen.getByRole('button', { name: en.install })
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: en.installing })).toBeTruthy()
    expect(install).toHaveBeenCalledWith('@fixture/empty-meta')

    await act(async () => { deferred.resolve(OK_MUTATION) })
    await waitFor(() => { expect(screen.getByText('mutation done')).toBeTruthy() })
    expect(screen.getByRole('status')?.getAttribute('data-notice')).toBe('success')
    await waitFor(() => { expect(inventory).toHaveBeenCalledTimes(2) })
    // The refreshed inventory marks the card installed: no install button left.
    await waitFor(() => { expect(screen.queryByRole('button', { name: en.install })).toBeNull() })
    expect(view.container.querySelectorAll('[data-installed]')).toHaveLength(2)
  })

  it('shows the failure message when a mutation reports not ok', async () => {
    const remove = vi.fn<PluginStoreSettingsTabInjected['remove']>().mockResolvedValue(FAILED_MUTATION)
    renderTab(face({ remove }))
    await settle()

    // The first uninstall action sits on the installed catalog card.
    fireEvent.click(screen.getAllByRole('button', { name: en.uninstall })[0]!)
    expect(remove).toHaveBeenCalledWith('@deepseek-ai/dsh-base')
    await waitFor(() => { expect(screen.getByText('pnpm exploded')).toBeTruthy() })
    expect(screen.getByRole('status')?.getAttribute('data-notice')).toBe('error')
  })

  it('streams live progress on the busy card for the matching target', async () => {
    const deferred = Promise.withResolvers<Mutation>()
    const install = vi.fn<PluginStoreSettingsTabInjected['install']>().mockReturnValue(deferred.promise)
    const subscription = captureSubscriptions()
    const view = renderTab(face({
      install,
      subscribeProgress: vi.fn<PluginStoreSettingsTabInjected['subscribeProgress']>(subscription.subscribe),
    }))
    await settle()

    fireEvent.click(screen.getByRole('button', { name: en.install }))
    const card = view.container.querySelector('[data-store-entry="@fixture/empty-meta"]')!
    expect(card.querySelector('[data-progress-target="@fixture/empty-meta"]')).toBeTruthy()
    expect(card.querySelector('progress')?.getAttribute('aria-label')).toBe(en.progressLabel)
    expect(card.textContent).toContain(en.installing)

    act(() => { subscription.emit({ operation: 'add', target: '@fixture/empty-meta', line: 'Progress: resolved 5 packages' }) })
    expect(card.textContent).toContain('Progress: resolved 5 packages')
    // Progress for a different target does not leak onto this card.
    act(() => { subscription.emit({ operation: 'add', target: 'some-other-package', line: 'ignored line' }) })
    expect(card.textContent).not.toContain('ignored line')

    await act(async () => { deferred.resolve(OK_MUTATION) })
    await waitFor(() => { expect(view.container.querySelector('[data-progress-target]')).toBeNull() })
  })

  it('uninstalls from a catalog card and returns the card to installable', async () => {
    const deferred = Promise.withResolvers<Mutation>()
    const remove = vi.fn<PluginStoreSettingsTabInjected['remove']>().mockReturnValue(deferred.promise)
    const inventory = vi.fn<PluginStoreSettingsTabInjected['inventory']>()
      .mockResolvedValueOnce(INVENTORY)
      .mockResolvedValue({
        ...INVENTORY,
        bundles: [INVENTORY.bundles[1]!],
      })
    const view = renderTab(face({ remove, inventory }))
    await settle()

    const card = view.container.querySelector('[data-store-entry="@deepseek-ai/dsh-base"]')!
    fireEvent.click(card.querySelector('[data-action="uninstall"]')!)
    expect(card.querySelector('[data-action="uninstall"]')?.textContent).toBe(en.uninstalling)
    expect(remove).toHaveBeenCalledWith('@deepseek-ai/dsh-base')

    await act(async () => { deferred.resolve(OK_MUTATION) })
    await waitFor(() => {
      expect(view.container.querySelector('[data-store-entry="@deepseek-ai/dsh-base"] [data-action="uninstall"]')).toBeNull()
    })
    expect(view.container.querySelector('[data-store-entry="@deepseek-ai/dsh-base"] [data-action="install"]')).toBeTruthy()
  })

  it('surfaces the transport error inside the mutation failure notice', async () => {
    const update = vi.fn<PluginStoreSettingsTabInjected['update']>()
      .mockRejectedValue(new Error('transport detail'))
    renderTab(face({ update }))
    await settle()

    fireEvent.click(screen.getAllByRole('button', { name: en.update })[0]!)
    await waitFor(() => { expect(screen.getByText('transport detail')).toBeTruthy() })
    expect(screen.getByRole('status')?.getAttribute('data-notice')).toBe('error')
  })

  it('runs update and uninstall with busy labels and disabled siblings', async () => {
    const deferred = Promise.withResolvers<Mutation>()
    const update = vi.fn<PluginStoreSettingsTabInjected['update']>().mockReturnValue(deferred.promise)
    renderTab(face({ update }))
    await settle()

    const firstRow = screen.getAllByRole('listitem').find(li => li.hasAttribute('data-bundle'))!
    fireEvent.click(within(firstRow).getByRole('button', { name: en.update }))
    expect(within(firstRow).getByRole('button', { name: en.updating })).toBeTruthy()
    expect(within(firstRow).getByRole('button', { name: en.uninstall }).hasAttribute('disabled')).toBe(true)

    await act(async () => { deferred.resolve(OK_MUTATION) })
    await waitFor(() => { expect(screen.queryByRole('button', { name: en.updating })).toBeNull() })
    expect(update).toHaveBeenCalledWith('@deepseek-ai/dsh-base')
  })

  it('toggles entry enablement and recovers from toggle failures', async () => {
    const setEntryEnabled = vi.fn<PluginStoreSettingsTabInjected['setEntryEnabled']>()
      .mockResolvedValueOnce(OK_MUTATION)
      .mockResolvedValueOnce(FAILED_MUTATION)
      .mockRejectedValueOnce(new Error('late failure'))
    renderTab(face({ setEntryEnabled }))
    await settle()

    const disable = screen.getAllByRole('switch')[0]!
    fireEvent.click(disable)
    expect(setEntryEnabled).toHaveBeenCalledWith('entry-active', false)
    await waitFor(() => { expect(setEntryEnabled).toHaveBeenCalledTimes(1) })
    await waitFor(() => { expect(screen.getAllByRole('switch')).toHaveLength(2) })

    fireEvent.click(screen.getAllByRole('switch')[1]!)
    expect(setEntryEnabled).toHaveBeenCalledWith('entry-disabled', true)
    await waitFor(() => { expect(screen.getByText('pnpm exploded')).toBeTruthy() })
    await waitFor(() => { expect(screen.getAllByRole('switch')).toHaveLength(2) })

    fireEvent.click(screen.getAllByRole('switch')[1]!)
    await waitFor(() => { expect(screen.getByText('late failure')).toBeTruthy() })
  })

  it('locks the switch for an entry disabled outside the store layer', async () => {
    const setEntryEnabled = vi.fn<PluginStoreSettingsTabInjected['setEntryEnabled']>()
    renderTab(face({
      setEntryEnabled,
      inventory: vi.fn<PluginStoreSettingsTabInjected['inventory']>().mockResolvedValue({
        ...INVENTORY,
        entries: [{ entryId: 'entry-locked', moduleName: '@fixture/locked-module', enabled: false, storeDisabled: false }],
      }),
    }))
    await settle()

    const locked = screen.getByRole('switch')
    expect(locked.hasAttribute('disabled')).toBe(true)
    expect(locked.textContent).toBe(en.enable)
    expect(screen.getByText(en.lockedHint)).toBeTruthy()
    fireEvent.click(locked)
    await settle()
    expect(setEntryEnabled).not.toHaveBeenCalled()
  })

  it('refreshes again once the patch layer settles after a successful toggle', async () => {
    const inventory = vi.fn<PluginStoreSettingsTabInjected['inventory']>().mockResolvedValue(INVENTORY)
    renderTab(face({ inventory }))
    await settle()
    expect(inventory).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getAllByRole('switch')[0]!)
    // Immediate refresh plus the delayed settle refresh after HMR recomposition.
    await waitFor(() => { expect(inventory).toHaveBeenCalledTimes(3) }, { timeout: 2000 })
  })

  it('opens the store config and surfaces the host message', async () => {
    const deferred = Promise.withResolvers<Mutation>()
    const openStoreConfig = vi.fn<PluginStoreSettingsTabInjected['openStoreConfig']>()
      .mockReturnValue(deferred.promise)
    renderTab(face({ openStoreConfig }))
    await settle()

    fireEvent.click(screen.getByRole('button', { name: en.openConfig }))
    expect(screen.getByRole('button', { name: en.openingConfig })).toBeTruthy()

    await act(async () => {
      deferred.resolve({ ok: true, restartNeeded: false, message: 'opened /profile/cordis.patch.yml' })
    })
    await waitFor(() => { expect(screen.getByText('opened /profile/cordis.patch.yml')).toBeTruthy() })
    expect(screen.getByRole('status')?.getAttribute('data-notice')).toBe('success')
  })

  it('shows the open-config failure notice when the remote rejects', async () => {
    const openStoreConfig = vi.fn<PluginStoreSettingsTabInjected['openStoreConfig']>()
      .mockRejectedValue(new Error('no text editor'))
    renderTab(face({ openStoreConfig }))
    await settle()

    fireEvent.click(screen.getByRole('button', { name: en.openConfig }))
    await waitFor(() => { expect(screen.getByText('no text editor')).toBeTruthy() })
    expect(screen.getByRole('status')?.getAttribute('data-notice')).toBe('error')
  })

  it('retries catalog and inventory failures independently', async () => {
    const catalog = vi.fn<PluginStoreSettingsTabInjected['catalog']>()
      .mockRejectedValueOnce(new Error('remote index down'))
      .mockResolvedValueOnce(CATALOG)
    const inventory = vi.fn<PluginStoreSettingsTabInjected['inventory']>()
      .mockRejectedValueOnce(new Error('profile unreadable'))
      .mockResolvedValueOnce(INVENTORY)
    renderTab(face({ catalog, inventory }))

    const alerts = await screen.findAllByRole('alert')
    expect(alerts).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: en.retry })).toHaveLength(2)

    // The catalog renders above the installed section, so its retry comes first.
    fireEvent.click(screen.getAllByRole('button', { name: en.retry })[0]!)
    await waitFor(() => { expect(screen.getByRole('searchbox', { name: en.search })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(screen.getByRole('heading', { name: en.installed })).toBeTruthy() })
    expect(catalog).toHaveBeenCalledTimes(2)
    expect(inventory).toHaveBeenCalledTimes(2)
  })

  it('ignores late results after unmount', async () => {
    const catalogDeferred = Promise.withResolvers<Catalog>()
    const inventoryDeferred = Promise.withResolvers<Inventory>()
    const view = renderTab(face({
      catalog: vi.fn<PluginStoreSettingsTabInjected['catalog']>().mockReturnValue(catalogDeferred.promise),
      inventory: vi.fn<PluginStoreSettingsTabInjected['inventory']>().mockReturnValue(inventoryDeferred.promise),
    }))
    view.unmount()
    await act(async () => {
      catalogDeferred.resolve(CATALOG)
      inventoryDeferred.reject(new Error('late failure'))
    })
    expect(view.container.textContent).toBe('')

    const catalogReject = Promise.withResolvers<Catalog>()
    const inventoryResolve = Promise.withResolvers<Inventory>()
    const second = renderTab(face({
      catalog: vi.fn<PluginStoreSettingsTabInjected['catalog']>().mockReturnValue(catalogReject.promise),
      inventory: vi.fn<PluginStoreSettingsTabInjected['inventory']>().mockReturnValue(inventoryResolve.promise),
    }))
    second.unmount()
    await act(async () => {
      catalogReject.reject(new Error('late catalog failure'))
      inventoryResolve.resolve(INVENTORY)
    })
    expect(second.container.textContent).toBe('')
  })
})

describe('PluginImportTab', () => {
  it('keeps the submit disabled until a spec is entered', () => {
    renderImport(importFace())
    expect(screen.getByRole('textbox', { name: en.importLabel })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.importButton }).hasAttribute('disabled')).toBe(true)
    const input = screen.getByRole('textbox', { name: en.importLabel })
    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: en.importButton }).hasAttribute('disabled')).toBe(true)
  })

  it('imports a trimmed git spec, shows the result, and flags the restart', async () => {
    const deferred = Promise.withResolvers<Mutation>()
    const importBundle = vi.fn<PluginImportTabInjected['importBundle']>().mockReturnValue(deferred.promise)
    const view = renderImport(importFace({ importBundle }))

    const input = screen.getByRole('textbox', { name: en.importLabel })
    fireEvent.change(input, { target: { value: '  github:owner/repo  ' } })
    fireEvent.click(screen.getByRole('button', { name: en.importButton }))
    expect(importBundle).toHaveBeenCalledWith('github:owner/repo')
    expect(screen.getByRole('button', { name: en.importing })).toBeTruthy()
    expect(view.container.firstElementChild!.getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      deferred.resolve({ ok: true, restartNeeded: true, message: 'pnpm add github:owner/repo succeeded' })
    })
    await waitFor(() => { expect(screen.getByRole('status')?.textContent).toContain(en.importSuccess) })
    expect(screen.getByRole('status')?.getAttribute('data-notice')).toBe('success')
    expect(screen.getByRole('status')?.textContent).toContain('pnpm add github:owner/repo succeeded')
    expect(screen.getByText(en.restartHint)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.importButton }).hasAttribute('disabled')).toBe(false)
  })

  it('shows the host message when the import reports not ok', async () => {
    const importBundle = vi.fn<PluginImportTabInjected['importBundle']>()
      .mockResolvedValue({ ok: false, restartNeeded: false, message: 'pnpm add exploded' })
    renderImport(importFace({ importBundle }))
    const input = screen.getByRole('textbox', { name: en.importLabel })
    fireEvent.change(input, { target: { value: 'git+https://example.com/repo.git' } })
    fireEvent.click(screen.getByRole('button', { name: en.importButton }))
    await waitFor(() => { expect(screen.getByRole('alert')?.textContent).toBe('pnpm add exploded') })
    expect(screen.queryByText(en.importSuccess)).toBeNull()
  })

  it('shows the generic failure when the import rejects', async () => {
    const importBundle = vi.fn<PluginImportTabInjected['importBundle']>()
      .mockRejectedValue(new Error('transport detail'))
    renderImport(importFace({ importBundle }))
    const input = screen.getByRole('textbox', { name: en.importLabel })
    fireEvent.change(input, { target: { value: 'owner/repo' } })
    fireEvent.click(screen.getByRole('button', { name: en.importButton }))
    await waitFor(() => { expect(screen.getByRole('alert')?.textContent).toBe(en.importFailed) })
    expect(screen.queryByText('transport detail')).toBeNull()
  })

  it('streams live progress lines that match the submitted spec', async () => {
    const deferred = Promise.withResolvers<Mutation>()
    const importBundle = vi.fn<PluginImportTabInjected['importBundle']>().mockReturnValue(deferred.promise)
    const subscription = captureSubscriptions()
    const view = renderImport(importFace({
      importBundle,
      subscribeProgress: vi.fn<PluginImportTabInjected['subscribeProgress']>(subscription.subscribe),
    }))
    const input = screen.getByRole('textbox', { name: en.importLabel })
    fireEvent.change(input, { target: { value: 'github:owner/repo' } })
    fireEvent.click(screen.getByRole('button', { name: en.importButton }))
    expect(view.container.querySelector('[data-progress="import"]')).toBeTruthy()
    expect(view.container.querySelector('progress')?.getAttribute('aria-label')).toBe(en.importProgressLabel)

    // A line for another target is filtered out; the matching one renders.
    act(() => { subscription.emit({ operation: 'add', target: 'other-package', line: 'ignored line' }) })
    act(() => { subscription.emit({ operation: 'add', target: 'github:owner/repo', line: 'Progress: fetching metadata' }) })
    const surface = view.container.querySelector('[data-progress="import"]')!
    expect(surface.textContent).toContain('github:owner/repo')
    expect(surface.textContent).toContain('Progress: fetching metadata')
    expect(surface.textContent).not.toContain('ignored line')

    await act(async () => { deferred.resolve(OK_MUTATION) })
    await waitFor(() => { expect(view.container.querySelector('[data-progress="import"]')).toBeNull() })
  })

  it('matches progress to the spec inside a pasted command', async () => {
    const deferred = Promise.withResolvers<Mutation>()
    const importBundle = vi.fn<PluginImportTabInjected['importBundle']>().mockReturnValue(deferred.promise)
    const subscription = captureSubscriptions()
    const view = renderImport(importFace({
      importBundle,
      subscribeProgress: vi.fn<PluginImportTabInjected['subscribeProgress']>(subscription.subscribe),
    }))
    const input = screen.getByRole('textbox', { name: en.importLabel })
    const command = 'dsh plugin --profile web add @linxin666/dsh-web-ui-all'
    fireEvent.change(input, { target: { value: command } })
    fireEvent.click(screen.getByRole('button', { name: en.importButton }))
    expect(importBundle).toHaveBeenCalledWith(command)

    // The host emits progress keyed on the resolved registry name, not the
    // pasted command; the tab projects the command onto the same key.
    act(() => { subscription.emit({ operation: 'add', target: '@linxin666/dsh-web-ui-all', line: 'Progress: resolved 42 packages' }) })
    const surface = view.container.querySelector('[data-progress="import"]')!
    expect(surface.textContent).toContain('@linxin666/dsh-web-ui-all')
    expect(surface.textContent).toContain('Progress: resolved 42 packages')

    await act(async () => { deferred.resolve(OK_MUTATION) })
    await waitFor(() => { expect(view.container.querySelector('[data-progress="import"]')).toBeNull() })
  })
})

describe('HotReloadAction', () => {
  function renderAction(overrides: Partial<HotReloadActionInjected> = {}): { hotReload: ReturnType<typeof vi.fn> } {
    const fallback = vi.fn<HotReloadActionInjected['hotReload']>().mockResolvedValue(OK_MUTATION)
    const hotReload = overrides.hotReload ?? fallback
    render(<HotReloadAction {...({ t: enT, hotReload } as unknown as HotReloadActionProps)} />)
    return { hotReload: hotReload as unknown as ReturnType<typeof vi.fn> }
  }

  it('runs the reload and shows the host outcome', async () => {
    const deferred = Promise.withResolvers<Mutation>()
    const { hotReload } = renderAction({
      hotReload: vi.fn<HotReloadActionInjected['hotReload']>().mockReturnValue(deferred.promise),
    })
    fireEvent.click(screen.getByRole('button', { name: en.hotReload }))
    expect(screen.getByRole('button', { name: en.hotReloading }).hasAttribute('disabled')).toBe(true)
    expect(hotReload).toHaveBeenCalledTimes(1)

    await act(async () => { deferred.resolve({ ok: true, restartNeeded: false, message: 'reapplied live' }) })
    await waitFor(() => { expect(screen.getByRole('status')?.textContent).toBe('reapplied live') })
    expect(screen.getByRole('button', { name: en.hotReload }).hasAttribute('disabled')).toBe(false)
  })

  it('shows the failure outcome as an alert', async () => {
    renderAction({
      hotReload: vi.fn<HotReloadActionInjected['hotReload']>()
        .mockResolvedValue({ ok: false, restartNeeded: true, message: 'no live composer' }),
    })
    fireEvent.click(screen.getByRole('button', { name: en.hotReload }))
    await waitFor(() => { expect(screen.getByRole('alert')?.textContent).toBe('no live composer') })
  })

  it('falls back to the generic copy when the remote rejects without an Error', async () => {
    // The component surfaces an Error rejection's message as the diagnostic;
    // the generic copy covers rejections that carry no Error instance.
    renderAction({
      hotReload: vi.fn<HotReloadActionInjected['hotReload']>().mockRejectedValue('transport detail'),
    })
    fireEvent.click(screen.getByRole('button', { name: en.hotReload }))
    await waitFor(() => { expect(screen.getByRole('alert')?.textContent).toBe(en.hotReloadFailed) })
  })
})
