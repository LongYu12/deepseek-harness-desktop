/**
 * Shared pnpm legacy-deploy closure utilities. Both artifact pipelines (the
 * single-exe SDK runtime and the desktop installer) deploy a workspace
 * package into a symlink-free, hoisted closure the same measured way; this
 * module owns that sequence so the two pipelines cannot drift.
 * @module scripts/deploy-closure
 */

import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

/** The repository root these pipelines run from. */
export const repositoryRoot = resolve(import.meta.dirname, '..')

/**
 * Render a command for logs and errors, quoting arguments with spaces.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns the printable command line.
 */
export function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/**
 * Run one pnpm step with inherited stdio. Windows cannot spawn the pnpm.cmd
 * shim directly, so the JavaScript entrypoint named by npm_execpath runs
 * under the current Node binary, keeping every host shell-free (the same
 * idiom as run-gates). Spawn and non-zero-exit errors include the command;
 * dry runs only print it.
 * @param prefix - the pipeline name used in logs and error messages.
 * @param label - the step name used in logs and error messages.
 * @param args - the pnpm arguments.
 * @param dryRun - print the command instead of executing it.
 */
export async function runStep(prefix: string, label: string, args: string[], dryRun = false): Promise<void> {
  const printable = formatCommand('pnpm', args)
  if (dryRun) {
    console.log(`${prefix}: [dry-run] ${printable}`)
    return
  }
  const entrypoint = process.env.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error(`${prefix}: npm_execpath is unavailable; invoke the pipeline through a pnpm package script.`)
  }
  console.log(`${prefix}: ${label}: ${printable}`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args], {
      cwd: repositoryRoot,
      stdio: 'inherit',
      // Artifact builds must not mutate or validate a developer's Git hooks.
      env: { ...process.env, CI: 'true' },
    })
    child.once('error', (error) => {
      reject(new Error(`${prefix}: ${label} failed to spawn: ${error.message} (${printable})`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      reject(new Error(`${prefix}: ${label} failed (${cause}): ${printable}`))
    })
  })
}

/**
 * Report a CLI parse error with usage and exit 1. Both pipelines parse the
 * same flag families, so they share this exit shape.
 * @param prefix - the pipeline name shown in the error line.
 * @param error - the thrown parse error.
 * @param usage - the usage text printed after the error.
 */
export function failCli(prefix: string, error: unknown, usage: string): never {
  console.error(`${prefix}: ${error instanceof Error ? error.message : String(error)}\n`)
  console.error(usage)
  process.exit(1)
}

/**
 * Print usage and exit 0 for a `--help` request.
 * @param usage - the usage text to print.
 */
export function helpCli(usage: string): never {
  console.log(usage)
  process.exit(0)
}

/**
 * Refuse a staging directory that contains or is contained by the repo root:
 * the caller is about to clear it recursively.
 * @param prefix - the pipeline name used in error messages.
 * @param staging - the staging directory to validate.
 */
export function assertSafeStagingDir(prefix: string, staging: string): void {
  if (staging === repositoryRoot || repositoryRoot.startsWith(staging + sep)) {
    throw new Error(`${prefix}: refusing to clear staging dir ${staging}: it contains the repo root.`)
  }
}

/** Deploy flag choices that legitimately differ between pipelines. */
export interface LegacyDeployOptions {
  /**
   * Install undeclared peer dependencies. The desktop closure deploys a real
   * app whose runtime imports peers (cordis plugin packages), so peers must
   * install; the single-exe closure manifest pins its exact set and keeps
   * them off.
   */
  readonly autoInstallPeers?: boolean
  /**
   * Skip lifecycle scripts during the deploy's production install. The
   * install prunes dev-only script dependencies before the root postinstall
   * runs, so a developer checkout aborts without this; callers that set it
   * replicate the staging postinstall fix themselves where it matters.
   */
  readonly ignoreScripts?: boolean
}

