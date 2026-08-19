/** Public payload types of the plugin store Remote. */

/** Catalog source: the shipped builtin index or the configured remote index. */
export type StoreCatalogSource = 'builtin' | 'remote'

/** One installable plugin entry in the store catalog. */
export interface StoreCatalogEntry {
  /** Registry package name — the install target. */
  readonly name: string
  /** English description. */
  readonly description: string
  /** Chinese description. */
  readonly descriptionZh: string
  readonly author: string
  readonly tags: readonly string[]
}

/** The catalog projection returned by the store Remote. */
export interface StoreCatalog {
  readonly source: StoreCatalogSource
  readonly entries: readonly StoreCatalogEntry[]
}

/** One bundle listed in the profile's `dsh.profile.bundles` layer. */
export interface StoreInventoryBundle {
  readonly packageName: string
  /** Installed version, or null when listed but not resolvable. */
  readonly version: string | null
  /** Absent from the boot snapshot: the next process boot composes it. */
  readonly restartNeeded: boolean
}

/** One loaded plugin entry's enablement state. */
export interface StoreInventoryEntry {
  readonly entryId: string
  /** Exact module specifier imported by the Loader entry. */
  readonly moduleName: string
  /**
   * Effective enablement: the Loader state with the store layer's mark
   * applied, so a fresh mark reads back disabled before the patch layer's
   * HMR recomposition settles it on the Loader.
   */
  readonly enabled: boolean
  /** Disabled by the store patch layer (as opposed to any other layer). */
  readonly storeDisabled: boolean
}

/** Point-in-time inventory returned by the plugin store Remote. */
export interface PluginStoreInventory {
  readonly bundles: readonly StoreInventoryBundle[]
  readonly entries: readonly StoreInventoryEntry[]
  /** The boot-time bundle composition differs from the installed layer list. */
  readonly restartNeeded: boolean
}

/** Outcome of one install/remove/update/setEntryEnabled mutation. */
export interface StoreMutationResult {
  readonly ok: boolean
  /** The mutation changed what the next process boot composes. */
  readonly restartNeeded: boolean
  /** Human-readable outcome; pnpm's tail diagnostic on failure. */
  readonly message: string
}

/** One live pnpm stderr line during a store mutation. */
export interface StoreMutationProgress {
  /** The pnpm subcommand running the mutation. */
  readonly operation: 'add' | 'remove' | 'update'
  /** The mutation's resolved target: registry name, git spec, or tarball URL. */
  readonly target: string
  /** One non-empty pnpm stderr line (pnpm's progress surface). */
  readonly line: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One pnpm stderr line while a store mutation runs. Consumers key on
     * {@link StoreMutationProgress.target} to attach the line to the card or
     * field that started it; observer failures are contained and cannot abort
     * the running pnpm mutation.
     * @param progress - the current line and its mutation context.
     * @mode emit
     */
    'plugin-store/progress'(progress: StoreMutationProgress): void
  }
}
