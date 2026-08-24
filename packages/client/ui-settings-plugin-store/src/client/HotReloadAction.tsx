/** Optional settings-header action for hot-reloading the profile patch stack. */

import { useState, type ReactNode } from 'react'
import type { StoreMutationResult } from '@deepseek-ai/dsh-api-remotes/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './HotReloadAction.module.css'

/** Registrant-owned dependencies of {@link HotReloadAction}. */
export interface HotReloadActionInjected {
  /** Re-run the host's live profile composer without restarting the process. */
  hotReload: () => Promise<StoreMutationResult>
  /** Desktop shell restart; absent on plain web deployments. */
  restartApp?: () => Promise<void>
}

/** Header-action owner share, localized copy, and the registrant's Remote face. */
export type HotReloadActionProps =
  PropsRuntime<'settings.action'> & PropsLocale<'settings.pluginStore'> & HotReloadActionInjected

type ReloadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'done'; readonly ok: boolean; readonly message: string }

/**
 * Render the hot-reload action: reapplies the full profile patch stack live,
 * so bundle imports and store-layer writes take effect without a restart.
 * When the host reports a restart is the only way to apply, the desktop
 * shell restarts the app through its own executable path instead.
 * @param props - header owner props, localized copy, and the Remote face.
 * @returns the action button with an outcome notice.
 */
export function HotReloadAction({ hotReload, restartApp, t }: HotReloadActionProps): ReactNode {
  const [state, setState] = useState<ReloadState>({ kind: 'idle' })

  const run = (): void => {
    if (state.kind === 'busy') return
    setState({ kind: 'busy' })
    void hotReload().then(
      (result) => {
        if (result.restartNeeded && restartApp !== undefined) {
          // The desktop shell exits this renderer as the app restarts; a
          // rejection here is the expected teardown, not a failure to report.
          setState({ kind: 'done', ok: true, message: t('restarting') })
          void restartApp().catch(() => {})
          return
        }
        setState({ kind: 'done', ok: result.ok, message: result.message })
      },
      (error: unknown) => {
        setState({
          kind: 'done',
          ok: false,
          message: error instanceof Error ? error.message : t('hotReloadFailed'),
        })
      },
    )
  }

  return (
    <div className={css.action}>
      {state.kind === 'done' ? (
        <span className={state.ok ? css.outcome : css.error} role={state.ok ? 'status' : 'alert'}>
          {state.message}
        </span>
      ) : null}
      <Button variant="outline" size="sm" disabled={state.kind === 'busy'} onClick={run}>
        {state.kind === 'busy' ? t('hotReloading') : t('hotReload')}
      </Button>
    </div>
  )
}
