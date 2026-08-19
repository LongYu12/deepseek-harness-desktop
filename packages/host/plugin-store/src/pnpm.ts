/** pnpm runner for store mutations, plus the registry/git/tarball import guards. */

import { spawn, spawnSync } from 'node:child_process'

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

/**
 * GitHub shorthand forms accepted for import: `github:owner/repo` or bare
 * `owner/repo`, optionally with a `#ref` suffix. Both segments start with an
 * alphanumeric (a leading dot would admit `./local` path installs), and the
 * charset is a URL-safe allowlist that excludes whitespace and every shell
 * metacharacter, so the spec can never escape the pnpm argument on platforms
 * that run pnpm under a shell.
 */
const GIT_SHORTHAND = /^(?:github:)?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:#[A-Za-z0-9._/-]+)?$/

/**
 * Git URL forms accepted for import: `git+https:`, `git+ssh:`, `git:`, and
 * `https:` URLs ending in `.git` (pnpm treats a URL without the suffix as a
 * tarball fetch), optionally with a `#ref` suffix. Plain `http:` is rejected
 * as unencrypted, and the allowlist excludes every shell metacharacter.
 */
const GIT_URL = /^(?:git\+https|git\+ssh|git|https):\/\/[A-Za-z0-9._~:%+@/-]+\.git(?:#[A-Za-z0-9._/-]+)?$/

/**
 * Tarball URL forms accepted for import: `https:` URLs ending in `.tar.gz`,
 * optionally with a `#ref` suffix (which pnpm ignores on a tarball). The
 * charset matches the git URL allowlist and excludes every shell
 * metacharacter, so the spec can never escape the pnpm argument on platforms
 * that run pnpm under a shell.
 */
const TARBALL_URL = /^https:\/\/[A-Za-z0-9._~:%+@/-]+\.tar\.gz(?:#[A-Za-z0-9._/-]+)?$/

/** One parsed `dsh plugin ... add <spec>` import command. */
export interface PluginImportCommand {
  /** The `--profile` value when the command names one; bare specs carry none. */
  readonly profile: string | undefined
  /** The import target after `add`, or the bare spec verbatim. */
  readonly spec: string
}

/**
 * Parse a plugin import command into its profile and spec parts. Both the
 * full CLI form (`dsh plugin [--profile <name>] add <spec>`) and a bare
 * import spec are accepted, so a user can paste a copied command or just the
 * spec. Input that looks like a `dsh` command but not an import is rejected
 * with the accepted forms named.
 * @param input - the pasted command or spec.
 * @returns the profile (when named) and the trimmed spec.
 * @throws when the input starts like a `dsh` command but is not an import.
 */
export function parsePluginImportCommand(input: string): PluginImportCommand {
  const trimmed = input.trim()
  const tokens = trimmed.split(/\s+/).filter(token => token.length > 0)
  if (tokens[0] !== 'dsh') return { profile: undefined, spec: trimmed }
  const reject = (): Error => new Error(
    `plugin-store: ${JSON.stringify(input)} is not a plugin import command — `
    + 'expected "dsh plugin [--profile <name>] add <spec>" or a bare import spec',
  )
  if (tokens[1] !== 'plugin') throw reject()
  let profile: string | undefined
  let addIndex = 2
  if (tokens[2] === '--profile') {
    const name = tokens[3]
    if (name === undefined || name.startsWith('-')) throw reject()
    profile = name
    addIndex = 4
  }
  if (tokens[addIndex] !== 'add' || tokens.length !== addIndex + 2) throw reject()
  const spec = tokens[addIndex + 1]
  if (spec === undefined) throw reject()
  return { profile, spec }
}

/** The import-target class a spec resolves to. */
export type ImportSpecKind = 'registry' | 'git' | 'tarball'

/** A validated import target with its resolution kind. */
export interface ResolvedImportSpec {
  readonly kind: ImportSpecKind
  /** The trimmed spec passed to pnpm verbatim. */
  readonly spec: string
}

/**
 * Resolve an import target to the pnpm spec form it needs. Order matters: a
 * bare `owner/repo` matches both the GitHub shorthand and the registry name
 * grammar, and the shorthand wins (it imports from GitHub, not npm); a
 * scoped `@owner/name` cannot match the shorthand (leading `@`) and falls
 * through to the registry. Git URLs and tarball URLs then follow; anything
 * else is rejected naming the accepted forms.
 * @param spec - the import target.
 * @returns the kind and the validated spec passed to pnpm.
 * @throws when the spec matches no accepted import form.
 */
export function resolveImportSpec(spec: string): ResolvedImportSpec {
  const trimmed = spec.trim()
  if (GIT_SHORTHAND.test(trimmed)) return { kind: 'git', spec: trimmed }
  if (REGISTRY_PACKAGE_NAME.test(trimmed)) return { kind: 'registry', spec: trimmed }
  if (GIT_URL.test(trimmed)) return { kind: 'git', spec: trimmed }
  if (TARBALL_URL.test(trimmed)) return { kind: 'tarball', spec: trimmed }
  throw new Error(
    `plugin-store: ${JSON.stringify(spec)} is not an importable plugin target — `
    + 'expected a registry package name (e.g. dshmarket), a GitHub spec '
    + '(owner/repo, github:owner/repo, or a git+https:/https: .git URL), '
    + 'or an https: tarball URL ending in .tar.gz',
  )
}

/** One pnpm invocation's outcome. */
export interface PnpmRunResult {
  readonly exitCode: number
  /** Captured stderr (trimmed) for the failure diagnostic. */
  readonly stderr: string
}

/**
 * Run pnpm with arguments in a directory and report the outcome. The
 * optional listener receives each non-empty stderr line as it is produced —
 * the progress surface the UI streams while a mutation runs.
 */
export type PnpmRunner = (
  args: readonly string[],
  cwd: string,
  onProgress?: (line: string) => void,
) => Promise<PnpmRunResult> | PnpmRunResult

/**
 * pnpm commands that install packages and therefore declare the
 * `--ignore-scripts` option. pnpm's strict CLI rejects options a command
 * does not declare, so the flag must not be appended to every invocation:
 * `pnpm remove` and `pnpm update` both fail with "Unknown option:
 * 'ignore-scripts'" (verified against pnpm 11.7.0 `pnpm help`).
 */
const INSTALLING_COMMANDS = new Set(['add', 'install', 'i'])

/**
 * Default runner: spawn pnpm synchronously in the profile directory,
 * capturing stderr. Windows resolves pnpm through its .cmd shim, which
 * spawn() refuses without a shell since the CVE-2024-27980 hardening.
 *
 * Installing mutations pass `--ignore-scripts`: pnpm 11 hard-fails an
 * install whose dependency tree carries unapproved build scripts
 * (`ERR_PNPM_IGNORED_BUILDS`, exit 1) even though the packages are already
 * written, so without the flag the store would report a failed install for
 * a package that actually landed. The store never runs dependency scripts
 * anyway — installation is the package's code plus its published artifact,
 * and approving arbitrary postinstall scripts is a supply-chain risk.
 * @param args - pnpm arguments.
 * @param cwd - the profile directory.
 * @returns the exit code and stderr tail; exit code 127 means pnpm is absent.
 */
export function spawnPnpm(args: readonly string[], cwd: string): PnpmRunResult {
  const extra = INSTALLING_COMMANDS.has(args[0] ?? '') ? ['--ignore-scripts'] : []
  const result = spawnSync('pnpm', [...args, ...extra], {
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

/**
 * Streaming pnpm runner: spawn pnpm asynchronously and forward each
 * non-empty stderr line to the listener as it arrives, so callers can show
 * live progress. Outcome semantics match {@link spawnPnpm}: exit code 127
 * means pnpm is absent (a Windows shell reports it as the shell's own exit
 * code), and a signal-killed child reports exit code 1.
 * @param args - pnpm arguments.
 * @param cwd - the profile directory.
 * @param onProgress - receives each non-empty stderr line as it is produced.
 * @returns the exit code and stderr tail; exit code 127 means pnpm is absent.
 */
export function spawnPnpmStreaming(
  args: readonly string[],
  cwd: string,
  onProgress: (line: string) => void,
): Promise<PnpmRunResult> {
  const extra = INSTALLING_COMMANDS.has(args[0] ?? '') ? ['--ignore-scripts'] : []
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', [...args, ...extra], {
      cwd,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    let buffer = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '').trimEnd()
        buffer = buffer.slice(newline + 1)
        if (line.length > 0) onProgress(line)
      }
    })
    /* v8 ignore start -- a missing pnpm surfaces as the shell's own exit code on
       Windows and as a spawn-level ENOENT on POSIX; other spawn failures are OS
       conditions tests cannot portably synthesize */
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ exitCode: 127, stderr: 'pnpm not found on PATH' })
      } else {
        reject(error)
      }
    })
    /* v8 ignore stop */
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stderr: stderr.trim() })
    })
  })
}
