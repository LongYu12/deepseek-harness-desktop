/**
 * Build the dsh desktop installers. Deploys the `@deepseek-ai/dsh` runtime
 * closure (the same measured legacy-deploy route as the single-exe pipeline)
 * into the Electron app's extraResources and runs electron-builder per target.
 * The backend runs under Electron's own Node runtime, so native addons must
 * be N-API stable; the shipped set (node-pty prebuilds, koffi, sharp) is.
 * Builds run on the target platform: platform-conditional addons resolve for
 * the host only.
 */

import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  assertSafeStagingDir,
  failCli,
  helpCli,
  legacyDeployArgs,
  materializeStagedLinks,
  restoreLegacyHoists,
  runStep,
} from './deploy-closure.ts'

const root = resolve(import.meta.dirname, '..')

/** Log and error message owner for this pipeline. */
const PREFIX = 'build-desktop'
/** Deploy root: the CLI package owns the web profile's full dependency set. */
const DEPLOY_ROOT_PACKAGE = '@deepseek-ai/dsh'
/** The deploy source whose node_modules restores legacy hoists. */
const DEPLOY_SOURCE_NODE_MODULES = join('apps', 'cli', 'node_modules')
/** Electron app workspace and its backend staging directory. */
const DESKTOP_PACKAGE = '@deepseek-ai/dsh-desktop'
const DESKTOP_DIR = join('apps', 'desktop')
const STAGING_SUBDIR = 'backend'
/** Weight that never reaches users: native addon debug symbols. */
const PRUNE_SUFFIXES = ['.pdb'] as const

/** Installer targets; each names an electron-builder platform and arch. */
const TARGETS = ['win-x64', 'mac-arm64'] as const
type Target = (typeof TARGETS)[number]

function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value)
}

/**
 * Resolve the host-platform default target.
 * @returns the host target.
 */
function hostTarget(): Target {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win-x64'
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'mac-arm64'
  throw new Error(`build-desktop: unsupported host ${process.platform}-${process.arch}; pass --targets explicitly.`)
}

/**
 * Validated CLI configuration; construction owns help and parse-error exits.
 */
class BuildCli {
  private constructor(
    /** Installer targets; defaults to the host platform. */
    readonly targets: readonly Target[],
    /** Compile the shell and launch it against the source tree; no packaging. */
    readonly dev: boolean,
    /** Skip step 1 (`pnpm run build`); lib/ and dist/ artifacts must exist. */
    readonly skipBuild: boolean,
    /** Stop after staging the backend closure; no installer. */
    readonly skipPack: boolean,
    /** Print every command instead of executing. */
    readonly dryRun: boolean,
  ) {}

  /**
   * Parse argv. Help exits 0; malformed flags exit 1; invalid targets throw.
   * @param argv - the raw arguments (`process.argv.slice(2)`).
   * @returns the parsed, validated configuration.
   */
  static parse(argv: string[]): BuildCli {
    let values: ReturnType<typeof BuildCli.parseRaw>
    try {
      values = BuildCli.parseRaw(argv)
    } catch (error) {
      failCli('build-desktop', error, BuildCli.usage())
    }
    if (values.help) helpCli(BuildCli.usage())
    const targets = values.targets === undefined
      ? [hostTarget()]
      : values.targets.split(',').map(part => part.trim()).filter(part => part !== '').map((spec) => {
        if (!isTarget(spec)) {
          throw new Error(`build-desktop: target must be one of ${TARGETS.join(', ')}, got ${JSON.stringify(spec)}.`)
        }
        return spec
      })
    if (targets.length === 0) throw new Error('build-desktop: --targets is empty.')
    if (new Set(targets).size !== targets.length) throw new Error(`build-desktop: duplicate targets in ${JSON.stringify(values.targets)}.`)
    return new BuildCli(targets, values.dev, values['skip-build'], values['skip-pack'], values['dry-run'])
  }

  private static parseRaw(argv: string[]) {
    return parseArgs({
      args: argv,
      options: {
        'targets': { type: 'string' },
        'dev': { type: 'boolean', default: false },
        'skip-build': { type: 'boolean', default: false },
        'skip-pack': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'help': { type: 'boolean', default: false },
      },
    }).values
  }

  private static usage(): string {
    return [
      'Usage: pnpm exec tsx scripts/build-desktop.ts [flags]',
      '',
      `  --targets=<t1,t2,...>  installer targets: ${TARGETS.join(', ')}. Default: the host platform.`,
      '  --dev                  compile the shell and launch it against the source tree (no packaging).',
      '  --skip-build           skip `pnpm run build` (lib/ and dist/ artifacts must already exist).',
      '  --skip-pack            stage the backend closure only; produce no installer.',
      '  --dry-run              print every command without executing.',
      '  --help                 print this help.',
      '',
      'Products land in apps/desktop/dist-release/.',
    ].join('\n')
  }
}

/**
 * Sequential desktop build pipeline. Subprocesses inherit stdio and errors
 * include the command; dry runs print commands and filesystem changes.
 */
