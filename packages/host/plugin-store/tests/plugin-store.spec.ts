/** Plugin store gateway: catalog, inventory, pnpm mutations, and entry enablement. */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { PROFILE_STORE_PATCH_FILENAME } from '@deepseek-ai/dsh-app-boot'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { BUILTIN_CATALOG, loadStoreCatalog } from '../src/catalog.ts'
import PluginStoreGateway from '../src/index.ts'
import { assertRegistryPackageName, spawnPnpm } from '../src/pnpm.ts'

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Temp profile directory with one installed bundle and one plain dependency. */
function createProfileDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-store-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'node_modules', 'fake-bundle'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'fake-bundle', 'package.json'), JSON.stringify({
    name: 'fake-bundle',
    version: '1.2.3',
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  mkdirSync(join(dir, 'node_modules', 'plain-dep'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'plain-dep', 'package.json'), JSON.stringify({
    name: 'plain-dep',
    version: '0.0.1',
  }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'web',
    // ghost-dep is listed but not installed: reconcile probes it and treats
    // the unresolvable name as a plain dependency.
    dependencies: { 'fake-bundle': '^1.0.0', 'plain-dep': '^0.0.1', 'ghost-dep': '^0.0.1' },
    dsh: { profile: { bundles: ['fake-bundle'] } },
  }))
  return dir
}

const activePlugin: Plugin.Function = () => {}

