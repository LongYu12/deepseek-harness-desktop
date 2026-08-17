/** Per-Session provider balance state feeding the Session Header capsule. */

import type { BalanceView, IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SessionId, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Balance-fetch lifecycle phases presented by the capsule. */
export type BalancePhase = 'loading' | 'ready' | 'failed'

/** One Session's current balance state. */
export interface BalanceEntry {
  readonly phase: BalancePhase
  /** Provider of the Session's current model, resolved on the first load. */
  readonly provider: string | null
  /** Account balances reported by the provider's balance query. */
  readonly balances: readonly BalanceView[]
}

/** Balance states keyed by the Session whose Header owns the capsule. */
export interface BalanceState {
  bySession: Record<string, BalanceEntry | undefined>
}

const INITIAL: BalanceState = { bySession: {} }

/**
 * Owns one in-flight balance query per Session: the first load resolves the
 * Session's current-model provider through the model-selection API and then
 * queries that provider's balance; manual refreshes reuse the known provider.
 */
export class BalanceIndicatorController {
  /** uSES-safe state source shared by every Session-scoped capsule. */
  readonly store: SnapshotStore<BalanceState> = createSnapshotStore(INITIAL)

  private readonly active = new Map<SessionId, { readonly abort: AbortController; readonly done: Promise<void> }>()
  private disposed = false

  /** @param api - Host wire client carrying the model-selection and balance queries. */
  constructor(private readonly api: IApiClient) {}

  /**
   * Fetch one Session's provider balance, resolving the provider from the
   * Session's current model selection. Concurrent gestures share one operation.
   * @param sessionId - Session whose current model picks the queried provider.
   * @returns after the state settles, or immediately for a post-disposal call.
   */
  load(sessionId: SessionId): Promise<void> {
    return this.start(sessionId, null)
  }

  /**
   * Re-fetch the balance after a capsule click: reuses the resolved provider
   * when one is known, falling back to the full load otherwise.
   * @param sessionId - Session whose capsule was clicked.
   * @returns after the state settles, or immediately for a post-disposal call.
   */
  refresh(sessionId: SessionId): Promise<void> {
    const known = this.store.getSnapshot().bySession[String(sessionId)]?.provider ?? null
    return this.start(sessionId, known)
  }

  /** Abort every in-flight query; late resolutions publish nothing. */
  dispose(): void {
    this.disposed = true
    for (const operation of this.active.values()) operation.abort.abort()
  }

  private start(sessionId: SessionId, providerHint: string | null): Promise<void> {
    const existing = this.active.get(sessionId)
    if (existing !== undefined) return existing.done
    if (this.disposed) return Promise.resolve()
    const abort = new AbortController()
    const done = this.run(sessionId, abort.signal, providerHint).finally(() => {
      this.active.delete(sessionId)
    })
    this.active.set(sessionId, { abort, done })
    return done
  }

  private async run(sessionId: SessionId, signal: AbortSignal, providerHint: string | null): Promise<void> {
    this.publish(sessionId, { phase: 'loading', provider: providerHint, balances: [] })
    let provider = providerHint
    try {
      if (provider === null) {
        const models = await this.api.sessions.models({ sessionId }, signal)
        if (signal.aborted) return
        if (!models.result.ok) throw new Error(models.result.error.message)
        provider = models.result.value.current.provider
      }
      const balance = await this.api.llm.balance({ provider }, signal)
      if (signal.aborted) return
      if (!balance.result.ok) throw new Error(balance.result.error.message)
      this.publish(sessionId, { phase: 'ready', provider, balances: balance.result.value.balances })
    } catch {
      if (signal.aborted) return
      this.publish(sessionId, { phase: 'failed', provider, balances: [] })
    }
  }

  private publish(sessionId: SessionId, entry: BalanceEntry): void {
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: entry }
    })
  }
}
