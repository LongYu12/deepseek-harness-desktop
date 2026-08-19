# Agent Note: Plugin store Web surface with a store-owned patch layer

Status: implemented

English | [中文](2026-08-17-plugin-store-web-surface.zh.md)

## Problem

Plugins are npm packages declaring `dsh.bundle`, installed into a profile by `dsh plugin` forwarding pnpm and reconciled into the manifest's `dsh.profile.bundles` layer list. The Web Settings surface could only show a read-only inventory: there was no way to browse a catalog, install or remove a bundle, or enable/disable an installed plugin from the browser.

Two structural gaps blocked a correct implementation. First, bundle composition is fixed at process start — `loadProfile` snapshots the layer stack once — so install/remove/update cannot take effect without restarting dsh, while enable/disable only needs a config patch and should be hot. Second, the only patch mechanism was rewriting the user's `cordis.patch.yml`, which round-trips through YAML serialization and loses comments and `!!js` tags, so it can never be the substrate for machine-written toggles. The CLI also owned the bundle reconciliation logic privately, so a second writer would drift from it.

## Decision

Four seams, each owned where its authority already lives.

**A store-dedicated patch layer.** `dsh-app-boot`'s `Profile` gains `storePatchPath`/`storePatches` for a new file `cordis.store.patch.yml` inside the profile directory, composed after the bundle layers and before the user layer so user patches keep the last word. The file is store-owned — nothing else writes it — and appears on demand rather than at `initProfile` time. `profile-boot` includes the layer in both composition paths and adds a watcher on it, so a toggle flows through the same HMR recomposition as `cordis.patch.yml`: enable/disable applies hot with no restart.

**Shared bundle reconciliation.** The pure core of the CLI's plugin reconciliation was extracted to `dsh-app-boot` as `reconcileBundles(manifest, isBundle)`. The CLI keeps its stderr-warning wrapper; the store calls the shared core directly, so the two writers cannot drift on layer-list semantics.

**A capability-seam Host service.** `@deepseek-ai/dsh-host-plugin-store` registers the `pluginStore` service with eight generated direct Remotes: `catalog`, `inventory`, `installBundle`, `importBundle`, `removeBundle`, `updateBundle`, `setEntryEnabled`, `openStoreConfig`. The mutation verbs carry the `Bundle` suffix because the Client gateway rejects any Remote method named after a namespace-service member, and it reserves bare `install` and `remove`; a future store-like service must keep avoiding those two verbs. The catalog ships a built-in index of the three official bundles; setting the `indexUrl` Config fetches the same-schema JSON with an AbortSignal timeout, and any remote failure fails loud instead of silently falling back. Mutations spawn pnpm in the profile directory (Loader `baseUrl`; every mutator fails loud when absent, so a non-profile launch cannot mutate anything), then write the bundle layer through the shared reconciler. `installBundle`/`removeBundle`/`updateBundle` accept only bare registry package names — path and tarball specs are rejected before spawn; `importBundle` accepts only git specs (GitHub shorthand `owner/repo` or `github:owner/repo`, and `git+https:`/`git+ssh:`/`git:`/`https:` URLs ending in `.git`, each with an optional `#ref` suffix), validated by an allowlist regex that excludes every shell metacharacter so a spec can never escape the pnpm argument. `inventory` compares the live manifest and Loader entries against the boot snapshot to report `restartNeeded`, and projects entry enablement: each entry's reported state applies the store layer's disable mark as soon as the write returns, ahead of the patch layer's HMR recomposition on the Loader, because the write succeeds while the recompose is still pending and a caller reading back immediately would otherwise see the stale Loader state. `openStoreConfig` materializes the profile's user patch layer `cordis.patch.yml` (seeding an empty row list when absent, never altering existing content) and hands it to a text editor — the shortcut for store tunables such as `indexUrl`, which a `{ id: plugin-store, config: { ... } }` row there overrides.

**A Settings tab, not a new surface.** `@deepseek-ai/dsh-client-ui-settings-plugin-store` registers two `settings.plugins.tab` contributions through `ctx.slots.inject()`: id `store` (order 20) and id `import` (order 30), the latter a paste-a-git-spec box that calls `importBundle` and installs through pnpm add. Neither reads anything during activation; mounting a tab lazily calls its remotes. A toolbar button calls `openStoreConfig` as the configuration shortcut. The store tab lays out search and the filtered catalog cards above the installed section, and an installed card shows its tag plus an uninstall button, so removal happens right at the search result. The installed section lists bundles with update/uninstall plus a restart hint when the snapshot differs, and gives loaded Loader entries a state tag (Enabled/Disabled) beside a switch calling `setEntryEnabled` — tags report state while buttons name the action; an entry disabled outside the store layer shows its switch locked, since enabling only withdraws the store's own mark. After a successful toggle the tab refetches immediately and once more after the HMR recomposition settles. `api-remotes` mounts `pluginStoreRemote` alongside the existing Remotes.

## Alternatives considered

**Rewrite the user's `cordis.patch.yml` for enable/disable.** Rejected: serializing that file back through YAML drops comments and `!!js` tags, destroying user content. A store-exclusive sidecar file avoids the round-trip entirely and keeps the user layer authoritative above it.

**Hot-apply install/remove/update.** Rejected at the time: the bundle layer list is read once at boot and the composition tree is built from it; making it live would require rebuilding the Loader tree mid-flight. An explicit `restartNeeded` flag surfaced in the UI is honest and far cheaper. Superseded by [live recomposition](2026-08-18-plugin-store-live-recomposition.md): the Include update path replays the full patch stack into the running tree, so bundle-layer mutations apply without a restart where a composer is registered.

**Online npm registry search as the catalog.** Rejected: discovery stays curated — the built-in index plus an optional remote index URL — and mutations accept only registry names. Registry search would broaden both the discovery and install surfaces without a curation point.

**Silent fallback from a broken remote index to the built-in catalog.** Rejected: a misconfigured `indexUrl` should surface as an error the operator can retry, not mask itself by showing a different catalog than intended.

**Keep reconciliation in the CLI.** Rejected: a second writer over `dsh.profile.bundles` would duplicate the layer-list rules and drift; extracting the pure core costs one import boundary.

## Consequences

Browsing, installing, removing, updating, and toggling plugins now happens entirely in the Web Settings UI with no CLI round-trip. Enable/disable is hot through the watcher; install/remove/update are hot through [live recomposition](2026-08-18-plugin-store-live-recomposition.md) wherever a composer is registered, and otherwise report a restart with the failure reason stated in the UI.

The layer ordering contract is load-bearing: store patches compose before the user layer, so a user patch can override a store toggle — deliberate, since the user file is the topmost authority. The store never edits `cordis.patch.yml` content; `cordis.store.patch.yml` is its only write target, and `openStoreConfig` only seeds the user file when absent before handing it to an editor. On Windows the text-editor intent launches Notepad directly (`dsh-native-command`): `.yml` files usually lack a file association, so the shell open returns success while the system picker appears behind the app window.

The registry-name-only install rule narrows the attack surface but also the power: no version pinning and no local path or tarball installs through the store (the CLI path still accepts what pnpm accepts); git installs route through the dedicated import tab with its spec allowlist. `indexUrl` failures and missing-`baseUrl` launches fail loud by design, so callers translate those into UI error states rather than retrying silently.