async function harness(profileDir?: string, config?: Record<string, unknown>): Promise<{
  ctx: Context
  store: PluginStoreGateway
}> {
  const ctx = new Context()
  contexts.push(ctx)
  if (profileDir !== undefined) ctx.baseUrl = pathToFileURL(profileDir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.active = activePlugin
  await ctx.plugin(PluginStoreGateway, config)
  const store = ctx.get('pluginStore') as PluginStoreGateway
  return { ctx, store }
}

/** A fetch fake resolving to one JSON body. */
function fetchFake(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as typeof fetch
}

describe('PluginStoreGateway remote surface', () => {
  it('publishes six direct methods under the pluginStore namespace', async () => {
    const { store } = await harness()
    expect(store.typertRemote).toMatchObject({
      serviceKey: 'pluginStore',
      namespace: 'pluginStore',
    })
    expect(remoteMethods(store)).toEqual([
      { method: 'catalog', invocation: { kind: 'direct' } },
      { method: 'inventory', invocation: { kind: 'direct' } },
      { method: 'installBundle', invocation: { kind: 'direct' } },
      { method: 'removeBundle', invocation: { kind: 'direct' } },
      { method: 'updateBundle', invocation: { kind: 'direct' } },
      { method: 'setEntryEnabled', invocation: { kind: 'direct' } },
    ])
  })
})

describe('catalog', () => {
  it('returns the builtin catalog without an index URL', async () => {
    const { store } = await harness()
    await expect(store.catalog()).resolves.toEqual({ source: 'builtin', entries: BUILTIN_CATALOG })
  })

  it('treats an empty indexUrl as unset and serves the builtin catalog', async () => {
    // The shipped patch layer exposes the tunable as an empty string by default.
    const { store } = await harness(undefined, { indexUrl: '' })
    await expect(store.catalog()).resolves.toEqual({ source: 'builtin', entries: BUILTIN_CATALOG })
  })

  it('fetches and validates a remote index when configured', async () => {
    const { store } = await harness(undefined, { indexUrl: 'https://index.example/catalog.json', fetchTimeoutMs: 500 })
    store.fetchImpl = fetchFake([
      { name: 'third-party', description: 'Third party bundle.', descriptionZh: '第三方 bundle。', author: 'Acme', tags: ['community'] },
      { name: 'minimal', description: 'Minimal.' },
    ])
    const catalog = await store.catalog()
    expect(catalog.source).toBe('remote')
    expect(catalog.entries).toEqual([
      { name: 'third-party', description: 'Third party bundle.', descriptionZh: '第三方 bundle。', author: 'Acme', tags: ['community'] },
      { name: 'minimal', description: 'Minimal.', descriptionZh: 'Minimal.', author: '', tags: [] },
    ])
  })

  it('rejects a fetch failure without falling back to the builtin index', async () => {
    const catalog = loadStoreCatalog({
      indexUrl: 'https://index.example/catalog.json',
      fetchTimeoutMs: 500,
      fetchImpl: (async () => { throw new Error('network down') }) as typeof fetch,
    })
    await expect(catalog).rejects.toThrow('failed to fetch catalog index')
  })

  it('rejects a non-ok HTTP status', async () => {
    const catalog = loadStoreCatalog({
      indexUrl: 'https://index.example/catalog.json',
      fetchTimeoutMs: 500,
      fetchImpl: fetchFake('missing', 404),
    })
    await expect(catalog).rejects.toThrow('returned HTTP 404')
  })

  it('rejects an invalid JSON body', async () => {
    const catalog = loadStoreCatalog({
      indexUrl: 'https://index.example/catalog.json',
      fetchTimeoutMs: 500,
      fetchImpl: fetchFake('not-json{', 200),
    })
    await expect(catalog).rejects.toThrow('is not valid JSON')
  })

  it('rejects schema violations entry by entry', async () => {
    const load = (document: unknown): Promise<unknown> => loadStoreCatalog({
      indexUrl: 'https://index.example/catalog.json',
      fetchTimeoutMs: 500,
      fetchImpl: fetchFake(document),
    })
    await expect(load({ entries: [] })).rejects.toThrow('must be a top-level JSON array')
    await expect(load([[]])).rejects.toThrow('entry 1 must be an object')
    await expect(load([{ description: 'x' }])).rejects.toThrow('must hold a string "name"')
    await expect(load([{ name: './local-path', description: 'x' }])).rejects.toThrow('not a registry package name')
    await expect(load([{ name: 'good-name' }])).rejects.toThrow('must hold a string "description"')
    await expect(load([{ name: 'good-name', description: 'x', descriptionZh: 3 }])).rejects.toThrow('non-string "descriptionZh"')
    await expect(load([{ name: 'good-name', description: 'x', author: 3 }])).rejects.toThrow('non-string "author"')
    await expect(load([{ name: 'good-name', description: 'x', tags: ['ok', 3] }])).rejects.toThrow('"tags" value that is not an array of strings')
    await expect(load([{ name: 'good-name', description: 'x', tags: 'nope' }])).rejects.toThrow('"tags" value that is not an array of strings')
  })
})

describe('inventory', () => {
  it('degrades to entries only without a profile boot', async () => {
    const { ctx, store } = await harness()
    await ctx.loader.create({ name: 'cordis:active' })
    const snapshot = store.inventory()
    expect(snapshot).toMatchObject({ bundles: [], restartNeeded: false })
    expect(snapshot.entries).toEqual([
      { entryId: expect.any(String), moduleName: 'cordis:active', enabled: true, storeDisabled: false },
    ])
  })

  it('treats a non-file baseUrl like a non-profile boot', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = 'https://example.invalid/'
    await ctx.plugin(Loader)
    await ctx.plugin(PluginStoreGateway)
    const store = ctx.get('pluginStore') as PluginStoreGateway
    expect(store.inventory()).toMatchObject({ bundles: [], restartNeeded: false })
    await expect(store.installBundle('left-pad')).rejects.toThrow('no profile directory')
  })

  it('projects bundles with versions and Loader entries with store disable marks', async () => {
    const dir = createProfileDir()
    const { ctx, store } = await harness(dir)
    const entryId = await ctx.loader.create({ name: 'cordis:active' })
    const groupId = await ctx.loader.create({ name: 'cordis:active', group: true })
    writeFileSync(join(dir, PROFILE_STORE_PATCH_FILENAME), [
      `- id: ${entryId}`,
      '  disabled: true',
      '- id: some-other-row',
      '  disabled: false',
      '- config: {}',
    ].join('\n'))
    const snapshot = store.inventory()
    expect(snapshot.restartNeeded).toBe(false)
    expect(snapshot.bundles).toEqual([
      { packageName: 'fake-bundle', version: '1.2.3', restartNeeded: false },
    ])
    expect(snapshot.entries).toEqual([
      // The layer file marks the entry; the Loader's own state is untouched
      // until boot/HMR applies the layer, so `enabled` still reflects it.
      { entryId, moduleName: 'cordis:active', enabled: true, storeDisabled: true },
    ])
    expect(groupId).not.toBe(entryId)
  })

  it('reports version null and restartNeeded for bundles absent at boot', async () => {
    const dir = createProfileDir()
    const { store } = await harness(dir)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
    ;(manifest.dsh as { profile: { bundles: string[] } }).profile.bundles.push('missing-bundle')
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    const snapshot = store.inventory()
    expect(snapshot.restartNeeded).toBe(true)
    expect(snapshot.bundles).toEqual([
      { packageName: 'fake-bundle', version: '1.2.3', restartNeeded: false },
      { packageName: 'missing-bundle', version: null, restartNeeded: true },
    ])
  })

  it('survives an unreadable boot manifest with an empty boot snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-store-'))
    tempDirs.push(dir)
    writeFileSync(join(dir, 'package.json'), '{invalid')
    const { store } = await harness(dir)
    expect(() => store.inventory()).toThrow()
  })

  it('reads a manifest without a dsh section as no bundles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-store-'))
    tempDirs.push(dir)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bare' }))
    const { store } = await harness(dir)
    expect(store.inventory()).toEqual({ bundles: [], entries: [], restartNeeded: false })
    // A successful mutation that changes nothing still resolves the final
    // bundle list against the dsh-less manifest.
    store.runner = () => ({ exitCode: 0, stderr: '' })
    expect(await store.updateBundle('anything-ok')).toEqual({
      ok: true,
      restartNeeded: false,
      message: 'pnpm update anything-ok succeeded',
    })
  })

  it('reports version null for a resolvable bundle without a version field', async () => {
    const dir = createProfileDir()
    mkdirSync(join(dir, 'node_modules', 'no-version-bundle'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'no-version-bundle', 'package.json'), JSON.stringify({
      name: 'no-version-bundle',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } }
    manifest.dependencies['no-version-bundle'] = '^1.0.0'
    manifest.dsh.profile.bundles.push('no-version-bundle')
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    const { store } = await harness(dir)
    const snapshot = store.inventory()
    expect(snapshot.bundles).toEqual(expect.arrayContaining([
      { packageName: 'no-version-bundle', version: null, restartNeeded: false },
    ]))
  })
})

