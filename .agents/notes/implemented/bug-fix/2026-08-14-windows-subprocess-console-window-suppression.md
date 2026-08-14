# Agent Note: Windows subprocess console-window suppression

Status: implemented

English | [中文](2026-08-14-windows-subprocess-console-window-suppression.zh.md)

## Problem

The [desktop shell](../architecture/2026-08-14-electron-desktop-shell-distribution.md) runs the `dsh` backend under `ELECTRON_RUN_AS_NODE`, a GUI-subsystem process with no attached console. On Windows, spawning a console-subsystem child (`pwsh.exe`, the packaged `rg.exe`, `taskkill.exe`) from a consoleless parent allocates a NEW visible console window for the child unless `CREATE_NO_WINDOW` suppresses it, so every shell command, search, and tree teardown flashed a black console window over the product UI. Terminal-carrier runs never showed the defect because the backend inherits the launching terminal's console and children share it.

## Decision

Every Windows-reachable spawn in the subprocess plumbing sets Node's `windowsHide: true` (maps to `CREATE_NO_WINDOW`): the seam's single spawn site in `dsh-subprocess-local/spawn.ts` (`spawnSubprocess`), its `taskkillProcessTree` fallback, and the desktop shell's quit-time `taskkill`. The flag is inert on POSIX. The ACL sandbox's confined children get the same suppression: the earlier finding that `CREATE_NO_WINDOW` children die with `STATUS_DLL_INIT_FAILED` was tied to the console logon SID the port excludes, and controlled re-experiments (both stdio shapes, both restriction modes, consoleless host) showed the flag working normally, so `dsh-sandbox-windows-acl/spawn.ts` checks `GetConsoleWindow` and adds `CREATE_NO_WINDOW` exactly when the host has no console — the desktop-carrier shape; console-bearing hosts keep children attached to their console as before, and the windows-acl runner process itself runs hidden.

## Alternatives considered

- **Setting `windowsHide` only in the desktop shell**: rejected — the spawn site the shell cannot reach is the subprocess seam itself; the flag belongs where every carrier's spawns funnel through, and terminal carriers are unaffected by it.
- **`detached: true` on Windows to detach consoles**: rejected — `detached` changes tree-teardown semantics (the seam terminates by root pid through `taskkill /T` precisely because Windows children stay attached), and it still leaves console allocation unspecified.
- **Giving the backend an allocated console at startup and hiding it**: rejected — a second moving window-state (allocate, then hide) is more fragile than never allocating one, and `CREATE_NO_WINDOW` already expresses the intent at each spawn.

## Consequences

- Desktop-carrier tool runs no longer flash console windows for seam-spawned children; POSIX and terminal-carrier behavior is unchanged.
- Desktop-carrier sandboxed shell commands run console-less too: the confined child inherits the `CREATE_NO_WINDOW` suppression from its consoleless runner host. `CREATE_NEW_CONSOLE` remains untested under the restriction and is never requested.
