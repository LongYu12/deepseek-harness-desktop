/**
 * dsh desktop shell main process. Spawns the dsh web backend on an OS-assigned
 * port under Electron's own Node runtime (`ELECTRON_RUN_AS_NODE`), waits for
 * the backend's documented readiness line, and opens one window on the served
 * UI. Closing the window disposes the backend; the shell never outlives it.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, shell } from 'electron'

/**
 * Readiness handshake: the web app prints its bound URL once every row has
 * settled (packages/bundle/web-app owns the line), so the shell treats the
 * captured URL as "the backend is serving".
 */
const READY_URL_PATTERN = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/

/** First boot initializes the web profile and boots the full plugin tree. */
const BACKEND_READY_TIMEOUT_MS = 90_000

/** How much backend stderr the startup error dialog retains. */
const STDERR_TAIL_CHARS = 2_000

/** Compiled main process directory (apps/desktop/lib in both planes). */
const here = dirname(fileURLToPath(import.meta.url))

/**
 * Resolve the backend bin for this plane. `DSH_DESKTOP_BACKEND_BIN` overrides
 * both (developer escape hatch); packaged builds carry the deployed closure
 * under the app resources; dev runs use the sibling apps/cli build output.
 * @returns the absolute path of the dsh bin entry.
 */
function backendBinPath(): string {
  const override = process.env.DSH_DESKTOP_BACKEND_BIN
  if (override !== undefined && override !== '') return override
  if (app.isPackaged) {
    // The deployed closure roots at the dsh package itself: bin lives at its lib/.
    return join(process.resourcesPath, 'dsh-backend', 'lib', 'bin.js')
  }
  return join(here, '..', '..', 'cli', 'lib', 'bin.js')
}

/** One backend process and the readiness facts observed on its stdio. */
class Backend {
  /** The child once spawned; undefined before {@link start}. */
  child: ChildProcess | undefined
  /** Resolves with the served URL on readiness, rejects on startup failure. */
  readonly ready: Promise<string>
  private stdoutBuffer = ''
  private stderrTail = ''
  private settled = false

  constructor() {
    this.ready = new Promise<string>((resolvePromise, rejectPromise) => {
      this.readyResolve = resolvePromise
      this.readyReject = rejectPromise
    })
  }

  /** Attached by the promise executor; always set before any settlement path runs. */
  private readyResolve!: (url: string) => void
  /** Attached by the promise executor; always set before any settlement path runs. */
  private readyReject!: (error: Error) => void

  /**
   * Spawn the dsh web profile on an OS-assigned port under Electron's Node.
   * @param bin - the dsh bin entry resolved for this plane.
   */
  start(bin: string): void {
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => {
      this.observeStdout(chunk.toString('utf8'))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS)
    })
    child.once('error', (error) => {
      this.fail(new Error(`backend failed to spawn: ${error.message}`))
    })
    child.once('exit', (code, signal) => {
      if (!this.settled) {
        const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${String(code)}`
        this.fail(new Error(`backend exited during startup (${cause})\n${this.stderrTail}`))
      }
    })
  }

  /** Kill the backend process tree; idempotent. */
  stop(): void {
    killChildTree(this.child)
  }

  private observeStdout(text: string): void {
    if (this.settled) return
    this.stdoutBuffer += text
    const match = READY_URL_PATTERN.exec(this.stdoutBuffer)
    if (match === null || match[1] === undefined) return
    this.settled = true
    this.readyResolve(match[1])
  }

  private fail(error: Error): void {
    if (this.settled) return
    this.settled = true
    this.readyReject(error)
  }
}

/**
 * The local plugin-store index server: the zero-dependency Node HTTP server
 * over the bundled `local-plugin-store/index.json`, auto-spawned with the app
 * so a configured `indexUrl` needs no manual launcher. A port already in use
 * means another instance owns the store; that child exits 0 by itself.
 */
class LocalStoreServer {
  /** The child once spawned; undefined before {@link start}. */
  child: ChildProcess | undefined

  /** Spawn the bundled store server unless this plane ships no store. */
  start(): void {
    const bin = localStoreBin()
    if (bin === undefined) return
    const child = spawn(process.execPath, [bin], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    this.child = child
    // Diagnostics only: the store is a convenience, never a startup gate.
    child.stderr.on('data', (chunk: Buffer) => {
      console.error(`dsh-desktop local-store: ${chunk.toString('utf8').trimEnd()}`)
    })
  }

  /** Kill the spawned server; idempotent, and never touches another instance. */
  stop(): void {
    killChildTree(this.child)
  }
}

/**
 * Kill one spawned child process tree; idempotent, and never touches another
 * instance. Windows kills are tree-scoped so a child's own children (PTY
 * shells, workers) do not survive their parent.
 */
function killChildTree(child: ChildProcess | undefined): void {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    return
  }
  child.kill('SIGTERM')
}

/**
 * The bundled local-plugin-store entry for this plane: packaged builds carry
 * the directory under app resources; dev runs use the repository copy.
 * @returns the serve.mjs path, or undefined when this plane ships no store.
 */
function localStoreBin(): string | undefined {
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'local-plugin-store')
    : join(here, '..', '..', '..', 'local-plugin-store')
  const bin = join(dir, 'serve.mjs')
  return existsSync(bin) ? bin : undefined
}

const backend = new Backend()
const storeServer = new LocalStoreServer()
let mainWindow: BrowserWindow | undefined

/** Open the main window on the served backend URL. */
function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // The UI opens external links in the system browser, never in-shell.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://') || target.startsWith('https://')) void shell.openExternal(target)
    return { action: 'deny' }
  })
  mainWindow.once('closed', () => { mainWindow = undefined })
  void mainWindow.loadURL(url)
}

/** Surface a startup failure and exit non-zero. */
function reportStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`dsh-desktop: ${message}`)
  dialog.showErrorBox('DeepSeek Harness failed to start', message)
  backend.stop()
  app.exit(1)
}

// One backend per machine: a second launch focuses the running window instead
// of racing a second profile boot.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    const bin = backendBinPath()
    if (!existsSync(bin)) {
      reportStartupFailure(new Error(`backend bin not found at ${bin}`))
      return
    }
    backend.start(bin)
    storeServer.start()
    const timeout = setTimeout(() => {
      void backend.ready.catch(() => {})
      reportStartupFailure(new Error(`backend did not become ready within ${String(BACKEND_READY_TIMEOUT_MS / 1000)}s`))
    }, BACKEND_READY_TIMEOUT_MS)
    backend.ready.then((url) => {
      clearTimeout(timeout)
      createWindow(url)
    }).catch((error: unknown) => {
      clearTimeout(timeout)
      reportStartupFailure(error)
    })
  })

  // The backend IS the app on every platform: closing the window quits, and
  // quit owns the backend teardown.
  app.on('window-all-closed', () => { app.quit() })
  app.on('quit', () => {
    backend.stop()
    storeServer.stop()
  })
}