/**
 * The pnpm deploy flags both pipelines grounded in measurement: legacy mode is
 * the mandatory path with inject-workspace-packages off; hoisted gives a
 * stable single-instance layout the materialization pass makes symlink-free;
 * automatic peer installation defaults off so undeclared peers cannot expand
 * the closure unless the caller opts in; link-workspace-packages selects
 * direct workspace dependencies; verify-deps-before-run off keeps the non-TTY
 * CI subprocess from aborting on a confirm prompt to refresh the modules
 * directory; lifecycle scripts run unless the caller opts out.
 * @param filter - the deploy-root workspace package name.
 * @param staging - the deploy destination.
 * @param options - per-pipeline flag choices.
 * @returns the full pnpm argument list.
 */
export function legacyDeployArgs(filter: string, staging: string, options: LegacyDeployOptions = {}): string[] {
  const args = [
    '--filter',
    filter,
    'deploy',
    '--legacy',
    '--prod',
    '--config.node-linker=hoisted',
    `--config.auto-install-peers=${options.autoInstallPeers === true ? 'true' : 'false'}`,
    '--config.link-workspace-packages=true',
    '--config.verify-deps-before-run=false',
  ]
  if (options.ignoreScripts === true) args.push('--config.ignore-scripts=true')
  args.push(staging)
  return args
}

/**
 * Restore direct packages that pnpm's legacy hoister places beside the deploy
 * source instead of in the target, then close every workspace-scope package
 * gap left in the staged tree. The deploy-root manifest supplies every direct
 * dependency; source-tree packages survive only through hoisting alongside a
 * package that declares them (the single-exe closure manifest itself, for
 * instance), so the staged closure copies any missing workspace package from
 * its build output, repeating until the staged tree declares no unsatisfied
 * workspace-scope dependency. Package-local
 * node_modules trees are omitted to preserve one flat runtime instance and a
 * symlink-free payload.
 * @param prefix - the pipeline name used in logs and error messages.
 * @param staging - the deployed closure root holding package.json.
 * @param sourceNodeModules - the deploy source's node_modules to restore from.
 * @param dryRun - log the step instead of executing it.
 */
export async function restoreLegacyHoists(prefix: string, staging: string, sourceNodeModules: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`${prefix}: [dry-run] restore direct dependencies omitted by legacy deploy`)
    return
  }
  const manifestPath = join(staging, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const restored: string[] = []
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(staging, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceNodeModules, dependency)
    if (!existsSync(source)) {
      throw new Error(
        `${prefix}: deployed dependency ${dependency} is absent from both ${destination} and ${source}.`,
      )
    }
    await mkdir(dirname(destination), { recursive: true })
    const nestedNodeModules = join(source, 'node_modules')
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    restored.push(dependency)
  }
  const stillMissing = Object.keys(manifest.dependencies ?? {})
    .filter(dependency => !existsSync(join(staging, 'node_modules', dependency)))
  if (stillMissing.length > 0) {
    throw new Error(`${prefix}: staged dependencies remain missing: ${stillMissing.join(', ')}.`)
  }
  if (restored.length > 0) {
    console.log(`${prefix}: restored legacy deploy hoists: ${restored.join(', ')}`)
  }
  await restoreMissingWorkspacePeers(prefix, staging)
}

/** The scope whose missing packages the closure copies from workspace trees. */
const WORKSPACE_SCOPE = '@deepseek-ai'

/**
 * Copy every workspace-scope package the staged tree declares but lacks, from
 * the workspace package's built output (a lib-main package contributes its
 * package.json plus lib/; anything else its whole tree minus node_modules),
 * until no gap remains. Filled packages are scanned in turn, so dependency
 * chains converge.
 * @param prefix - the pipeline name used in logs and error messages.
 * @param staging - the deployed closure root whose node_modules is filled.
 */