describe('pnpm mutations', () => {
  it('rejects non-registry package specs before running pnpm', async () => {
    const dir = createProfileDir()
    const { store } = await harness(dir)
    store.runner = () => { throw new Error('runner must not run') }
    for (const spec of ['./local', '../up', 'git+https://example.com/x.git', 'left-pad@1.3.0', 'UPPER', '']) {
      await expect(store.installBundle(spec)).rejects.toThrow('not a registry package name')
    }
  })

  it('installs a new bundle and reconciles the layer list', async () => {
    const dir = createProfileDir()
    mkdirSync(join(dir, 'node_modules', 'new-bundle'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'new-bundle', 'package.json'), JSON.stringify({
      name: 'new-bundle',
      version: '2.0.0',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    const { store } = await harness(dir)
    const calls: { args: readonly string[]; cwd: string }[] = []
    store.runner = (args, cwd) => {
      calls.push({ args, cwd })
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
      manifest.dependencies['new-bundle'] = '^2.0.0'
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      return { exitCode: 0, stderr: '' }
    }
    const result = await store.installBundle('new-bundle')
    expect(calls).toEqual([{ args: ['add', 'new-bundle'], cwd: dir }])
    expect(result).toEqual({ ok: true, restartNeeded: true, message: 'pnpm add new-bundle succeeded' })
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual(['fake-bundle', 'new-bundle'])
  })

  it('installs a plain dependency without a layer change and names it', async () => {
    const dir = createProfileDir()
    mkdirSync(join(dir, 'node_modules', 'plain-lib'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'plain-lib', 'package.json'), JSON.stringify({ name: 'plain-lib', version: '1.0.0' }))
    const { store } = await harness(dir)
    store.runner = () => {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
      manifest.dependencies['plain-lib'] = '^1.0.0'
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      return { exitCode: 0, stderr: '' }
    }
    const result = await store.installBundle('plain-lib')
    expect(result.ok).toBe(true)
    expect(result.restartNeeded).toBe(false)
    expect(result.message).toContain('plain-lib declares no dsh.bundle')
  })

  it('removes a bundle and flags the restart', async () => {
    const dir = createProfileDir()
    const { store } = await harness(dir)
    store.runner = (args) => {
      expect(args).toEqual(['remove', 'fake-bundle'])
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
      delete manifest.dependencies['fake-bundle']
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      return { exitCode: 0, stderr: '' }
    }
    const result = await store.removeBundle('fake-bundle')
    expect(result).toEqual({ ok: true, restartNeeded: true, message: 'pnpm remove fake-bundle succeeded' })
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual([])
  })

  it('updates a bundle in place and flags the restart', async () => {
    const dir = createProfileDir()
    const { store } = await harness(dir)
    store.runner = args => (expect(args).toEqual(['update', 'fake-bundle']), { exitCode: 0, stderr: '' })
    const result = await store.updateBundle('fake-bundle')
    expect(result).toEqual({ ok: true, restartNeeded: true, message: 'pnpm update fake-bundle succeeded' })
  })

  it('reports pnpm failure with the stderr tail', async () => {
    const dir = createProfileDir()
    const { store } = await harness(dir)
    store.runner = () => ({ exitCode: 1, stderr: 'line1\nline2\nline3\nline4\n' })
    const result = await store.installBundle('anything-ok')
    expect(result.ok).toBe(false)
    expect(result.restartNeeded).toBe(false)
    expect(result.message).toContain('exit code 1')
    expect(result.message).toContain('line2\nline3\nline4')
    expect(result.message).not.toContain('line1')
  })

  it('reports an empty stderr failure and a missing pnpm distinctly', async () => {
    const dir = createProfileDir()
    const { store } = await harness(dir)
    store.runner = () => ({ exitCode: 2, stderr: '   \n' })
    expect((await store.removeBundle('fake-bundle')).message).toContain('no stderr captured')
    store.runner = () => ({ exitCode: 127, stderr: 'pnpm not found on PATH' })
    expect((await store.updateBundle('fake-bundle')).message).toBe('pnpm not found on PATH — install pnpm to manage store plugins')
  })

  it('requires a profile boot for every mutation', async () => {
    const { store } = await harness()
    await expect(store.installBundle('left-pad')).rejects.toThrow('no profile directory')
    await expect(store.removeBundle('left-pad')).rejects.toThrow('no profile directory')
    await expect(store.updateBundle('left-pad')).rejects.toThrow('no profile directory')
    await expect(store.setEntryEnabled('anything', false)).rejects.toThrow('no profile directory')
  })
})

describe('setEntryEnabled', () => {
  it('writes and withdraws store patch rows hot', async () => {
    const dir = createProfileDir()
    const { ctx, store } = await harness(dir)
    const entryId = await ctx.loader.create({ name: 'cordis:active' })
    const path = join(dir, PROFILE_STORE_PATCH_FILENAME)

    const disabled = await store.setEntryEnabled(entryId, false)
    expect(disabled.ok).toBe(true)
    expect(disabled.restartNeeded).toBe(false)
    expect(disabled.message).toContain('disabled')
    expect(readFileSync(path, 'utf8')).toContain(String(entryId))

    expect((await store.setEntryEnabled(entryId, false)).message).toContain('already disabled')

    const enabled = await store.setEntryEnabled(entryId, true)
    expect(enabled.message).toContain('enabled')
    expect(existsSync(path)).toBe(false)

    expect((await store.setEntryEnabled(entryId, true)).message).toContain('not disabled')
  })

  it('preserves unrelated rows while withdrawing its own', async () => {
    const dir = createProfileDir()
    const { ctx, store } = await harness(dir)
    const entryId = await ctx.loader.create({ name: 'cordis:active' })
    const path = join(dir, PROFILE_STORE_PATCH_FILENAME)
    writeFileSync(path, ['- id: keep-me', '  disabled: true'].join('\n'))
    await store.setEntryEnabled(entryId, false)
    await store.setEntryEnabled(entryId, true)
    expect(readFileSync(path, 'utf8')).toContain('keep-me')
    expect(readFileSync(path, 'utf8')).not.toContain(String(entryId))
  })

  it('reads an empty layer file as no rows', async () => {
    const dir = createProfileDir()
    const { ctx, store } = await harness(dir)
    const entryId = await ctx.loader.create({ name: 'cordis:active' })
    writeFileSync(join(dir, PROFILE_STORE_PATCH_FILENAME), '')
    expect((await store.setEntryEnabled(entryId, true)).message).toContain('not disabled')
  })

  it('rejects unknown entry ids and malformed layer files', async () => {
    const dir = createProfileDir()
    const { store } = await harness(dir)
    await expect(store.setEntryEnabled('missing-entry', false)).rejects.toThrow('unknown Loader entry id')
    const path = join(dir, PROFILE_STORE_PATCH_FILENAME)
    const { ctx: ctx2, store: store2 } = await harness(dir)
    const entryId = await ctx2.loader.create({ name: 'cordis:active' })
    writeFileSync(path, 'key: value')
    await expect(store2.setEntryEnabled(entryId, false)).rejects.toThrow('must be a top-level YAML array')
    writeFileSync(path, '{{{')
    await expect(store2.setEntryEnabled(entryId, false)).rejects.toThrow('failed to parse')
    rmSync(path)
    mkdirSync(path)
    await expect(store2.setEntryEnabled(entryId, false)).rejects.toThrow('failed to read')
  })
})

describe('catalog resolution details', () => {
  it('uses the ambient fetch when no implementation is injected', async () => {
    vi.stubGlobal('fetch', fetchFake([{ name: 'ambient-entry', description: 'Ambient.' }]))
    try {
      const catalog = await loadStoreCatalog({ indexUrl: 'https://index.example/catalog.json', fetchTimeoutMs: 500 })
      expect(catalog).toMatchObject({ source: 'remote', entries: [{ name: 'ambient-entry' }] })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('applies the default fetch timeout when the config omits it', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    const store = new PluginStoreGateway(ctx)
    await expect(store.catalog()).resolves.toMatchObject({ source: 'builtin' })
  })
})

describe('registry package name guard', () => {
  it('accepts registry names and rejects every spec shape', () => {
    for (const name of ['left-pad', '@scope/pkg', 'a.b-c_d', 'd0']) {
      expect(() => assertRegistryPackageName(name)).not.toThrow()
    }
    for (const name of ['./x', '../x', 'x/y/z', 'git+https://example.com', 'pkg@1.0.0', 'UPPER', '-lead', '.lead', 'lead.', '', '@', '@/x', 'a//b']) {
      expect(() => assertRegistryPackageName(name)).toThrow('not a registry package name')
    }
  })
})

describe('spawnPnpm default runner', () => {
  /** Temp PATH dir holding one fake pnpm shim (platform-specific shape). */
  function fakePnpmDir(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-store-bin-'))
    tempDirs.push(dir)
    const shim = join(dir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    writeFileSync(shim, script)
    if (process.platform !== 'win32') chmodSync(shim, 0o755)
    return dir
  }

  it('reports the exit code and stderr of a real spawn', () => {
    const dir = fakePnpmDir(process.platform === 'win32'
      ? '@echo off\necho fake-stderr-line 1>&2\nexit /b 7'
      : '#!/bin/sh\necho fake-stderr-line >&2\nexit 7')
    const oldPath = process.env.PATH
    process.env.PATH = dir
    try {
      const result = spawnPnpm(['--version'], dir)
      expect(result.exitCode).toBe(7)
      expect(result.stderr).toContain('fake-stderr-line')
    } finally {
      process.env.PATH = oldPath
    }
  })

  it('reports a spawn-level ENOENT as exit code 127', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-store-bin-'))
    tempDirs.push(dir)
    // A nonexistent cwd fails the spawn itself, before any shell runs.
    expect(spawnPnpm(['--version'], join(dir, 'does-not-exist'))).toEqual({
      exitCode: 127,
      stderr: 'pnpm not found on PATH',
    })
  })
})
