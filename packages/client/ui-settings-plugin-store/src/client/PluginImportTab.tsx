import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { StoreMutationProgress, StoreMutationResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PluginImportTab.module.css'

/** Registration-side Remote face used by the import tab. */
export interface PluginImportTabInjected {
  /** Import a plugin from a command or guarded spec into the active profile. */
  importBundle: (input: string) => Promise<StoreMutationResult>
  /** Subscribe to live store mutation progress; returns the disposer. */
  subscribeProgress: (listener: (progress: StoreMutationProgress) => void) => () => void
  /** Request the store tab to re-read its inventory after a successful import. */
  notifyInventoryChanged: () => void
}

/** Full component props assembled by the Settings slot renderer. */
export type PluginImportTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginStore'>
  & InjectFace<PluginImportTabInjected>

type ImportState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'done'; readonly ok: boolean; readonly message: string; readonly restartNeeded: boolean }

/**
 * The progress key the host emits for an import: the spec after `add` in a
 * command, or the bare input verbatim. Commands the host rejects never emit
 * matching progress, so an unparseable input degrades to no live lines.
 */
function importTarget(input: string): string {
  const tokens = input.split(/\s+/)
  return tokens[0] === 'dsh' ? (tokens[tokens.length - 1] ?? input) : input
}

/**
 * Render plugin import: one command-or-spec field, a submit action, and a
 * live progress surface streaming the running pnpm's stderr lines.
 */
export function PluginImportTab(injected: PluginImportTabProps): ReactNode {
  const { importBundle, subscribeProgress, notifyInventoryChanged, t } = injected
  const [spec, setSpec] = useState('')
  const [state, setState] = useState<ImportState>({ kind: 'idle' })
  const [progress, setProgress] = useState<StoreMutationProgress | null>(null)
  /** The in-flight import's resolved target; progress lines are filtered on it. */
  const submittedSpec = useRef<string | null>(null)

  useEffect(() => subscribeProgress((next) => {
    // The host resolves the target from the submitted input, so only lines
    // whose target equals the in-flight spec belong to this tab's import.
    if (submittedSpec.current !== null && next.target === submittedSpec.current) setProgress(next)
  }), [subscribeProgress])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const trimmed = spec.trim()
    if (trimmed.length === 0 || state.kind === 'busy') return
    // Progress events carry the host-resolved target (the spec after `add`,
    // or the bare input verbatim), so a pasted command is projected onto the
    // same key before the import starts.
    submittedSpec.current = importTarget(trimmed)
    setProgress(null)
    setState({ kind: 'busy' })
    void importBundle(trimmed).then(
      (result) => {
        setState({
          kind: 'done',
          ok: result.ok,
          message: result.ok ? `${t('importSuccess')} ${result.message}` : result.message,
          restartNeeded: result.restartNeeded,
        })
        if (result.ok) notifyInventoryChanged()
      },
      () => { setState({ kind: 'done', ok: false, message: t('importFailed'), restartNeeded: false }) },
    ).finally(() => {
      submittedSpec.current = null
      setProgress(null)
    })
  }

  return (
    <div className={css.section} aria-busy={state.kind === 'busy'}>
      <p className={css.status}>{t('importIntro')}</p>
      <form className={css.form} onSubmit={submit}>
        <label className={css.field}>
          <span className={css.visuallyHidden}>{t('importLabel')}</span>
          <input
            type="text"
            value={spec}
            spellCheck={false}
            placeholder={t('importPlaceholder')}
            aria-label={t('importLabel')}
            onChange={(event) => { setSpec(event.currentTarget.value) }}
          />
        </label>
        <button type="submit" disabled={spec.trim().length === 0 || state.kind === 'busy'}>
          {state.kind === 'busy' ? t('importing') : t('importButton')}
        </button>
      </form>
      <p className={css.hint}>{t('importHint')}</p>
      {state.kind === 'busy' ? (
        <div className={css.progress} role="status" data-progress="import">
          <progress aria-label={t('importProgressLabel')} />
          {progress !== null ? (
            <>
              <p className={css.progressTarget}>{progress.target}</p>
              <p className={css.progressLine}>{progress.line}</p>
            </>
          ) : (
            <p className={css.progressLine}>{t('importing')}</p>
          )}
        </div>
      ) : null}
      {state.kind === 'done' ? (
        <p className={css.notice} role={state.ok ? 'status' : 'alert'} data-notice={state.ok ? 'success' : 'error'}>
          {state.message}
        </p>
      ) : null}
      {state.kind === 'done' && state.ok && state.restartNeeded ? (
        <p className={css.restart}>{t('restartHint')}</p>
      ) : null}
    </div>
  )
}
