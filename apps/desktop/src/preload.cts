/**
 * Desktop shell preload: exposes the minimal app-control bridge to the
 * sandboxed renderer. Emitted as CommonJS (`lib/preload.cjs`) because
 * sandboxed preload scripts cannot load ESM.
 */

import { contextBridge, ipcRenderer } from 'electron'

/** IPC channel carrying one restart request from the UI to the main process. */
const RESTART_CHANNEL = 'dsh:restart-app'

contextBridge.exposeInMainWorld('desktopShell', {
  /** Restart the desktop app through its own executable path. */
  restartApp: (): Promise<void> => ipcRenderer.invoke(RESTART_CHANNEL),
})
