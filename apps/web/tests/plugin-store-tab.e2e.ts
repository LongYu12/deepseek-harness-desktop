// Web e2e scenario: the plugin store tab in Plugins settings — the built-in
// catalog cards with local search, install/uninstall through the real Remote,
// command-form import with live progress, and the header hot-reload action.
// Zero model calls: everything is client state plus the store gateway on a
// blank frame, so there is no fixture and a stray stream would fail loud on
// the open llm seam. The pnpm subprocess itself is the one stand-in: a
// keyless lane cannot reach an npm registry, so the fake runner records the
// dependency the way `pnpm add` would and the real reconciliation, manifest
// write, restart flag, and progress plumbing run unchanged.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { join } from 'node:path'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/plugin-store-tab', import.meta.url))
const TAB_EXPECTED = join(SNAPSHOT_DIR, 'tab.expected.md')
const INSTALLED_EXPECTED = join(SNAPSHOT_DIR, 'installed.expected.md')
const IMPORT_EXPECTED = join(SNAPSHOT_DIR, 'import.expected.md')
const MODE = webSnapshotMode()

/** The structural face of the running gateway this scenario steers. */
interface PluginStoreGatewayUnderTest {
  runner: (args: readonly string[], cwd: string, onProgress?: (line: string) => void) =>
    | { exitCode: number; stderr: string }
    | Promise<{ exitCode: number; stderr: string }>
  /** Live profile recomposer; absent unless a scenario injects one. */
  composer?: () => Promise<void>
}

/** A promise the scenario resolves when the fake pnpm should report success. */
function deferredGate(): { promise: Promise<unknown>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<unknown>((done) => { resolve = () => done(undefined) })
  return { promise, resolve }
}

/**
 * A fake pnpm runner recording `add`/`remove` on the profile manifest and
 * materializing a bundle-declaring package under node_modules — the probe the
 * shared reconciler resolves — exactly where pnpm would put it. Progress
 * lines stream synchronously; the verdict waits on the deferred so the busy
 * surface stays observable.
 */
