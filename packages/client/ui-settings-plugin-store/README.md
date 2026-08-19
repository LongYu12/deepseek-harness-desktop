# @deepseek-ai/dsh-client-ui-settings-plugin-store

English | [中文](README.zh.md)

**Plugin store** tabs for Web Settings. The browser plugin registers two localized `settings.plugins.tab` contributions: id `store` with order 20 and id `import` with order 30, plus a `settings.action` contribution (`plugin-store-hot-reload`, order 10) rendering a header hot-reload button that calls `hotReload` and shows the verdict in a status; the Plugins section owns the navigation entry and tab chrome. They perform no Remote read during plugin activation. Mounting the store tab lazily calls `ctx.remote.pluginStore.catalog()` and `ctx.remote.pluginStore.inventory()` through [`api-remotes`](../../api/remotes/README.md).

The store tab renders a toolbar with the store-configuration shortcut plus two sections. The shortcut button calls `openStoreConfig`, which materializes the profile user patch layer and opens it in a text editor; the result notice carries the Host message naming the file. The store section is a locally filtered catalog (name, description, author, and tags match the query) of cards; each card shows the locale-matched description, author, and tags, and carries an Install button that reads Installing while the Remote mutation runs, becoming an Installed tag once the refreshed inventory lists the package. The installed section lists profile bundles with their version, Update and Uninstall actions, and a restart hint whenever the boot snapshot differs; below it, loaded Loader entries show a state tag (Enabled or Disabled) beside a switch calling `setEntryEnabled`, which applies hot through the store patch layer — an entry disabled outside the store layer shows its switch locked with an explanatory hint. Loading, empty, no-match, and failure states stay local to the mounted component; catalog and inventory failures retry independently, and a mutation that reports failure shows the Host message while a transport rejection shows a generic notice. The import tab collects an import command (`dsh plugin [--profile <name>] add <spec>`) or a bare spec and submits it to `importBundle`; while the mutation runs it streams the resolved target and the latest pnpm stderr line through the forwarded `plugin-store/progress` event, the result notice carries the Host message and a restart hint when the import joins the bundle layer, and a successful import notifies the store tab to refetch its installed list. A rejected command (wrong profile) or invalid spec shows the Host rejection. The registration uses `ctx.slots.inject()`, so it follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner.

## Model Experience

None, as this package only drives the Host plugin-store Remote from browser Settings and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Snapshots, not subscriptions** — the tabs do not subscribe to store changes; a successful mutation refetches the inventory, a successful entry toggle additionally refetches once the patch layer's HMR recomposition settles, a successful import notifies the store tab to refetch, and unrelated external changes appear on the next mount.
- **No version picker** — install, update, and import follow pnpm's default resolution; the UI shows the resulting version but cannot pin one.
