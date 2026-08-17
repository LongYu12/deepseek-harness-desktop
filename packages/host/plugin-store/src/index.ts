/**
 * @deepseek-ai/dsh-host-plugin-store — plugin store Remote: catalog browsing
 * (builtin index, optionally overridden by a configured remote index URL),
 * profile bundle lifecycle (install/remove/update through pnpm plus the
 * shared `dsh.profile.bundles` reconciliation), and entry enablement through
 * the store-owned `cordis.store.patch.yml` layer. Bundle composition changes
 * apply at the next process boot; enablement applies hot through the patch
 * layer's HMR watch.
 */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import * as yaml from 'js-yaml'
import z from '@deepseek-ai/schemastery'
import {
  PROFILE_STORE_PATCH_FILENAME,
  readProfileManifest,
  reconcileBundles,
  resolveBundleDir,
  writeProfileManifest,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { loadStoreCatalog } from './catalog.ts'
import { assertRegistryPackageName, spawnPnpm, type PnpmRunner } from './pnpm.ts'
import type {
  PluginStoreInventory,
  StoreCatalog,
  StoreInventoryBundle,
  StoreInventoryEntry,
  StoreMutationResult,
} from './types.ts'

export type * from './types.ts'

/** Diagnostic prefix on every thrown error and warning. */
const NAME = 'plugin-store'

/** Remote catalog fetch timeout when the config leaves it unset. */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000

/** Absolute path of this package's own manifest (the workspace bundle-resolution anchor). */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** Store gateway config. */
export interface Config {
  /** Remote catalog index URL; overrides the builtin catalog when set. */
  indexUrl?: string
  /** Remote catalog fetch timeout in milliseconds. */
  fetchTimeoutMs?: number
}

/** One row of the store-owned patch layer, read back structurally. */
type StorePatchRow = Record<string, unknown>

/**
 * Remote-only service exposing the plugin store. Reads project Loader and
 * profile state on every call; mutations run pnpm in the profile directory
 * and reconcile the `dsh.profile.bundles` layer through the shared
 * `reconcileBundles` core, or write the store patch layer for enablement.
 */
export class PluginStoreGateway extends TypertRemoteService {
  static inject = ['loader']

  static Config: z<Config> = z.object({
    indexUrl: z.string(),
    fetchTimeoutMs: z.number().min(1).default(DEFAULT_FETCH_TIMEOUT_MS),
  })

  private readonly indexUrl: string | undefined
  private readonly fetchTimeoutMs: number
  /** The `dsh.profile.bundles` list this process booted with. */
  private readonly bootBundles: readonly string[]
  /** pnpm runner; tests substitute a fake before invoking mutations. */
  runner: PnpmRunner = spawnPnpm
  /** Catalog fetch implementation; tests substitute a fake. */
  fetchImpl: typeof fetch | undefined = undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'pluginStore')
    // The shipped patch layer exposes `indexUrl` as an empty-by-default tunable;
    // an empty string means "unset", not a remote index to parse.
    this.indexUrl = config.indexUrl === undefined || config.indexUrl === '' ? undefined : config.indexUrl
    this.fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    this.bootBundles = this.snapshotBootBundles()
  }

  /**
   * Resolve the store catalog: the shipped builtin index, or the configured
   * remote index fetched and validated under the fetch timeout. A remote
   * failure rejects — no silent builtin fallback.
   * @returns the catalog with its source label.
   */
  @Remote('catalog')
  async catalog(): Promise<StoreCatalog> {
    return loadStoreCatalog({
      ...(this.indexUrl === undefined ? {} : { indexUrl: this.indexUrl }),
      fetchTimeoutMs: this.fetchTimeoutMs,
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    })
  }

  /**
   * Project the installed bundles (profile manifest layer list plus resolved
   * versions) and the loaded entries (Loader state plus the store patch
   * layer's disable marks). A bundle absent from the boot snapshot marks
   * `restartNeeded`: bundle layers are fixed at boot.
   * @returns the point-in-time inventory.
   */
  @Remote('inventory')
  inventory(): PluginStoreInventory {
    const profileDir = this.optionalProfileDir()
    const storeDisabled = profileDir === undefined
      ? new Set<string>()
      : new Set(this.readStorePatchRows(join(profileDir, PROFILE_STORE_PATCH_FILENAME)).filter(row => typeof row.id === 'string' && row.disabled === true).map(row => row.id as string))
    const entries: StoreInventoryEntry[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      entries.push({
        entryId: entry.id,
        moduleName: entry.options.name,
        enabled: !entry.disabled,
        storeDisabled: storeDisabled.has(entry.id),
      })
    }
    if (profileDir === undefined) return { bundles: [], entries, restartNeeded: false }
    const listed = readProfileManifest(NAME, profileDir).dsh?.profile?.bundles ?? []
    const bundles: StoreInventoryBundle[] = listed.map(packageName => ({
      packageName,
      version: this.installedVersion(packageName, profileDir),
      restartNeeded: !this.bootBundles.includes(packageName),
    }))
    const restartNeeded = listed.length !== this.bootBundles.length
      || listed.some(packageName => !this.bootBundles.includes(packageName))
    return { bundles, entries, restartNeeded }
  }

  /**
   * Install a registry package into the profile (`pnpm add`) and reconcile
   * the bundle layer list against the installed state.
   * @param packageName - bare registry package name (spec-guarded).
   * @returns the mutation outcome; `restartNeeded` when the package is a bundle.
   */
  // The Remote verb carries the `Bundle` suffix because the Client gateway
  // reserves bare `install` and `remove` on every namespace service.
  @Remote('installBundle')
  async installBundle(packageName: string): Promise<StoreMutationResult> {
    return this.runPnpmMutation(['add', packageName], packageName)
  }

  /**
   * Remove a package from the profile (`pnpm remove`) and reconcile the
   * bundle layer list against the installed state.
   * @param packageName - bare registry package name (spec-guarded).
   * @returns the mutation outcome; `restartNeeded` when the package was a bundle.
   */
  @Remote('removeBundle')
  async removeBundle(packageName: string): Promise<StoreMutationResult> {
    return this.runPnpmMutation(['remove', packageName], packageName)
  }

  /**
   * Update a package in the profile (`pnpm update`) and reconcile the bundle
   * layer list — an update gaining a `dsh.bundle` declaration joins the layer
   * stack.
   * @param packageName - bare registry package name (spec-guarded).
   * @returns the mutation outcome; `restartNeeded` when the package is a bundle.
   */
  @Remote('updateBundle')
  async updateBundle(packageName: string): Promise<StoreMutationResult> {
    return this.runPnpmMutation(['update', packageName], packageName)
  }

  /**
   * Enable or disable one loaded entry through the store patch layer:
   * disabling writes a `{ id, disabled: true }` row, enabling withdraws it.
   * The layer's HMR watch recomposes the tree hot — no restart.
   * @param entryId - a Loader entry id currently present in the tree.
   * @param enabled - the requested enablement.
   * @returns the mutation outcome (never needs a restart).
   * @throws when the host booted without a profile or the entry id is unknown.
   */
  @Remote('setEntryEnabled')
  setEntryEnabled(entryId: string, enabled: boolean): Promise<StoreMutationResult> {
    try {
      return Promise.resolve(this.applyEntryEnablement(entryId, enabled))
    } catch (error) {
      // The async predecessor rejected here; keep validation failures async too.
      return Promise.reject(error)
    }
  }

  /** Synchronous core of {@link setEntryEnabled}; the Remote wrapper adds the promise. */
  private applyEntryEnablement(entryId: string, enabled: boolean): StoreMutationResult {
    const profileDir = this.profileDir()
    if (![...this.ctx.loader.entries()].some(entry => entry.id === entryId)) {
      throw new Error(`${NAME}: unknown Loader entry id ${JSON.stringify(entryId)}`)
    }
    const path = join(profileDir, PROFILE_STORE_PATCH_FILENAME)
    const rows = this.readStorePatchRows(path)
    const index = rows.findIndex(row => row.id === entryId)
    if (enabled) {
      if (index === -1) return { ok: true, restartNeeded: false, message: `${entryId} is not disabled by the store layer` }
      rows.splice(index, 1)
    } else {
      if (index !== -1) return { ok: true, restartNeeded: false, message: `${entryId} is already disabled by the store layer` }
      rows.push({ id: entryId, disabled: true })
    }
    this.writeStorePatchRows(path, rows)
    return {
      ok: true,
      restartNeeded: false,
      message: `${enabled ? 'enabled' : 'disabled'} ${entryId} in ${PROFILE_STORE_PATCH_FILENAME}`,
    }
  }

  /** The boot-time bundle list: read once at activation; mutations compare against it. */
  private snapshotBootBundles(): readonly string[] {
    const profileDir = this.optionalProfileDir()
    if (profileDir === undefined) return []
    try {
      return [...readProfileManifest(NAME, profileDir).dsh?.profile?.bundles ?? []]
    } catch {
      // A manifest this process booted from reads back; an unreadable one
      // here means a non-profile boot, which degrades to "no boot snapshot".
      return []
    }
  }

  /** The profile directory, or undefined when the host booted without a file baseUrl. */
  private optionalProfileDir(): string | undefined {
    const baseUrl = this.ctx.root.baseUrl
    if (baseUrl === undefined || !baseUrl.startsWith('file:')) return undefined
    // The boot anchor carries a trailing slash; fileURLToPath keeps it as a
    // trailing separator, which downstream path joins tolerate but equality
    // checks against the bare directory do not.
    return fileURLToPath(baseUrl).replace(/[/\\]+$/, '')
  }

  /** The profile directory; mutations require a profile boot. */
  private profileDir(): string {
    const profileDir = this.optionalProfileDir()
    if (profileDir === undefined) {
      throw new Error(`${NAME}: no profile directory — the host booted without a file config-tree baseUrl, so store mutations have nowhere to write`)
    }
    return profileDir
  }

  /** One listed bundle's installed version, or null when unresolvable. */
  private installedVersion(packageName: string, profileDir: string): string | null {
    try {
      const bundleDir = resolveBundleDir(NAME, packageName, INSTALL_ANCHOR, profileDir)
      const manifest = readProfileManifest(NAME, bundleDir) as ProfileManifest & { version?: string }
      return manifest.version ?? null
    } catch {
      return null
    }
  }

  /** Whether a resolved dependency exports a profile patch, i.e. is a bundle. */
  private exportsPatch(packageName: string, profileDir: string): boolean {
    let dir: string
    try {
      dir = resolveBundleDir(NAME, packageName, INSTALL_ANCHOR, profileDir)
    } catch {
      return false // pnpm reported success yet the package is unresolvable — treat as plain
    }
    const manifest = readProfileManifest(NAME, dir)
    return manifest.dsh?.bundle?.patch !== undefined
  }

  /**
   * Run one pnpm mutation in the profile directory, then reconcile
   * `dsh.profile.bundles` through the shared core. The restart flag follows
   * bundle membership: a bundle join/leave/version swap only composes at the
   * next boot, while a plain dependency touches no composition.
   */
  private async runPnpmMutation(args: readonly string[], packageName: string): Promise<StoreMutationResult> {
    assertRegistryPackageName(packageName)
    const profileDir = this.profileDir()
    const before = readProfileManifest(NAME, profileDir)
    const result = await this.runner(args, profileDir)
    if (result.exitCode !== 0) {
      const message = result.exitCode === 127
        ? 'pnpm not found on PATH — install pnpm to manage store plugins'
        : `pnpm ${args.join(' ')} failed with exit code ${String(result.exitCode)}: ${tail(result.stderr)}`
      return { ok: false, restartNeeded: false, message }
    }
    const after = readProfileManifest(NAME, profileDir)
    const reconciled = reconcileBundles(before, after, name => this.exportsPatch(name, profileDir))
    if (reconciled.manifest !== undefined) writeProfileManifest(profileDir, reconciled.manifest)
    const finalBundles = reconciled.manifest?.dsh?.profile?.bundles ?? after.dsh?.profile?.bundles ?? []
    const restartNeeded = finalBundles.includes(packageName)
      || (before.dsh?.profile?.bundles ?? []).includes(packageName)
    const additions = reconciled.nonBundleAdditions.length > 0
      ? ` (${reconciled.nonBundleAdditions.join(', ')} declares no dsh.bundle — installed as a plain dependency)`
      : ''
    return { ok: true, restartNeeded, message: `pnpm ${args.join(' ')} succeeded${additions}` }
  }

  /** Read the store patch layer: missing file means no rows. */
  private readStorePatchRows(path: string): StorePatchRow[] {
    let content: string
    try {
      content = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(`${NAME}: failed to read ${path}: ${String(error)}`)
    }
    let parsed: unknown
    try {
      parsed = yaml.load(content)
    } catch (error) {
      throw new Error(`${NAME}: failed to parse ${path}: ${String(error)}`)
    }
    if (parsed === undefined) return []
    if (!Array.isArray(parsed)) {
      throw new Error(`${NAME}: ${path} must be a top-level YAML array of patch rows`)
    }
    return parsed.filter((row): row is StorePatchRow => typeof row === 'object' && row !== null && !Array.isArray(row))
  }

  /** Write the store patch layer; an empty list withdraws the file entirely. */
  private writeStorePatchRows(path: string, rows: readonly StorePatchRow[]): void {
    if (rows.length === 0) {
      try {
        unlinkSync(path)
      } catch (error) {
        /* v8 ignore next 4 -- successful read means the path is a file; a non-ENOENT
           unlink failure is an OS race tests cannot synthesize */
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`${NAME}: failed to remove ${path}: ${String(error)}`)
        }
      }
      return
    }
    writeFileSync(path, yaml.dump([...rows]))
  }
}

/** The last non-empty stderr lines — pnpm's verdict without the progress noise. */
function tail(stderr: string): string {
  const lines = stderr.split('\n').map(line => line.trimEnd()).filter(line => line.length > 0)
  return lines.slice(-3).join('\n') || 'no stderr captured'
}

export default PluginStoreGateway
