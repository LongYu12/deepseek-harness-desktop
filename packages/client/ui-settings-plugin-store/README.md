# @deepseek-ai/dsh-client-ui-settings-plugin-store

English | [中文](README.zh.md)

**Plugin store** tab for Web Settings. The browser plugin registers one localized `settings.plugins.tab` contribution with id `store` and order 20; the Plugins section owns the navigation entry and tab chrome. It performs no Remote read during plugin activation. Mounting the tab lazily calls `ctx.remote.pluginStore.catalog()` and `ctx.remote.pluginStore.inventory()` through [`api-remotes`](../../api/remotes/README.md).

The tab renders two sections. The store section is a locally filtered catalog (name, description, author, and tags match the query) of cards; each card shows the locale-matched description, author, and tags, and carries an Install button that reads Installing while the Remote mutation runs, becoming an Installed tag once the refreshed inventory lists the package. The installed section lists profile bundles with their version, Update and Uninstall actions, and a restart hint whenever the boot snapshot differs; below it, loaded Loader entries get a switch calling `setEntryEnabled`, which applies hot through the store patch layer. Loading, empty, no-match, and failure states stay local to the mounted component; catalog and inventory failures retry independently, and a mutation that reports failure shows the Host message while a transport rejection shows a generic notice. The registration uses `ctx.slots.inject()`, so it follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner.

## Model Experience

None, as this package only drives the Host plugin-store Remote from browser Settings and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One snapshot per mount, retry, or mutation** — the tab does not subscribe to store changes; a successful mutation refetches the inventory, while unrelated external changes appear on the next mount.
- **No version picker** — install and update follow pnpm's default resolution; the UI shows the resulting version but cannot pin one.
