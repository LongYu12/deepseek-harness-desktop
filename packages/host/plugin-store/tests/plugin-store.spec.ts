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
import { assertRegistryPackageName, parsePluginImportCommand, resolveImportSpec, spawnPnpm, spawnPnpmStreaming } from '../src/pnpm.ts'
import type { StoreMutationProgress } from '../src/types.ts'

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
  return async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

describe('PluginStoreGateway remote surface', () => {
  it('publishes nine direct methods under the pluginStore namespace', async () => {
    const { store } = await harness()
    expect(store.typertRemote).toMatchObject({
      serviceKey: 'pluginStore',
      namespace: 'pluginStore',
    })
    expect(remoteMethods(store)).toEqual([
      { method: 'catalog', invocation: { kind: 'direct' } },
      { method: 'inventory', invocation: { kind: 'direct' } },
      { method: 'installBundle', invocation: { kind: 'direct' } },
      { method: 'importBundle', invocation: { kind: 'direct' } },
      { method: 'removeBundle', invocation: { kind: 'direct' } },
      { method: 'updateBundle', invocation: { kind: 'direct' } },
      { method: 'setEntryEnabled', invocation: { kind: 'direct' } },
      { method: 'hotReload', invocation: { kind: 'direct' } },
      { method: 'openStoreConfig', invocation: { kind: 'direct' } },
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
      fetchImpl: async () => { throw new Error('network down') },
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
      { entryId: expect.any(String) as unknown, moduleName: 'cordis:active', enabled: true, storeDisabled: false },
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
      // Quoted: an all-digit Loader entry id parses as a YAML number unquoted,
      // and yaml.dump quotes such strings on the production write path too.
      `- id: '${entryId}'`,
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
      // The layer file's mark projects onto the Loader state immediately: the
      // entry reads disabled before boot/HMR applies the layer.
      { entryId, moduleName: 'cordis:active', enabled: false, storeDisabled: true },
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

  it('rejects malformed import commands and targets before running pnpm', async () => {
    const dir = createProfileDir()
    const { store } = await harness(dir)
    store.runner = () => { throw new Error('runner must not run') }
    for (const command of [
      'dsh plugin remove x',
      'dsh plugin',
      'dsh plugin --profile',
      'dsh plugin --profile -x add pkg',
      'dsh plugin --profile web add',
      'dsh plugin --profile web add x extra',
      'dsh foo add x',
    ]) {
      await expect(store.importBundle(command)).rejects.toThrow('is not a plugin import command')
    }
    for (const spec of [
      'http://example.com/repo.git',
      'file:///tmp/repo',
      'git+https://x/y.git; rm -rf /',
      'git+https://x/y.git --ignore-scripts',
      'owner repo',
      'https://example.com/archive.tgz',
      '',
    ]) {
      await expect(store.importBundle(spec)).rejects.toThrow('is not an importable plugin target')
    }
  })

  it('imports a bundle from a git spec and reconciles the layer list', async () => {
    const dir = createProfileDir()
    mkdirSync(join(dir, 'node_modules', 'git-bundle'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'git-bundle', 'package.json'), JSON.stringify({
      name: 'git-bundle',
      version: '0.1.0',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    const { store } = await harness(dir)
    const calls: { args: readonly string[]; cwd: string }[] = []
    store.runner = (args, cwd) => {
      calls.push({ args, cwd })
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
      manifest.dependencies['git-bundle'] = 'github:owner/repo#main'
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      return { exitCode: 0, stderr: '' }
    }
    // Leading and trailing whitespace is trimmed before pnpm runs.
    const result = await store.importBundle('  github:owner/repo#main  ')
    expect(calls).toEqual([{ args: ['add', 'github:owner/repo#main'], cwd: dir }])
    expect(result).toEqual({ ok: true, restartNeeded: true, message: 'pnpm add github:owner/repo#main succeeded' })
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual(['fake-bundle', 'git-bundle'])
  })

  it('imports a registry plugin from a pasted command and streams progress', async () => {
    const dir = createProfileDir()
    mkdirSync(join(dir, 'node_modules', 'dshmarket'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({
      name: 'dshmarket',
      version: '1.14.1',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    const { ctx, store } = await harness(dir)
    const progress: StoreMutationProgress[] = []
    ctx.on('plugin-store/progress', entry => progress.push(entry))
    const calls: { args: readonly string[]; cwd: string }[] = []
    store.runner = (args, cwd, onProgress) => {
      calls.push({ args, cwd })
      onProgress?.('Progress: resolved 42 packages')
      onProgress?.('Progress: done')
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
      manifest.dependencies['dshmarket'] = '^1.14.1'
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      return { exitCode: 0, stderr: 'Progress: done' }
    }
    const result = await store.importBundle('dsh plugin --profile web add dshmarket')
    expect(calls).toEqual([{ args: ['add', 'dshmarket'], cwd: dir }])
    expect(result).toEqual({ ok: true, restartNeeded: true, message: 'pnpm add dshmarket succeeded' })
    expect(progress).toEqual([
      { operation: 'add', target: 'dshmarket', line: 'Progress: resolved 42 packages' },
      { operation: 'add', target: 'dshmarket', line: 'Progress: done' },
    ])
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual(['fake-bundle', 'dshmarket'])
  })

  it('imports a scoped registry plugin from a bare spec', async () => {
    const dir = createProfileDir()
    mkdirSync(join(dir, 'node_modules', '@linxin666', 'dsh-web-ui-all'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '@linxin666', 'dsh-web-ui-all', 'package.json'), JSON.stringify({
      name: '@linxin666/dsh-web-ui-all',
      version: '0.2.1',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    const { store } = await harness(dir)
    store.runner = (args) => {
      expect(args).toEqual(['add', '@linxin666/dsh-web-ui-all'])
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
      manifest.dependencies['@linxin666/dsh-web-ui-all'] = '^0.2.1'
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      return { exitCode: 0, stderr: '' }
    }
    const result = await store.importBundle('@linxin666/dsh-web-ui-all')
    expect(result).toEqual({ ok: true, restartNeeded: true, message: 'pnpm add @linxin666/dsh-web-ui-all succeeded' })
  })

  it('imports a tarball URL and flags the bundle join', async () => {
    const dir = createProfileDir()
    const tarball = 'https://github.com/omdsh-dev/dsh-at-file/archive/refs/tags/v0.6.3.tar.gz'
    mkdirSync(join(dir, 'node_modules', 'dsh-at-file'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'dsh-at-file', 'package.json'), JSON.stringify({
      name: 'dsh-at-file',
      version: '0.6.3',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    const { store } = await harness(dir)
    const calls: { args: readonly string[]; cwd: string }[] = []
    store.runner = (args, cwd) => {
      calls.push({ args, cwd })
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
      manifest.dependencies['dsh-at-file'] = tarball
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      return { exitCode: 0, stderr: '' }
    }
    const result = await store.importBundle(`dsh plugin --profile web add ${tarball}`)
    expect(calls).toEqual([{ args: ['add', tarball], cwd: dir }])
    expect(result).toEqual({ ok: true, restartNeeded: true, message: `pnpm add ${tarball} succeeded` })
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual(['fake-bundle', 'dsh-at-file'])
  })

  it('rejects an import command targeting another profile', async () => {
    const dir = createProfileDir()
    const { store } = await harness(dir)
    store.runner = () => { throw new Error('runner must not run') }
    await expect(store.importBundle('dsh plugin --profile other add dshmarket')).rejects.toThrow(
      'targets profile "other" but the running profile is "web"',
    )
  })

  it('contains a throwing progress observer without aborting the mutation', async () => {
    const dir = createProfileDir()
    const { ctx, store } = await harness(dir)
    ctx.on('plugin-store/progress', () => { throw new Error('observer exploded') })
    store.runner = (_args, _cwd, onProgress) => {
      onProgress?.('line-one')
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
      manifest.dependencies['plain-lib'] = '^1.0.0'
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      return { exitCode: 0, stderr: '' }
    }
    const result = await store.installBundle('plain-lib')
    expect(result.ok).toBe(true)
  })

  it('imports a plain dependency without a layer change or restart flag', async () => {
    const dir = createProfileDir()
    mkdirSync(join(dir, 'node_modules', 'plain-lib'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'plain-lib', 'package.json'), JSON.stringify({ name: 'plain-lib', version: '1.0.0' }))
    const { store } = await harness(dir)
    store.runner = () => {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
      manifest.dependencies['plain-lib'] = 'git+https://example.com/plain-lib.git'
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      return { exitCode: 0, stderr: '' }
    }
    const result = await store.importBundle('git+https://example.com/plain-lib.git')
    expect(result.ok).toBe(true)
    expect(result.restartNeeded).toBe(false)
    expect(result.message).toContain('plain-lib declares no dsh.bundle')
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

  it('applies a bundle mutation live through the composer and drops the restart flag', async () => {
    const dir = createProfileDir()
    const { store } = await harness(dir)
    const compose = vi.fn(async () => {})
    store.composer = compose
    store.runner = (args) => {
      expect(args).toEqual(['remove', 'fake-bundle'])
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
      delete manifest.dependencies['fake-bundle']
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      return { exitCode: 0, stderr: '' }
    }
    const result = await store.removeBundle('fake-bundle')
    expect(result).toEqual({
      ok: true,
      restartNeeded: false,
      message: 'pnpm remove fake-bundle succeeded (applied live; no restart needed)',
    })
    expect(compose).toHaveBeenCalledTimes(1)
    // The boot snapshot follows the live apply, so a fresh inventory no
    // longer marks the mutation for a restart.
    expect(store.inventory().restartNeeded).toBe(false)
  })

  it('keeps the restart flag and names the failure when the live apply rejects', async () => {
    const dir = createProfileDir()
    mkdirSync(join(dir, 'node_modules', 'new-bundle'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'new-bundle', 'package.json'), JSON.stringify({
      name: 'new-bundle',
      version: '2.0.0',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    const { store } = await harness(dir)
    store.composer = async () => { throw new Error('patch exploded') }
    store.runner = () => {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
      manifest.dependencies['new-bundle'] = '^2.0.0'
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      return { exitCode: 0, stderr: '' }
    }
    const result = await store.installBundle('new-bundle')
    expect(result.ok).toBe(true)
    expect(result.restartNeeded).toBe(true)
    expect(result.message).toContain('live apply failed: patch exploded; a restart applies it')
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
    await expect(store.importBundle('left-pad')).rejects.toThrow('no profile directory')
    await expect(store.removeBundle('left-pad')).rejects.toThrow('no profile directory')
    await expect(store.updateBundle('left-pad')).rejects.toThrow('no profile directory')
    await expect(store.setEntryEnabled('anything', false)).rejects.toThrow('no profile directory')
    await expect(store.openStoreConfig()).rejects.toThrow('no profile directory')
  })
})

describe('hotReload', () => {
  it('reports a missing composer as restart-required', async () => {
    const { store } = await harness()
    await expect(store.hotReload()).resolves.toEqual({
      ok: false,
      restartNeeded: true,
      message: 'plugin-store: no live composer on this host — restart the process to apply changes',
    })
  })

  it('reapplies the patch stack live through the composer', async () => {
    const { store } = await harness()
    const compose = vi.fn(async () => {})
    store.composer = compose
    await expect(store.hotReload()).resolves.toEqual({
      ok: true,
      restartNeeded: false,
      message: 'plugin-store: patch stack reapplied live — no restart needed',
    })
    expect(compose).toHaveBeenCalledTimes(1)
  })

  it('flags a failed live apply as restart-required', async () => {
    const { store } = await harness()
    store.composer = async () => { throw new Error('patch exploded') }
    await expect(store.hotReload()).resolves.toEqual({
      ok: false,
      restartNeeded: true,
      message: 'plugin-store: live apply failed — patch exploded; restart the process to apply changes',
    })
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
    expect(readFileSync(path, 'utf8')).toContain(entryId)

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
    expect(readFileSync(path, 'utf8')).not.toContain(entryId)
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

describe('openStoreConfig', () => {
  it('seeds an absent user patch layer and opens it', async () => {
    const dir = createProfileDir()
    const { store } = await harness(dir)
    const opened: string[] = []
    store.openTextFile = async (path) => { opened.push(path) }
    const path = join(dir, 'cordis.patch.yml')
    const result = await store.openStoreConfig()
    expect(result.ok).toBe(true)
    expect(result.restartNeeded).toBe(false)
    expect(result.message).toContain(path)
    expect(opened).toEqual([path])
    // The seed parses as an empty row list.
    expect(readFileSync(path, 'utf8')).toContain('[]')
  })

  it('opens an existing user patch layer without rewriting it', async () => {
    const dir = createProfileDir()
    const { store } = await harness(dir)
    const path = join(dir, 'cordis.patch.yml')
    writeFileSync(path, '# my own rows\n- id: keep-me\n')
    store.openTextFile = async () => {}
    expect((await store.openStoreConfig()).ok).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('# my own rows\n- id: keep-me\n')
  })

  it('reports an opener failure without throwing', async () => {
    const dir = createProfileDir()
    const { store } = await harness(dir)
    store.openTextFile = async () => { throw new Error('no editor available') }
    const result = await store.openStoreConfig()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('no editor available')
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

describe('parsePluginImportCommand', () => {
  it('parses full, profile-less, and bare forms', () => {
    expect(parsePluginImportCommand('dsh plugin --profile web add dshmarket')).toEqual({ profile: 'web', spec: 'dshmarket' })
    expect(parsePluginImportCommand('dsh plugin add dshmarket')).toEqual({ profile: undefined, spec: 'dshmarket' })
    expect(parsePluginImportCommand('  dshmarket  ')).toEqual({ profile: undefined, spec: 'dshmarket' })
    expect(parsePluginImportCommand('dsh plugin --profile web add https://github.com/omdsh-dev/dsh-at-file/archive/refs/tags/v0.6.3.tar.gz'))
      .toEqual({ profile: 'web', spec: 'https://github.com/omdsh-dev/dsh-at-file/archive/refs/tags/v0.6.3.tar.gz' })
  })

  it('rejects dsh commands that are not imports', () => {
    for (const input of [
      'dsh plugin remove x',
      'dsh plugin',
      'dsh plugin --profile',
      'dsh plugin --profile -x add pkg',
      'dsh plugin --profile web add',
      'dsh plugin --profile web add x extra',
      'dsh foo add x',
    ]) {
      expect(() => parsePluginImportCommand(input)).toThrow('is not a plugin import command')
    }
  })
})

describe('resolveImportSpec', () => {
  it('classifies registry, git, and tarball targets in priority order', () => {
    expect(resolveImportSpec('dshmarket')).toEqual({ kind: 'registry', spec: 'dshmarket' })
    expect(resolveImportSpec('@linxin666/dsh-web-ui-all')).toEqual({ kind: 'registry', spec: '@linxin666/dsh-web-ui-all' })
    // Bare owner/repo matches the registry grammar too; the git shorthand wins.
    expect(resolveImportSpec('omdsh-dev/dsh-at-file')).toEqual({ kind: 'git', spec: 'omdsh-dev/dsh-at-file' })
    expect(resolveImportSpec('github:owner/repo#main')).toEqual({ kind: 'git', spec: 'github:owner/repo#main' })
    expect(resolveImportSpec('git+https://example.com/x.git')).toEqual({ kind: 'git', spec: 'git+https://example.com/x.git' })
    expect(resolveImportSpec('https://github.com/omdsh-dev/dsh-at-file.git')).toEqual({ kind: 'git', spec: 'https://github.com/omdsh-dev/dsh-at-file.git' })
    expect(resolveImportSpec('https://github.com/omdsh-dev/dsh-at-file/archive/refs/tags/v0.6.3.tar.gz'))
      .toEqual({ kind: 'tarball', spec: 'https://github.com/omdsh-dev/dsh-at-file/archive/refs/tags/v0.6.3.tar.gz' })
  })

  it('rejects every unaccepted target shape', () => {
    for (const spec of [
      'http://example.com/repo.git',
      'file:///tmp/repo',
      './local',
      'git+https://x/y.git; rm -rf /',
      'git+https://x/y.git --ignore-scripts',
      'owner repo',
      'https://example.com/archive.tgz',
      'UPPER',
      '',
    ]) {
      expect(() => resolveImportSpec(spec)).toThrow('is not an importable plugin target')
    }
  })
})

describe('registry package name guard', () => {
  it('accepts registry names and rejects every spec shape', () => {
    for (const name of ['left-pad', '@scope/pkg', 'a.b-c_d', 'd0']) {
      expect(() => { assertRegistryPackageName(name) }).not.toThrow()
    }
    for (const name of ['./x', '../x', 'x/y/z', 'git+https://example.com', 'pkg@1.0.0', 'UPPER', '-lead', '.lead', 'lead.', '', '@', '@/x', 'a//b']) {
      expect(() => { assertRegistryPackageName(name) }).toThrow('not a registry package name')
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

  it('passes --ignore-scripts only to installing commands', () => {
    // The shim records its arguments next to itself; cmd accepts forward-slash redirect paths.
    const dir = fakePnpmDir(process.platform === 'win32'
      ? '@echo off\necho %* > %~dp0args.txt'
      : '#!/bin/sh\necho "$*" > "$(dirname "$0")/args.txt"')
    const argsLog = join(dir, 'args.txt')
    const oldPath = process.env.PATH
    process.env.PATH = dir
    try {
      spawnPnpm(['add', 'pkg'], dir)
      expect(readFileSync(argsLog, 'utf8')).toContain('--ignore-scripts')
      spawnPnpm(['remove', 'pkg'], dir)
      expect(readFileSync(argsLog, 'utf8')).not.toContain('--ignore-scripts')
      spawnPnpm(['update', 'pkg'], dir)
      expect(readFileSync(argsLog, 'utf8')).not.toContain('--ignore-scripts')
      spawnPnpm(['--version'], dir)
      expect(readFileSync(argsLog, 'utf8')).not.toContain('--ignore-scripts')
    } finally {
      process.env.PATH = oldPath
    }
  })

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

  it('streams stderr lines to the progress listener as they arrive', async () => {
    const dir = fakePnpmDir(process.platform === 'win32'
      ? '@echo off\necho line-one 1>&2\necho line-two 1>&2\nexit /b 7'
      : '#!/bin/sh\necho line-one >&2\necho line-two >&2\nexit 7')
    const lines: string[] = []
    const oldPath = process.env.PATH
    process.env.PATH = dir
    try {
      const result = await spawnPnpmStreaming(['add', 'pkg'], dir, line => lines.push(line))
      expect(lines).toEqual(['line-one', 'line-two'])
      expect(result.exitCode).toBe(7)
      // The raw aggregate carries platform line endings; the progress lines
      // above are the normalized per-line surface.
      expect(result.stderr).toContain('line-one')
      expect(result.stderr).toContain('line-two')
    } finally {
      process.env.PATH = oldPath
    }
  })
})
