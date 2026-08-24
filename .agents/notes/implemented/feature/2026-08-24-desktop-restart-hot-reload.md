# Agent Note: Desktop hot reload restarts the app through its own executable

Status: implemented

English | [中文](2026-08-24-desktop-restart-hot-reload.zh.md)

## Problem

The plugin store's header hot-reload action reapplies the profile patch stack
through the host's live composer when one exists, and otherwise reports
`restartNeeded: true` with an instruction to restart the process. On the
desktop app that instruction was a dead end: the user had to close the window
and relaunch the executable manually, and nothing in the UI could do it for
them. The desktop shell (`apps/desktop`) had no renderer-to-main bridge at
all — no preload script, no IPC — so the web UI running in the Electron
window could not ask the shell to restart itself.

## Decision

Add a minimal restart bridge to the desktop shell and make the hot-reload
action use it when the host says a restart is the only way to apply.

**Desktop shell: preload + IPC restart.** A new `apps/desktop/src/preload.cts`
exposes `window.desktopShell.restartApp()` through `contextBridge`; it is
emitted as CommonJS (`lib/preload.cjs`) because sandboxed renderers cannot
load ESM preload scripts, and the tsconfig picks up `.cts` without changing
the main process's ESM output. The main process registers
`ipcMain.handle('dsh:restart-app', ...)`, which resolves the running
executable with `app.getPath('exe')`, stops the spawned children (backend
and local store) so no orphan holds the profile or ports, then
`app.relaunch({ execPath })` + `app.quit()` so the next instance starts only
after this one has fully exited — no race with the single-instance lock. The
window now loads the preload; `electron-builder.yml` already ships
`lib/**/*`, so the packaged app carries it unchanged.

**UI: restart when live apply is impossible.** `HotReloadAction` accepts an
optional `restartApp` injection (absent on plain web deployments). When the
host's `hotReload` result carries `restartNeeded`, the action shows the
"restarting" notice and fires `restartApp()`; the renderer is torn down by
the restart, so the invocation's rejection is the expected teardown and is
swallowed. The registrant (`ui-settings-plugin-store`'s `apply`) detects the
bridge via a `desktopShell()` helper and injects it only when present; the
web deployment's behavior is unchanged. Copy adds a localized "Restarting
the app…" line in both languages.

## Alternatives considered

**Always restart on the desktop, skipping the live composer.** Rejected: the
composer makes bundle mutations apply in seconds without dropping the window
or session; restarting unconditionally would regress that path on profiles
whose host registers the composer.

**Spawn the executable directly and exit.** Rejected: a detached spawn races
the single-instance lock — the new instance can start while the old one still
holds it, then quit, leaving no app at all. `app.relaunch` defers the new
instance until this one has exited.

**ESM preload.** Rejected: sandboxed preload scripts cannot load ESM, and
disabling the sandbox to host one weakens the renderer's isolation.

## Consequences

On the desktop app, a hot-reload that cannot apply live now restarts the app
through its own executable path automatically, so an install/remove/update
that needs a boot-time composition change no longer strands the user at a
"restart the process" notice. Plain web deployments keep the previous
behavior exactly. The desktop shell gains its first renderer-to-main bridge;
future shell capabilities (window controls, updates) can extend the same
`desktopShell` surface.
