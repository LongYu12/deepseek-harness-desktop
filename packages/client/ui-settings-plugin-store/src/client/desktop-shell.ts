/** Desktop shell bridge types and detection for the plugin store UI. */

/**
 * The app-control bridge the Electron desktop shell exposes to the renderer
 * through its preload script; absent on plain web deployments.
 */
export interface DesktopShell {
  /** Restart the desktop app through its own executable path. */
  restartApp: () => Promise<void>
}

declare global {
  interface Window {
    /** Electron desktop shell bridge; undefined on plain web deployments. */
    desktopShell?: DesktopShell
  }
}

/** The desktop shell bridge, or undefined when running on plain web. */
export function desktopShell(): DesktopShell | undefined {
  return window.desktopShell
}
