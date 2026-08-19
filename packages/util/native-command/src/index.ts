/**
 * Shared no-shell `execFile` runner plus the cross-platform native path and
 * text-document openers for host-native OS integrations (the native directory
 * chooser, the open-with-default-application hand-off): utf8 stdio capture,
 * abort propagation, Windows console hide. A library, not a plugin — no ctx,
 * no state, no events.
 * @module @deepseek-ai/dsh-native-command
 */

export { runNativeCommand, type NativeCommandRunner } from './runner.ts'
export {
  canOpenNativePath,
  openNativePath,
  openNativeTextFile,
  type PathOpenerInternals,
  type PathOpenerRunner,
} from './native-path-opener.ts'
