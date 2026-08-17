/**
 * Account-balance interrogation against the DeepSeek platform's
 * `/user/balance` endpoint. Transport-only, like the adapter: connection
 * facts and the bearer token arrive through the same per-operation
 * resolution hooks the plugin owns, so the balance request can only ever
 * pair the endpoint and the credential of one configuration generation.
 *
 * @module dsh-llm-deepseek/balance
 */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmBalanceInfo } from '@deepseek-ai/dsh-llm'
import type { DeepSeekConnectionOptions } from './adapter.ts'

/** The resolution hooks the plugin already owns for model requests. */
export interface DeepSeekBalanceQueryOptions {
  /** Current validated connection facts; called once per interrogation. */
  options: () => DeepSeekConnectionOptions
  /**
   * Resolve the bearer token for the connection facts of this interrogation.
   * The snapshot pairing rule is the adapter's: the key resolves from the
   * same resolution as the endpoint it is sent to.
   */
  resolveApiKey: (connection: DeepSeekConnectionOptions) => Promise<string>
}

/**
 * Build the balance query this plugin registers on `ctx.llm` under its
 * settings namespace. Each call re-resolves connection facts and the
 * credential, so a configuration change reaches the next interrogation.
 * @param config - the plugin's per-operation resolution hooks.
 * @returns an `LlmBalanceQuery` over `{baseURL}/user/balance`.
 */
export function createDeepSeekBalanceQuery(
  config: DeepSeekBalanceQueryOptions,
): (signal?: AbortSignal) => Promise<LlmBalanceInfo[]> {
  return async (signal?: AbortSignal): Promise<LlmBalanceInfo[]> => {
    const connection = config.options()
    const apiKey = await config.resolveApiKey(connection)
    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/user/balance`, {
        method: 'GET',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'accept': 'application/json',
          ...attributionHeaders(),
        },
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted) {
        throw new LlmError('DeepSeek balance request aborted by caller', 'ABORTED', { cause: error })
      }
      throw new LlmError(
        `DeepSeek balance request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }
    if (!response.ok) {
      throw new LlmError(
        `DeepSeek balance endpoint at ${connection.baseURL} answered ${response.status}`,
        'BALANCE_UNAVAILABLE',
        { status: response.status },
      )
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error: unknown) {
      throw new LlmError(
        `DeepSeek balance endpoint at ${connection.baseURL} returned a non-JSON body`,
        'BALANCE_UNAVAILABLE',
        { cause: error },
      )
    }
    return mapDeepSeekBalanceResponse(payload, connection.baseURL)
  }
}

/** Parse one decimal-string amount the platform reports. */
function balanceAmount(raw: unknown, field: string, baseURL: string): number {
  const parsed = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isFinite(parsed)) {
    throw new LlmError(
      `DeepSeek balance endpoint at ${baseURL} reported a non-numeric ${field}`,
      'BALANCE_UNAVAILABLE',
    )
  }
  return parsed
}

/**
 * Validate and map the platform's balance document to provider-neutral
 * entries. The wire shape is a trust boundary, so every field is judged;
 * an unexpected document refuses the whole reply rather than guessing.
 * @param payload - parsed response body of `/user/balance`.
 * @param baseURL - endpoint named in refusals (never the credential).
 * @returns currency entries in provider order.
 */
export function mapDeepSeekBalanceResponse(payload: unknown, baseURL: string): LlmBalanceInfo[] {
  const unexpected = (): LlmError => new LlmError(
    `DeepSeek balance endpoint at ${baseURL} returned an unexpected document`,
    'BALANCE_UNAVAILABLE',
  )
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw unexpected()
  const infos = (payload as { balance_infos?: unknown }).balance_infos
  if (!Array.isArray(infos)) throw unexpected()
  return infos.map((entry: unknown): LlmBalanceInfo => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw unexpected()
    const currency = (entry as { currency?: unknown }).currency
    if (typeof currency !== 'string' || currency.length === 0) throw unexpected()
    return {
      currency,
      availableBalance: balanceAmount((entry as { available_balance?: unknown }).available_balance, 'available_balance', baseURL),
      totalBalance: balanceAmount((entry as { total_balance?: unknown }).total_balance, 'total_balance', baseURL),
    }
  })
}
