/**
 * Live bundle-layer recomposition through `runProfile`: a booted profile
 * registers the composer under `PROFILE_COMPOSE_KEY`, and a re-composition
 * after a store-style bundle mutation (write the bundle into the profile and
 * extend `dsh.profile.bundles`) mounts the new bundle's entries in the
 * running tree — no restart. This is the store's install/remove path minus
 * the pnpm call itself.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { PROFILE_COMPOSE_KEY } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { runProfile } from '../src/profile-boot.ts'

const homes: string[] = []

afterEach(async () => {
  delete process.env.DSH_HOME
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const PLUGIN_SOURCE = [
  'export const name = "compose-fixture"',
  'export function apply(_ctx, config = {}) {',
  '  if (config.fail) throw new Error("candidate config failed")',
  '}',
  '',
].join('\n')

/** Write one bundle package into the profile's node_modules. */
function writeBundle(profileDir: string, packageName: string, entryId: string, version = '1.0.0'): void {
  const dir = join(profileDir, 'node_modules', packageName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.mjs'), PLUGIN_SOURCE)
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    `    - id: ${entryId}`,
    `      name: ${pathToFileURL(join(dir, 'plugin.mjs')).href}`,
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: packageName,
    version,
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
}

function profileBundles(profileDir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
  return manifest.dsh.profile.bundles
}

function writeProfileBundles(profileDir: string, bundles: string[]): void {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
  manifest.dsh.profile.bundles = bundles
  for (const name of bundles) manifest.dependencies[name] = '^1.0.0'
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2))
}

function entryIds(ctx: Context): string[] {
  return [...ctx.loader.entries()].map(entry => entry.options.id)
}

describe('live profile recomposition', () => {
  it('registers a composer and applies a bundle install/remove without a restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-cli-compose-'))
    homes.push(home)
    process.env.DSH_HOME = home
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    writeBundle(profileDir, 'first-bundle', 'first-entry')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'web',
      dependencies: { 'first-bundle': '^1.0.0' },
      dsh: { profile: { bundles: ['first-bundle'] } },
    }))

    const { ctx, shutdown } = await runProfile({
      environment: createLaunchEnvironmentSnapshot([]),
      profile: 'web',
      patchFiles: [],
      args: [],
    })
    try {
      const composer = ctx.get(PROFILE_COMPOSE_KEY) as (() => Promise<void>) | undefined
      expect(composer).toBeTypeOf('function')
      if (composer === undefined) throw new Error('composer was not registered')
      // The boot composition mounted the first bundle's entry.
      expect(entryIds(ctx)).toContain('first-entry')

      // Store-style install: a second bundle joins node_modules and the
      // manifest layer list; the composer re-reads both.
      writeBundle(profileDir, 'second-bundle', 'second-entry')
      writeProfileBundles(profileDir, ['first-bundle', 'second-bundle'])
      expect(entryIds(ctx)).not.toContain('second-entry')
      await composer()
      expect(entryIds(ctx)).toContain('second-entry')
      expect(entryIds(ctx)).toContain('first-entry')

      // Store-style remove: the bundle leaves the layer list; the composer
      // disposes its entries while keeping the others.
      writeProfileBundles(profileDir, ['first-bundle'])
      await composer()
      expect(entryIds(ctx)).not.toContain('second-entry')
      expect(entryIds(ctx)).toContain('first-entry')
      expect(profileBundles(profileDir)).toEqual(['first-bundle'])
    } finally {
      await shutdown.shutdown(0)
    }
  })
})