function installingRunner(
  deferred: { promise: Promise<unknown>; resolve: () => void },
): PluginStoreGatewayUnderTest['runner'] {
  return (args, cwd, onProgress) => {
    onProgress?.('Progress: resolved 42 packages')
    onProgress?.('Progress: done')
    const target = args[args.length - 1] ?? ''
    const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    if (args[0] === 'remove') {
      delete manifest.dependencies?.[target]
    } else {
      manifest.dependencies = { ...(manifest.dependencies ?? {}), [target]: '*' }
      mkdirSync(join(cwd, 'node_modules', ...target.split('/')), { recursive: true })
      writeFileSync(join(cwd, 'node_modules', ...target.split('/'), 'package.json'), `${JSON.stringify({
        name: target,
        version: '0.1.0',
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      }, undefined, 2)}\n`)
    }
    writeFileSync(join(cwd, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
    return deferred.promise.then(() => ({ exitCode: 0, stderr: '' }))
  }
}

describe('web e2e: plugin store tab', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let profileDir: string

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    profileDir = join(scaffold.harnessHome, 'profiles', 'scaffold')
    // The scaffold boots the shipped tree over an empty root with no manifest;
    // an initialized profile carries one, so seed the initProfile shape before
    // the store scenarios read or write it. Empty bundles match the gateway's
    // boot snapshot, keeping the first inventory restart-free.
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-scaffold',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }, undefined, 2)}\n`)
    browser = await chromium.launch()
    // Chinese browser: the tab asserts the localized copy the client derives
    // from it, as the rest of the settings surface does.
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /**
   * Open the settings dialog on the plugin store tab. The scenarios share one
   * page so the dialog and the installed state accumulate across them, so
   * this leaves any dialog a previous scenario opened closed first — its mask
   * would otherwise swallow the trigger click.
   */
  async function openStore() {
    if (await page.getByRole('dialog', { name: '设置' }).count() > 0) {
      await page.keyboard.press('Escape')
      await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 5_000 }).toBe(0)
    }
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '插件', exact: true }).click()
    await dialog.getByRole('tab', { name: '插件商店', exact: true }).click()
    await expect
      .poll(() => dialog.getByRole('tab', { name: '插件商店', exact: true }).getAttribute('aria-selected'), { timeout: 5_000 })
      .toBe('true')
    // Both reads settle before any scenario asserts on them.
    await dialog.locator('[data-store-entry]').first().waitFor({ timeout: 10_000 })
    await dialog.locator('[data-entry-toggle]').first().waitFor({ timeout: 10_000 })
    return dialog
  }

  it('renders the built-in catalog with install actions and loaded entries', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-store-tab'))
    const dialog = await openStore()

    // The shipped builtin index: the three official bundles plus the four
    // curated community entries, each installable.
    expect(await dialog.locator('[data-store-entry]').count()).toBe(7)
    for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless']) {
      const card = dialog.locator(`[data-store-entry="${name}"]`)
      expect(await card.count(), name).toBe(1)
      expect(await card.getByRole('button', { name: '安装', exact: true }).count(), name).toBe(1)
    }
    // Nothing is installed yet: the empty state, and no restart hint.
    expect(await dialog.locator('[data-bundle]').count()).toBe(0)
    expect(await dialog.getByText('暂无可用插件。').count()).toBe(1)
    expect(await dialog.getByText('有插件变更需要重启 dsh 后生效。').count()).toBe(0)
    // Loaded entries each carry an enablement switch.
    expect(await dialog.locator('[role="switch"]').count()).toBeGreaterThan(0)

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(TAB_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('filters the catalog locally by name and reports no match', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-store-search'))
    const dialog = await openStore()
    const search = dialog.getByLabel('搜索插件')

    await search.fill('headless')
    await expect.poll(() => dialog.locator('[data-store-entry]').count(), { timeout: 5_000 }).toBe(1)
    expect(await dialog.locator('[data-store-entry="@deepseek-ai/dsh-headless"]').count()).toBe(1)

    await search.fill('不存在的插件')
    await expect.poll(() => dialog.getByText('没有匹配的插件。').count(), { timeout: 5_000 }).toBe(1)
    await search.fill('')
    await expect.poll(() => dialog.locator('[data-store-entry]').count(), { timeout: 5_000 }).toBe(7)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('installs a bundle through the real Remote and reports the restart', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-store-install'))
    const dialog = await openStore()

    // The keyless stand-in for `pnpm add`: record the dependency exactly where
    // pnpm would, then let the real reconcile + manifest write + restart flag
    // run. Registry traffic is the only thing this lane cannot do.
    const gateway = (scaffold.ctx as unknown as { pluginStore?: PluginStoreGatewayUnderTest }).pluginStore
    if (gateway === undefined) throw new Error('plugin store gateway missing from the settled tree')
    gateway.runner = (args, cwd) => {
      const manifestPath = join(cwd, 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
      manifest.dependencies = { ...(manifest.dependencies ?? {}), [args[args.length - 1] ?? '']: '*' }
      writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
      return { exitCode: 0, stderr: '' }
    }

    await dialog.locator('[data-store-entry="@deepseek-ai/dsh-headless"]')
      .getByRole('button', { name: '安装', exact: true }).click()

    // The card flips to the installed tag once the refreshed inventory lists
    // the bundle, and the success notice reports the pnpm verdict.
    const card = dialog.locator('[data-store-entry="@deepseek-ai/dsh-headless"]')
    await expect.poll(() => card.locator('[data-installed]').count(), { timeout: 10_000 }).toBe(1)
    await expect
      .poll(() => dialog.getByRole('status').textContent(), { timeout: 5_000 })
      .toContain('pnpm add @deepseek-ai/dsh-headless succeeded')

    // The installed row carries update/uninstall and the restart hint: a
    // bundle join only composes at the next boot.
    const row = dialog.locator('[data-bundle="@deepseek-ai/dsh-headless"]')
    await expect.poll(() => row.count(), { timeout: 5_000 }).toBe(1)
    expect(await row.getByRole('button', { name: '更新', exact: true }).count()).toBe(1)
    expect(await row.getByRole('button', { name: '卸载', exact: true }).count()).toBe(1)
    await dialog.getByText('有插件变更需要重启 dsh 后生效。').first().waitFor({ timeout: 5_000 })

    // Durable state: the shared reconciler wrote the bundle layer.
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dependencies['@deepseek-ai/dsh-headless']).toBe('*')
    expect(manifest.dsh.profile.bundles).toContain('@deepseek-ai/dsh-headless')

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(INSTALLED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('installs and uninstalls a community catalog plugin through the Remote', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-store-community'))
    const dialog = await openStore()

    // dshmarket is the first community entry of the extended builtin index.
    const card = dialog.locator('[data-store-entry="dshmarket"]')
    await expect.poll(() => card.count(), { timeout: 5_000 }).toBe(1)

    // The keyless stand-in mirrors pnpm's `add`/`remove` on the profile
    // manifest and materializes a bundle-declaring package under node_modules
    // (the community package is outside the host's own dependency closure, so
    // the fake makes it resolvable the way a real install would). Progress
    // streams while the deferred gates the verdict, keeping the busy card
    // observable.
    const gateway = (scaffold.ctx as unknown as { pluginStore?: PluginStoreGatewayUnderTest }).pluginStore
    if (gateway === undefined) throw new Error('plugin store gateway missing from the settled tree')
    const deferred = deferredGate()
    gateway.runner = installingRunner(deferred)

    await card.getByRole('button', { name: '安装', exact: true }).click()
    // The card streams the running pnpm's stderr lines until the verdict; the
    // surface holds the latest line as lines arrive.
    await expect
      .poll(() => card.locator('[data-progress-target="dshmarket"]').getByText('Progress: done').count(), { timeout: 5_000 })
      .toBe(1)
    deferred.resolve()
    await expect.poll(() => card.locator('[data-installed]').count(), { timeout: 10_000 }).toBe(1)
    const row = dialog.locator('[data-bundle="dshmarket"]')
    await expect.poll(() => row.count(), { timeout: 5_000 }).toBe(1)

    // Uninstall from the card returns it to installable and the bundle row
    // leaves the installed list once the refreshed inventory settles.
    await card.getByRole('button', { name: '卸载', exact: true }).click()
    await expect.poll(() => card.locator('[data-action="install"]').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => row.count(), { timeout: 5_000 }).toBe(0)

    // Durable state: the shared reconciler withdrew the bundle layer entry.
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dependencies['dshmarket']).toBeUndefined()
    expect(manifest.dsh.profile.bundles).not.toContain('dshmarket')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('imports a bundle from a pasted command and streams live progress', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-store-import'))
    const dialog = await openStore()
    await dialog.getByRole('tab', { name: '插件导入', exact: true }).click()
    await expect
      .poll(() => dialog.getByRole('tab', { name: '插件导入', exact: true }).getAttribute('aria-selected'), { timeout: 5_000 })
      .toBe('true')

    // A pasted CLI command for the running profile: the store parses it,
    // guards the profile against the manifest name, and resolves the spec to
    // the registry package. The keyless stand-in records the dependency and
    // streams progress like the card installs do.
    const gateway = (scaffold.ctx as unknown as { pluginStore?: PluginStoreGatewayUnderTest }).pluginStore
    if (gateway === undefined) throw new Error('plugin store gateway missing from the settled tree')
    const deferred = deferredGate()
    gateway.runner = installingRunner(deferred)

    const progress = dialog.locator('[data-progress="import"]')
    await dialog.getByLabel('导入命令或导入目标').fill('dsh plugin --profile dsh-profile-scaffold add @linxin666/dsh-web-ui-all')
    await dialog.getByRole('button', { name: '导入', exact: true }).click()

    // The import surface streams the resolved target and the latest pnpm
    // stderr line while the deferred gates the verdict.
    await expect.poll(() => progress.getByText('@linxin666/dsh-web-ui-all').count(), { timeout: 5_000 }).toBe(1)
    await expect.poll(() => progress.getByText('Progress: done').count(), { timeout: 5_000 }).toBe(1)
    deferred.resolve()

    // Success lands the bundle in the installed list and asks for a restart.
    await expect
      .poll(() => dialog.getByText('导入成功。').count(), { timeout: 10_000 })
      .toBe(1)
    await expect
      .poll(() => dialog.getByText(/pnpm add @linxin666\/dsh-web-ui-all succeeded/).count(), { timeout: 10_000 })
      .toBe(1)
    // Back on the store tab, the imported bundle joins the installed list.
    await dialog.getByRole('tab', { name: '插件商店', exact: true }).click()
    const row = dialog.locator('[data-bundle="@linxin666/dsh-web-ui-all"]')
    await expect.poll(() => row.count(), { timeout: 5_000 }).toBe(1)
    await dialog.getByText('有插件变更需要重启 dsh 后生效。').first().waitFor({ timeout: 5_000 })

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(IMPORT_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('hot-reloads the profile patch stack from the settings header', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-store-hot-reload'))
    // The scaffold boots without a profile composer, so the scenario injects
    // a live one to exercise the success lane of the header action.
    const gateway = (scaffold.ctx as unknown as { pluginStore?: PluginStoreGatewayUnderTest }).pluginStore
    if (gateway === undefined) throw new Error('plugin store gateway missing from the settled tree')
    gateway.composer = async () => {}

    const dialog = await openStore()
    await dialog.getByRole('button', { name: '热重载', exact: true }).click()
    await expect
      .poll(() => dialog.getByRole('status').filter({ hasText: 'patch stack reapplied live' }).count(), { timeout: 5_000 })
      .toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['tab.expected.md', 'installed.expected.md', 'import.expected.md'])
  })
})
