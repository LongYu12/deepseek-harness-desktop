# @deepseek-ai/dsh-host-plugin-store

English | [中文](README.zh.md)

Plugin store gateway for the active profile. `PluginStoreGateway` registers the `pluginStore` service and publishes six generated direct Remotes: `pluginStore/catalog`, `pluginStore/inventory`, `pluginStore/installBundle`, `pluginStore/removeBundle`, `pluginStore/updateBundle`, and `pluginStore/setEntryEnabled` (the mutation verbs carry the `Bundle` suffix because the Client gateway reserves bare `install` and `remove` on every Remote namespace). The catalog serves the built-in index of official bundles shipped with this package, or fetches the same-schema JSON from the `indexUrl` Config when one is set; a remote fetch failure (non-OK status, bad JSON, or a schema violation) fails loud instead of silently falling back. The inventory merges the profile manifest's `dsh.profile.bundles` layer with each package's installed version and the Loader's entry state, marking `restartNeeded` against the boot-time snapshot because bundle composition is fixed at process start.

Mutations spawn `pnpm` inside the profile directory (the Loader `baseUrl`, fail loud when absent), reuse the shared `reconcileBundles` core from [`dsh-app-boot`](../../boot/app-boot/README.md) to write back the `dsh.profile.bundles` layer, and accept only registry package names — path, git, and tarball specs are rejected before any spawn. Enablement rides the store-owned patch layer `cordis.store.patch.yml` beside the user patch file: `setEntryEnabled` writes or removes `{ id, disabled: true }` rows there, and the CLI watcher recomposes the change hot, so toggling never needs a restart while install/remove/update do.

## Model Experience

None, as this Host-only store gateway registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Registry names only** — install/remove/update accept a bare registry package name, never a version range, path, git, or tarball spec; version selection follows pnpm's default resolution.
- **No online discovery** — the catalog grows only through the built-in index or a configured `indexUrl`; there is no registry search endpoint.
- **Point-in-time inventory** — the snapshot does not subscribe to manifest or Loader changes; clients refetch after a mutation completes.