async function restoreMissingWorkspacePeers(prefix: string, staging: string): Promise<void> {
  const stagedNodeModules = join(staging, 'node_modules')
  let pending = await missingWorkspacePeers(stagedNodeModules)
  if (pending.length === 0) return
  const locations = await workspacePackageLocations(prefix)
  const filled: string[] = []
  while (pending.length > 0) {
    for (const dependency of pending) {
      const location = locations.get(dependency)
      if (location === undefined) {
        throw new Error(`${prefix}: staged peer ${dependency} is not a workspace package.`)
      }
      // The closure runs built artifacts: a workspace package whose entry
      // sits under lib/ contributes its build output, not its source tree.
      const manifest = JSON.parse(await readFile(join(location, 'package.json'), 'utf8')) as { main?: string }
      const entrySegment = manifest.main?.replace(/^\.\//, '').split('/')[0]
      const libBuilt = entrySegment === 'lib'
      const destination = join(stagedNodeModules, dependency)
      if (libBuilt) {
        await mkdir(destination, { recursive: true })
        await cp(join(location, 'package.json'), join(destination, 'package.json'))
        await cp(join(location, 'lib'), join(destination, 'lib'), { recursive: true, dereference: true })
      } else {
        const nestedNodeModules = join(location, 'node_modules')
        await cp(location, destination, {
          recursive: true,
          dereference: true,
          filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
        })
      }
      filled.push(dependency)
    }
    pending = await missingWorkspacePeers(stagedNodeModules)
  }
  console.log(`${prefix}: restored missing workspace packages: ${filled.sort().join(', ')}`)
}

/**
 * Every workspace package name mapped to its source directory, per pnpm's
 * own recursive listing.
 * @param prefix - the pipeline name used in error messages.
 * @returns the name-to-directory map.
 */
async function workspacePackageLocations(prefix: string): Promise<Map<string, string>> {
  const entrypoint = process.env.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error(`${prefix}: npm_execpath is unavailable; invoke the pipeline through a pnpm package script.`)
  }
  const stdout = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entrypoint, 'list', '-r', '--depth', '-1', '--json'], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, CI: 'true' },
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.once('error', (error) => {
      reject(new Error(`${prefix}: pnpm list failed to spawn: ${error.message}`))
    })
    child.once('exit', (code) => {
      if (code === 0) resolvePromise(output)
      else reject(new Error(`${prefix}: pnpm list failed (exit code ${code}).`))
    })
  })
  const projects = JSON.parse(stdout) as Array<{ name?: string; path: string }>
  const locations = new Map<string, string>()
  for (const project of projects) {
    if (project.name !== undefined) locations.set(project.name, project.path)
  }
  return locations
}

/**
 * The workspace-scope packages (dependencies, peers, optional) declared by
 * staged packages but absent from the staged tree. Override-linked vendor
 * packages and undeclared peers both surface here.
 * @param stagedNodeModules - the staged closure's node_modules.
 * @returns the sorted, deduplicated missing package names.
 */
async function missingWorkspacePeers(stagedNodeModules: string): Promise<string[]> {
  const missing = new Set<string>()
  for (const manifestPath of await packageManifests(stagedNodeModules)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]
    for (const dependency of declared) {
      if (!dependency.startsWith(`${WORKSPACE_SCOPE}/`)) continue
      if (existsSync(join(stagedNodeModules, dependency))) continue
      missing.add(dependency)
    }
  }
  return [...missing].sort()
}

/**
 * Every top-level and scoped package manifest below a node_modules root.
 * @param nodeModules - the node_modules directory to scan.
 * @returns absolute package.json paths.
 */
async function packageManifests(nodeModules: string): Promise<string[]> {
  const manifests: string[] = []
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      for (const scoped of await readdir(join(nodeModules, entry.name), { withFileTypes: true })) {
        manifests.push(join(nodeModules, entry.name, scoped.name, 'package.json'))
      }
      continue
    }
    manifests.push(join(nodeModules, entry.name, 'package.json'))
  }
  return manifests.filter(manifest => existsSync(manifest))
}

/**
 * Replace deploy-time package links with files and reject any remaining link.
 * `.bin` directories are removed outright: their entries exist only as links.
 * @param prefix - the pipeline name used in logs.
 * @param staging - the deployed closure root whose node_modules is materialized.
 * @param dryRun - log the step instead of executing it.
 */
export async function materializeStagedLinks(prefix: string, staging: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`${prefix}: [dry-run] materialize staged package links`)
    return
  }
  const nodeModules = join(staging, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const destination = remaining
    const source = await realpath(destination)
    const nestedNodeModules = join(source, 'node_modules')
    await rm(destination, { recursive: true, force: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    remaining = await findSymlink(nodeModules)
  }
}

/**
 * Find the first symbolic link below a directory, if one exists.
 * @param directory - the directory walked recursively.
 * @returns the first symlink path, or `undefined` when none remains.
 */
async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}
