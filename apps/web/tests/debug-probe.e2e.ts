// Temporary probe: dump the plugin store tab content and console errors.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

describe('probe', () => {
  let scaffold: WebScaffold
  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const profileDir = join(scaffold.harnessHome, 'profiles', 'scaffold')
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-scaffold', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
    }, undefined, 2)}\n`)
  }, 120_000)
  afterAll(async () => { await scaffold?.close() })
  it('dumps the store tab', async () => {
    const store = scaffold.ctx.get('pluginStore') as { catalog: () => Promise<unknown>; inventory: () => unknown } | undefined
    if (store === undefined) console.log('[host] pluginStore service missing')
    else {
      try { console.log('[host] catalog', JSON.stringify(await store.catalog()).slice(0, 400)) } catch (error) { console.log('[host] catalog THREW', String(error)) }
      try { console.log('[host] inventory', JSON.stringify(store.inventory()).slice(0, 400)) } catch (error) { console.log('[host] inventory THREW', String(error)) }
    }
    const browser = await chromium.launch()
    const page = await browser.newPage({ locale: 'zh-CN' })
    page.on('console', message => console.log('[console]', message.type(), message.text()))
    page.on('pageerror', error => console.log('[pageerror]', String(error)))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '插件', exact: true }).click()
    await dialog.getByRole('tab', { name: '插件商店', exact: true }).click()
    await page.waitForTimeout(8_000)
    const panels = await dialog.evaluate(element => [...element.querySelectorAll('[role="tabpanel"]')]
      .map(panel => ({
        hidden: (panel as HTMLElement).hidden,
        text: panel.textContent?.slice(0, 800),
        html: panel.innerHTML.slice(0, 1_200),
      })))
    console.log('[panels]', JSON.stringify(panels, undefined, 2))
    const tabs = await dialog.evaluate(element => [...element.querySelectorAll('[role="tab"]')]
      .map(tab => ({ name: tab.textContent, selected: tab.getAttribute('aria-selected') })))
    console.log('[tabs]', JSON.stringify(tabs))
    await browser.close()
    expect(true).toBe(true)
  }, 90_000)
})
