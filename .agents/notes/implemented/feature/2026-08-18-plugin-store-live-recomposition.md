# Agent Note: Plugin store live recomposition and visible install failures

Status: implemented

English | [中文](2026-08-18-plugin-store-live-recomposition.zh.md)

## Problem

The [plugin store Web surface](../../implemented/feature/2026-08-17-plugin-store-web-surface.md) left three gaps. First, bundle install/remove/update required a process restart: bundle composition is fixed at process start, so the store's own mutations reported `restartNeeded` even though enable/disable was already hot through the patch-layer watcher. Second, install failures were invisible: the store tab rendered its notice at the bottom of the page, below the fold of the installed section, and every catch branch showed a generic message while discarding the underlying error. Third, most installs actually failed: pnpm 11 hard-fails with `ERR_PNPM_IGNORED_BUILDS` (exit 1) whenever the resolved tree contains build scripts not yet approved, even though the package is already written into `node_modules` and `dependencies`, and the store treated every non-zero exit as failure; one catalog entry (`open-design`) additionally had corrupted registry metadata (`dist-tags.latest` missing) that made its `pnpm add` fail every time.

## Decision

Four changes, one per gap.

**Bundle-layer mutations reapply live through the root Include.** `dsh-app-boot` exports `PROFILE_COMPOSE_KEY` and `refreshProfileComposition(ctx, binName, compose)`: the function reuses the boot Include entry (the same one `watchUserPatches` drives), replays the full current composition through `entry.update({ config: { ...includeConfig, patches } })`, and the returned promise resolves only after the Loader has diffed and applied the tree, so mounted entries' `update()`/dispose have settled. `apps/cli/profile-boot`'s `composeLive` now re-reads the profile from disk on every call — `loadProfile` (which re-reads each time), the store/user/home patch layers, then the boot-time overlays — instead of returning the boot-fixed `composed.bundlePatches`, so a bundle added to or removed from the manifest layer list enters the next composition immediately. The plugin store probes `PROFILE_COMPOSE_KEY` at construction; after every successful pnpm mutation, when a composer exists it awaits it: success returns `restartNeeded: false` with an "applied live" message, rejection keeps `restartNeeded: true` and appends the failure reason (a restart applies it). Hosts without a composer (any non-`runProfile` boot) behave exactly as before.

**pnpm 11's build-script hard failure is suppressed.** Installing mutations (`add`/`install`) pass `--ignore-scripts`; `remove` and `update` do not, because pnpm's strict CLI rejects options a command does not declare ("Unknown option: 'ignore-scripts'"). The store never runs dependency install scripts — running arbitrary postinstall code from the registry is a supply-chain risk — so the flag costs nothing and makes `pnpm add` exit 0 for the same tree that previously failed after already writing the package.

**Install failures are visible.** The store tab's notice moved from the bottom of the page to directly under the toolbar; the `mutate`, `toggleEntry`, and `openConfig` catch branches now surface `error.message` instead of a generic string, so a failed pnpm or transport error names itself.

**Broken registry metadata stays out of the index.** The local index dropped `open-design` (whose `dist-tags.latest` is absent from the registry); `refresh-index.mjs`'s `existsOnRegistry` now requires both `dist-tags.latest` and `versions[latest]`, so such packages are excluded at scrape time instead of failing every install later.

## Alternatives considered

**Restart the desktop backend in-process after a mutation.** Rejected: the backend process owns the session tree, and killing it would drop the user's running session and window state; a live tree update keeps both.

**Keep `restartNeeded` as the only path.** Rejected: the user-facing requirement is explicitly no-restart; the composer keeps the restart flag as the degradation path, not the default.

**`--config.strictDepBuilds=false` instead of `--ignore-scripts`.** Rejected: it is pnpm 11-specific, while `--ignore-scripts` is stable across versions and matches the store's never-run-scripts stance.

**Silently retry or skip installs that fail.** Rejected: the visible-failure change is the point; a failed mutation must name its cause in the notice.

## Consequences

Bundle install/remove/update are hot on profiles whose host registers the composer; the store's message states "applied live" so the UI can drop the restart hint. When the composer is absent or rejects, the mutation still succeeds on disk and the UI reports a restart with the reason, so a bad patch can never be silently half-applied.

The Include update path is now a load-bearing extension point: `refreshProfileComposition` replays the entire patch stack on every store mutation, so any composition bug surfaces as a visible store failure rather than a silent drift. Profiles without a CLI host (tests, embedded boots) are unaffected.

pnpm never executes dependency install scripts from the store: installs are deterministic and supply-chain-safe, at the cost of skipping packages whose `postinstall` genuinely configures them.

The store index is now self-healing at scrape time: registry packages whose metadata cannot resolve a `latest` version are excluded before they ever reach a user's install button.
