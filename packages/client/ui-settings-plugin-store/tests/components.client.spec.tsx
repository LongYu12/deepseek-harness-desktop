// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    ...overrides,
  }
}

function renderTab(
  injected: PluginStoreSettingsTabInjected,
  t: TabT = enT,
) {
  return render(<PluginStoreSettingsTab {...({ t, ...injected } as unknown as PluginStoreSettingsTabProps)} />)
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

    // Installed section: versions, restart hints, and row actions.
    expect(screen.getByRole('heading', { name: en.installed })).toBeTruthy()
    expect(view.container.querySelector('[data-bundle-count]')?.textContent).toBe('2')
    expect(view.container.querySelector('[data-bundle="@deepseek-ai/dsh-base"]')?.textContent).toContain('0.1.0')
    expect(view.container.querySelector('[data-bundle="@fixture/ghost"]')?.textContent).toContain(en.unknownVersion)
    expect(screen.getAllByText(en.restartHint).length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByRole('button', { name: en.update })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: en.uninstall })).toHaveLength(2)

    // Entry switches reflect enabled state.
    expect(screen.getByRole('heading', { name: en.entries })).toBeTruthy()
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(2)
    expect(switches[0]?.getAttribute('aria-checked')).toBe('true')
    expect(switches[0]?.textContent).toBe(en.disable)
    expect(switches[1]?.getAttribute('aria-checked')).toBe('false')
    expect(switches[1]?.textContent).toBe(en.enable)
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

    fireEvent.click(screen.getAllByRole('button', { name: en.uninstall })[0]!)
    await waitFor(() => { expect(screen.getByText('pnpm exploded')).toBeTruthy() })
    expect(screen.getByRole('status')?.getAttribute('data-notice')).toBe('error')
  })

  it('contains a rejected mutation inside the generic failure notice', async () => {
    const update = vi.fn<PluginStoreSettingsTabInjected['update']>()
      .mockRejectedValue(new Error('transport detail'))
    renderTab(face({ update }))
    await settle()

    fireEvent.click(screen.getAllByRole('button', { name: en.update })[0]!)
    await waitFor(() => { expect(screen.getByText(en.mutationFailed)).toBeTruthy() })
    expect(screen.queryByText('transport detail')).toBeNull()
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
    await waitFor(() => { expect(screen.getByText(en.mutationFailed)).toBeTruthy() })
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
