/** pnpm runner for store mutations, plus the registry-name allowlist guard. */

import { spawnSync } from 'node:child_process'

/**
 * Registry package name shape: an npm registry name (optionally scoped),
 * lowercase, no path segments, no git/tarball/version specs. The store only
 * installs registry names — any other spec is rejected before pnpm runs.
 */
const REGISTRY_PACKAGE_NAME = /^@?[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)?$/

/**
 * Reject anything that is not a plain registry package name. Path, git,
 * tarball, and version-range specs all fail here: the store's trust model
 * only covers registry resolution.
 * @param packageName - the requested install target.
 * @throws when the name is not a bare registry package name.
 */
export function assertRegistryPackageName(packageName: string): void {
  if (!REGISTRY_PACKAGE_NAME.test(packageName)) {
    throw new Error(
      `plugin-store: ${JSON.stringify(packageName)} is not a registry package name — `
      + 'the store only installs bare registry names (no path, git, tarball, or version specs)',
    )
  }
}

/** One pnpm invocation's outcome. */
export interface PnpmRunResult {
  readonly exitCode: number
  /** Captured stderr (trimmed) for the failure diagnostic. */
  readonly stderr: string
}

/** Run pnpm with arguments in a directory and report the outcome. */
export type PnpmRunner = (args: readonly string[], cwd: string) => Promise<PnpmRunResult> | PnpmRunResult

/**
 * Default runner: spawn pnpm synchronously in the profile directory,
 * capturing stderr. Windows resolves pnpm through its .cmd shim, which
 * spawn() refuses without a shell since the CVE-2024-27980 hardening.
 * @param args - pnpm arguments.
 * @param cwd - the profile directory.
 * @returns the exit code and stderr tail; exit code 127 means pnpm is absent.
 */
export function spawnPnpm(args: readonly string[], cwd: string): PnpmRunResult {
  const result = spawnSync('pnpm', [...args], {
    cwd,
    shell: process.platform === 'win32',
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  /* v8 ignore start -- under the Windows shell a missing pnpm is the shell's
     own exit code rather than a spawn error, and spawn-level failures beyond
     ENOENT are OS conditions tests cannot portably synthesize */
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { exitCode: 127, stderr: 'pnpm not found on PATH' }
    throw result.error
  }
  /* v8 ignore stop */
  const status = result.status
  /* v8 ignore next 2 -- a signal-killed spawn reports no status; treat it as failure */
  if (status === null) return { exitCode: 1, stderr: result.stderr.trim() }
  return { exitCode: status, stderr: result.stderr.trim() }
}