class DesktopBuild {
  /** The cleared backend closure electron-builder ships as extraResources. */
  readonly staging = resolve(root, DESKTOP_DIR, STAGING_SUBDIR)

  constructor(private readonly cli: BuildCli) {}

  /** Build every package artifact the closure ships, unless skipped. */
  async build(): Promise<void> {
    if (this.cli.skipBuild) {
      console.log(`${PREFIX}: skipping pnpm run build (--skip-build)`)
      return
    }
    await runStep(PREFIX, 'build', ['run', 'build'], this.cli.dryRun)
  }

  /** Compile the Electron main process from apps/desktop/src to lib. */
  async buildShell(): Promise<void> {
    await runStep(PREFIX, 'desktop shell', ['--filter', DESKTOP_PACKAGE, 'run', 'build'], this.cli.dryRun)
  }

  /** Launch the shell against the source tree; the developer owns shutdown. */
  async launchDev(): Promise<void> {
    await runStep(PREFIX, 'dev launch', ['--filter', DESKTOP_PACKAGE, 'exec', 'electron', '.'], this.cli.dryRun)
  }

  /** Clear and deploy the CLI runtime closure into the app's backend dir. */
  async deployBackend(): Promise<void> {
    assertSafeStagingDir(PREFIX, this.staging)
    if (this.cli.dryRun) console.log(`${PREFIX}: [dry-run] rm -rf ${this.staging}`)
    else await rm(this.staging, { recursive: true, force: true })
    await runStep(PREFIX, 'deploy', legacyDeployArgs(DEPLOY_ROOT_PACKAGE, this.staging, { autoInstallPeers: true, ignoreScripts: true }), this.cli.dryRun)
    await restoreLegacyHoists(PREFIX, this.staging, resolve(root, DEPLOY_SOURCE_NODE_MODULES), this.cli.dryRun)
    await materializeStagedLinks(PREFIX, this.staging, this.cli.dryRun)
    await this.pruneDebugSymbols()
    this.assertBackendBin()
    // The deploy's production install prunes workspace devDependencies;
    // restore them so the packaging step (electron-builder) and the
    // developer's checkout both keep working.
    await runStep(PREFIX, 'restore dev dependencies', ['install'], this.cli.dryRun)
  }

  /** Drop native addon debug symbols from the staged closure. */
  private async pruneDebugSymbols(): Promise<void> {
    if (this.cli.dryRun) {
      console.log(`${PREFIX}: [dry-run] prune ${PRUNE_SUFFIXES.join(', ')} from ${join(this.staging, 'node_modules')}`)
      return
    }
    let removed = 0
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(path)
          continue
        }
        if (PRUNE_SUFFIXES.some(suffix => entry.name.endsWith(suffix))) {
          await rm(path, { force: true })
          removed += 1
        }
      }
    }
    await walk(join(this.staging, 'node_modules'))
    console.log(`${PREFIX}: pruned ${String(removed)} debug symbol files`)
  }

  /** Fail loud when the deployed closure lacks the dsh bin the shell spawns. */
  private assertBackendBin(): void {
    if (this.cli.dryRun) return
    // The deploy root lands at the staging root itself, not in node_modules.
    const bin = join(this.staging, 'lib', 'bin.js')
    if (!existsSync(bin)) {
      throw new Error(`${PREFIX}: ${bin} missing after deploy — run without --skip-build so lib/ artifacts exist.`)
    }
  }

  /**
   * Run electron-builder for one target from the desktop workspace.
   * Publishing is always off: this pipeline only produces artifacts, and
   * electron-builder otherwise treats a CI environment as an implicit
   * publish request against the release host.
   * @param target - the installer target to produce.
   */
  async pack(target: Target): Promise<void> {
    const platform = target === 'win-x64' ? 'win' : 'mac'
    const arch = target.split('-')[1] as string
    const targets = target === 'win-x64' ? ['nsis'] : ['dmg', 'zip']
    await runStep(PREFIX, `electron-builder ${target}`, [
      '--filter',
      DESKTOP_PACKAGE,
      'exec',
      'electron-builder',
      `--${platform}`,
      ...targets,
      `--${arch}`,
      '--publish',
      'never',
    ], this.cli.dryRun)
  }
}

async function main(): Promise<void> {
  const cli = BuildCli.parse(process.argv.slice(2))
  const pipeline = new DesktopBuild(cli)
  console.log(`${PREFIX}: targets: ${cli.targets.join(', ')}${cli.dev ? ' (dev launch)' : ''}`)
  await pipeline.build()
  await pipeline.buildShell()
  if (cli.dev) {
    await pipeline.launchDev()
    return
  }
  await pipeline.deployBackend()
  if (cli.skipPack) {
    console.log(`${PREFIX}: staged backend closure at ${pipeline.staging} (--skip-pack)`)
    return
  }
  for (const target of cli.targets) await pipeline.pack(target)
  console.log(`${PREFIX}: products in ${join(root, DESKTOP_DIR, 'dist-release')}`)
}

await main()
