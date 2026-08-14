# Agent Note: Electron desktop shell distributes the dsh web backend

Status: implemented

English | [中文](2026-08-14-electron-desktop-shell-distribution.zh.md)

## Problem

The harness distributes through npm and the [single-exe SDK runtime](2026-07-10-single-file-executable-sdk-runtime-distribution.md); both surfaces are terminal-shaped and the single-exe route treats Windows as a non-target. A product audience wants a double-clickable desktop application with a graphical UI, no Node installation on the target machine, Windows and macOS installers, and a setup-style installation — none of which either existing route provides.

The `dsh web` profile already runs the complete product as a local Node HTTP server plus the shipped Web UI. The desktop problem therefore reduces to: carry that exact backend into an installer, run it without an external Node, and put a window around it — without forking the product into a second UI implementation.

## Decision

`apps/desktop` (`@deepseek-ai/dsh-desktop`, a private workspace member) is an Electron shell whose main process spawns the real `dsh` backend as a child: `spawn(process.execPath, [bin.js, '--profile', 'web', '--port', '0'], { env: { ELECTRON_RUN_AS_NODE: '1' } })`. `ELECTRON_RUN_AS_NODE` makes Electron's own bundled Node run the backend, so the installer ships no separate Node runtime. The shell waits for the documented supervisor ready line `dsh web: http://127.0.0.1:<port>` on the child's stdout (with `--port 0` the printed port is the OS-assigned one), then opens a `BrowserWindow` on that URL. A single-instance lock guards duplicate launches; window-all-closed and quit dispose the backend's whole process tree (`taskkill /t /f` on Windows, SIGTERM elsewhere).

The backend ships as a symlink-free dependency closure produced by the same measured `pnpm deploy --legacy --prod` route as the single-exe pipeline. The deploy, hoist-restore, and link-materialization steps live in the shared `scripts/deploy-closure.ts` module that both pipelines call; `scripts/build-desktop.ts` stages the closure into `apps/desktop/backend` (pruning `.pdb` debug symbols), and an `afterPack` hook (`apps/desktop/after-pack.cjs`) copies it into `resources/dsh-backend/` outside the asar, which holds only the shell's `lib/`. The closure cannot ship through `extraResources`: electron-builder's resource filter unconditionally skips a copied tree's root `node_modules`. Dev mode (`desktop:dev`) skips packaging and spawns the source tree's `apps/cli/lib/bin.js`; `DSH_DESKTOP_BACKEND_BIN` overrides the bin path. The pack step always passes `--publish never`, because electron-builder treats a CI environment as an implicit publish request against the release host.

The closure deploy has two side effects that the pipeline counters. The deploy's internal production install prunes devDependencies across the whole workspace, so the pipeline sets `--config.ignore-scripts=true` (the root postinstall's lefthook import tolerates the prune) and re-runs `pnpm install` after staging to restore the developer checkout. Legacy deploy also omits undeclared peers and vendor packages that survive only through override links, so `deploy-closure.ts` fills every missing `@deepseek-ai` package from its workspace build output — `package.json` plus `lib/` for lib-main packages — iterating until the staged tree declares no unsatisfied workspace-scope dependency.

Native addons in the closure must stay N-API stable under Electron's ABI, and the shipped set is: koffi requires N-API ≥ 8 and resolves its binary through `process.resourcesPath`, sharp is N-API, and node-pty ships per-platform prebuilds with the `DSH_NODE_PTY_SPAWN_HELPER` helper bypass from `patches/node-pty@1.1.0.patch`. No electron-rebuild step exists. N-API stability is necessary but not sufficient: Electron's NAPI layer rejects external ArrayBuffers, so `koffi.view()` aborts the process with `napi_fatal_error` under `ELECTRON_RUN_AS_NODE`; the Win32 folder-dialog bindings therefore read the selected path with fixed-size `char16` array decodes instead (`dsh-host-directory-picker-native`'s `readUtf16`), which Electron's NAPI layer accepts.

`electron-builder` produces the first targets: `win-x64` NSIS (installer lets the user choose the install directory) and `mac-arm64` dmg + zip, unsigned (`identity: null`), no auto-update. Root scripts `desktop:dev` and `desktop:build` (`--targets=win-x64,mac-arm64`) drive `scripts/build-desktop.ts`; installers land in `apps/desktop/dist-release/`. The application icon ships as `apps/desktop/build/icon.png` (the mascot artwork, generator watermark removed); electron-builder derives the platform icons from it. First-run API-key entry reuses the existing Web settings page, and user data stays in `$DSH_HOME`, which uninstallers leave untouched.

## Alternatives considered

- **Bundle a standalone Node runtime next to the backend**: rejected — Electron already carries a Node runtime; `ELECTRON_RUN_AS_NODE` reuses it for free, while a second runtime adds size, version drift, and its own supply chain.
- **Serve the Web UI from the renderer via `file://` or a custom scheme**: rejected — it forks the serving path (static serving, websocket downlink, host API proxy semantics) into a second source of truth; loading the real `dsh web` HTTP server keeps desktop and browser semantics identical by construction.
- **Reuse the single-exe executable as the desktop backend carrier**: rejected — the single-exe route embeds its own Node and treats Windows as a non-target; the two pipelines instead share the closure-deploy steps through `scripts/deploy-closure.ts`.
- **electron-rebuild native addons against the Electron ABI**: rejected — every shipped addon is N-API stable (see above), so rebuilding buys no correctness and adds a fragile build step; the requirement is stated in the closure's build script instead.
- **Tauri or a native webview wrapper**: rejected — the backend still needs a Node runtime, which reintroduces exactly what Electron already carries, plus a second toolchain the repository does not otherwise have.

## Consequences

- Installers carry Electron's physical size floor (the win-x64 NSIS artifact measures roughly 137 MB); a smaller carrier is not available on this route.
- Two runtime carriers — standalone `dsh web` and the Electron child — now run one code tree; backend behavior must stay UI-agnostic, and readiness is pinned to the stdout line both carriers print.
- Builds run on the target platform because platform-conditional addons resolve for the host only: win-x64 builds on Windows, mac-arm64 builds on macOS.
- koffi code reachable from the backend must avoid external-ArrayBuffer APIs (`koffi.view` is the only one today): they work under plain Node and abort only under Electron's NAPI layer, so regressions surface solely in the desktop carrier.
- macOS artifacts are unsigned; users see the Gatekeeper prompt until a signing certificate and notarization are added.
- The npm publish and Python-SDK exe pipelines are untouched; the desktop pipeline coexists with them and shares only the closure-deploy module.
- The deploy mutates the developer checkout by pruning devDependencies; every pipeline reusing `deploy-closure.ts` must restore them with `pnpm install` after staging.
