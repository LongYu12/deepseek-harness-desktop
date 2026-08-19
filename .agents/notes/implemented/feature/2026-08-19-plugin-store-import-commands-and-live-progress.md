# Agent Note: Plugin store import commands, live progress, and manual hot reload

Status: implemented

English | [中文](2026-08-19-plugin-store-import-commands-and-live-progress.zh.md)

## Problem

The [plugin store Web surface](../../implemented/feature/2026-08-17-plugin-store-web-surface.md) and its [live recomposition](../../implemented/feature/2026-08-18-plugin-store-live-recomposition.md) left the import lane narrow and the mutation feedback silent. `importBundle` accepted only git repository specs, so registry packages and tarball URLs had to be installed by hand outside the store. Every mutation (card install, card uninstall, import) ran pnpm invisibly: a long `pnpm add` showed only a busy label, with no streamed stderr, so users could not tell a hung network fetch from an active one. There was no manual re-apply entry point for the live composer, so a mutation whose live apply degraded to "restart needed" could not retry the apply from the UI. The shipped catalog listed only the three official bundles, so the store offered nothing a community user would want to install. And an import landing in the sibling tab left the store tab's installed list stale until the settings dialog reopened.

## Decision

Six changes, one per gap.

**Command-form imports.** `parsePluginImportCommand` splits an input into `dsh plugin [--profile <name>] add <spec>` (or a bare `<spec>`), and `resolveImportSpec` classifies the spec into registry name, git repository form, or https tarball URL (`.tar.gz`), each validated by an allowlist regex that excludes every shell metacharacter so a spec can never escape the pnpm argument. `importBundle` rejects a command naming a different profile than the running one — the store only mutates the profile it booted on — then runs `pnpm add` with the resolved spec. Registry targets install by name and feed the bundle check directly; git and tarball targets install by spec, with the bundle check after pnpm resolves the package name. The registry-name-only restriction on the install/remove/update verbs is unchanged.

**Streamed mutation progress.** Every pnpm stderr line from a mutation is emitted as `plugin-store/progress` (`{ operation, target, line }`), where `target` is the resolved registry name, git spec, or tarball URL the mutation runs on. A throwing progress observer is contained: progress is a display surface and must not abort the mutation producing the lines. `api-remotes`'s forwarded-event allowlist (`API_REMOTE_FORWARDED_EVENTS`) adds the event so the existing Host→consumer fan-out delivers it to `ctx.remote.$on` subscribers.

**Progress surfaces.** The store tab keeps the latest line per target and renders it inside the busy card; the import tab renders the resolved target plus the latest line under the import form while the mutation is in flight. Both surfaces hold the last line as lines arrive, because a fast pnpm emits many lines a render cannot chase.

**Manual hot reload.** `hotReload` re-runs the booted surface's live profile composer on demand and reports the outcome; a host without a composer reports `restartNeeded` with the reason. The client registers it as the `settings.action` slot `plugin-store-hot-reload` (order 10), rendering a header action in Settings that shows the verdict in a status.

**A richer catalog.** `BUILTIN_CATALOG` in `dsh-host-plugin-store` and the local store index (`local-plugin-store/index.json`, served by `local-plugin-store/serve.mjs`) add five curated community entries: `dshmarket`, `@linxin666/dsh-web-ui-all`, `dsh-usage-stats`, `dsh-skin-market`, and the `dsh-at-file` v0.6.3 tarball — each installable and removable through the store like the official bundles.

**Import-driven inventory refresh.** The client registers a local inventory-changed bus in the browser plugin: the import tab notifies it after a successful import, and the store tab subscribes and refetches, so the imported bundle joins the installed list while the dialog stays open.

## Alternatives considered

**Auto-reload after every mutation instead of a manual action.** Rejected: the composer path is already taken automatically inside `runPnpmMutation`; the header action exists for the degraded case where the automatic apply failed, and for hosts whose mutation path predates the composer.

**Pull progress through the mutation response instead of an event.** Rejected: the response arrives only when pnpm exits, so it cannot stream lines; the forwarded-event lane already exists and is the only live channel to the browser.

**Refetch the store tab on a timer while an import runs.** Rejected: the notification bus fires exactly once at the state transition that matters and costs nothing when idle.

## Consequences

A user can paste any of the five documented import command forms into the import tab and watch the live pnpm output; registry, git, and tarball targets all land in the profile through the same guard, progress, reconcile, and restart-flag plumbing. Card installs and removals show the same live lines, and the header hot-reload action retries a failed live apply without restarting the process.

The `plugin-store/progress` event is now a load-bearing wire name: forwarding it is one allowlist entry, and any consumer of the event must keep the `{ operation, target, line }` payload, since both store surfaces and the e2e lane depend on it.

The catalog is curated, not scraped: every entry is hand-picked, and tarball imports still route through pnpm's resolution so a failing source fails the import visibly rather than half-installing.
