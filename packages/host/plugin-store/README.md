# @deepseek-ai/dsh-host-plugin-store

English | [中文](README.zh.md)

Plugin store gateway for the active profile. `PluginStoreGateway` registers the `pluginStore` service and publishes nine generated direct Remotes: `pluginStore/catalog`, `pluginStore/inventory`, `pluginStore/installBundle`, `pluginStore/importBundle`, `pluginStore/removeBundle`, `pluginStore/updateBundle`, `pluginStore/setEntryEnabled`, `pluginStore/openStoreConfig`, and `pluginStore/hotReload` (the registry mutation verbs carry the `Bundle` suffix because the Client gateway reserves bare `install` and `remove` on every Remote namespace; `importBundle` takes an import command `dsh plugin [--profile <name>] add <spec>` or a bare spec instead). The catalog serves the built-in index of official bundles and curated community entries shipped with this package, or fetches the same-schema JSON from the `indexUrl` Config when one is set; a remote fetch failure (non-OK status, bad JSON, or a schema violation) fails loud instead of silently falling back. The inventory merges the profile manifest's `dsh.profile.bundles` layer with each package's installed version and the Loader's entry state, marking `restartNeeded` against the boot-time snapshot because bundle composition is fixed at process start. Entry enablement is projected: the store layer's disable mark applies to the reported state as soon as the write returns, ahead of the patch layer's HMR recomposition on the Loader.

Mutations spawn `pnpm` inside the profile directory (the Loader `baseUrl`, fail loud when absent), reuse the shared `reconcileBundles` core from [`dsh-app-boot`](../../boot/app-boot/README.md) to write back the `dsh.profile.bundles` layer, and accept only registry package names — path and tarball specs are rejected before any spawn. `importBundle` is the dedicated import path: it parses an import command or a bare spec, rejects a command naming a different profile than the running one, and resolves the spec to a guarded registry name, git repository form (`github:owner/repo`, bare `owner/repo`, or a `git+https:`/`git+ssh:`/`https:` URL ending in `.git`, optionally with a `#ref` suffix), or https tarball URL (`.tar.gz`); registry targets install by name, git and tarball targets install by spec with the bundle check after pnpm resolves the package name, and a restart is flagged whenever the resolved bundle list changes. Enablement rides the store-owned patch layer `cordis.store.patch.yml` beside the user patch file: `setEntryEnabled` writes or removes `{ id, disabled: true }` rows there, and the CLI watcher recomposes the change hot, so toggling never needs a restart while install/remove/update/import do. `openStoreConfig` is the configuration shortcut: it materializes the profile's user patch layer `cordis.patch.yml` (seeding an empty row list when absent) and hands it to a text editor; a `{ id: plugin-store, config: { ... } }` row there overrides store tunables such as `indexUrl`.

Every pnpm stderr line of a mutation is emitted as a `plugin-store/progress` event (`{ operation, target, line }`) and forwarded to consumers through the `api-remotes` allowlist, so store surfaces can stream live output keyed on the mutation's resolved target. `hotReload` re-runs the booted surface's live profile composer on demand: a host without a composer reports `restartNeeded` with the reason, and a failed apply keeps the flag while naming the failure, so the UI can retry the apply from the header action without restarting the process.

## Model Experience

None, as this Host-only store gateway registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Registry names, except imports** — install/remove/update accept a bare registry package name, never a version range, path, or tarball spec; `importBundle` is the dedicated import path accepting registry names, git repository forms, and https tarball URLs. Version selection follows pnpm's default resolution.
- **No online discovery** — the catalog grows only through the built-in index or a configured `indexUrl`; there is no registry search endpoint.
- **Point-in-time inventory** — the snapshot does not subscribe to manifest or Loader changes; clients refetch after a mutation completes.
