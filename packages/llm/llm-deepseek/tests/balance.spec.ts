import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { userAgent } from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { createDeepSeekBalanceQuery, mapDeepSeekBalanceResponse, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { closeMockServers, mockServer } from './mock-server.ts'

const NS = settingsNamespace('llm-deepseek')

let testHome: string

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-llm-deepseek-balance-'))
  vi.stubEnv('DSH_HOME', testHome)
})

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
  rmSync(testHome, { recursive: true, force: true })
})

async function harness(baseURL: string) {
  // The key comes from the environment, the whole credential plane without
  // a mounted seam — the same posture the adapter specs exercise.
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmDeepSeek, { baseURL })
  return ctx
}

const BALANCE_DOCUMENT = JSON.stringify({
  is_available: true,
  balance_infos: [{
    currency: 'CNY',
    total_balance: '100.000000000',
    granted_balance: '5.000000000',
    topped_up_balance: '7.500000000',
  }],
})

describe('llm-deepseek balance query', () => {
  it('registers under the plugin namespace and maps the platform document', async () => {
    const server = await mockServer([{ kind: 'json', body: BALANCE_DOCUMENT }])
    const ctx = await harness(server.url)

    await expect(ctx.llm.queryBalance(NS)).resolves.toEqual([
      { currency: 'CNY', availableBalance: 12.5, totalBalance: 100 },
    ])
    // The wire request rode the balance route with this plugin's identity.
    expect(server.paths[0]).toBe('/user/balance')
    expect(server.headers[0]?.authorization).toBe('Bearer test-key')
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
  })

  it('re-resolves the endpoint and credential on every interrogation', async () => {
    // The query shares the plugin's per-operation hooks; a mutable options
    // thunk stands in for a settings rotation without mounting the seam.
    const first = await mockServer([{ kind: 'json', body: BALANCE_DOCUMENT }])
    const second = await mockServer([{ kind: 'json', body: BALANCE_DOCUMENT }])
    let baseURL = first.url
    let apiKey = 'first-key'
    const query = createDeepSeekBalanceQuery({
      options: () => resolveAdapterOptions({ baseURL }),
      resolveApiKey: () => Promise.resolve(apiKey),
    })

    await query()
    expect(first.headers[0]?.authorization).toBe('Bearer first-key')

    baseURL = second.url
    apiKey = 'rotated-key'
    await query()
    expect(second.paths[0]).toBe('/user/balance')
    expect(second.headers[0]?.authorization).toBe('Bearer rotated-key')
  })

  it('fails keyless the same way a model request does', async () => {
    const server = await mockServer([])
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { baseURL: server.url })
    await expect(ctx.llm.queryBalance(NS)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('reports a non-2xx endpoint answer as unavailable with its status', async () => {
    const server = await mockServer([{ kind: 'json', body: '{"error":"forbidden"}', status: 403 }])
    const ctx = await harness(server.url)
    await expect(ctx.llm.queryBalance(NS))
      .rejects.toMatchObject({ code: 'BALANCE_UNAVAILABLE', failure: { status: 403 } })
  })

  it('reports a non-JSON body and an unreachable endpoint as unavailable', async () => {
    const server = await mockServer([{ kind: 'json', body: 'not-json', status: 200 }])
    const ctx = await harness(server.url)
    await expect(ctx.llm.queryBalance(NS)).rejects.toMatchObject({ code: 'BALANCE_UNAVAILABLE' })

    const unreachable = new Context()
    await unreachable.plugin(LlmRuntime)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    await unreachable.plugin(LlmDeepSeek, { baseURL: 'http://127.0.0.1:1' })
    await expect(unreachable.llm.queryBalance(NS)).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('honors caller cancellation before the wire request settles', async () => {
    const server = await mockServer([])
    const ctx = await harness(server.url)
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.llm.queryBalance(NS, controller.signal))
      .rejects.toMatchObject({ code: 'ABORTED' })
  })
})

describe('mapDeepSeekBalanceResponse', () => {
  const BASE = 'https://api.deepseek.com'

  /** The stable code of whatever a mapping call throws, or `undefined` if it returns. */
  function codeOf(fn: () => unknown): string | undefined {
    try {
      fn()
    } catch (error) {
      return (error as { code?: string }).code
    }
    return undefined
  }

  it('accepts numeric amounts alongside the platform decimal strings', () => {
    expect(mapDeepSeekBalanceResponse({
      balance_infos: [{ currency: 'USD', total_balance: 4, granted_balance: 1.5, topped_up_balance: 1 }],
    }, BASE)).toEqual([{ currency: 'USD', availableBalance: 2.5, totalBalance: 4 }])
  })

  it('sums the granted and topped-up amounts into the spendable balance', () => {
    expect(mapDeepSeekBalanceResponse({
      balance_infos: [{ currency: 'CNY', total_balance: '53.21', granted_balance: '0.00', topped_up_balance: '53.21' }],
    }, BASE)).toEqual([{ currency: 'CNY', availableBalance: 53.21, totalBalance: 53.21 }])
  })

  it('refuses a document that is not an object holding balance_infos', () => {
    for (const payload of [null, 'x', [], {}, { balance_infos: 'nope' }]) {
      expect(codeOf(() => mapDeepSeekBalanceResponse(payload, BASE))).toBe('BALANCE_UNAVAILABLE')
    }
  })

  it('refuses malformed entries without guessing any field', () => {
    for (const entry of [
      null,
      [],
      { currency: '', total_balance: '1', granted_balance: '1', topped_up_balance: '0' },
      { currency: 'CNY', total_balance: 'not-a-number', granted_balance: '1', topped_up_balance: '0' },
      { currency: 'CNY', total_balance: '1', granted_balance: null, topped_up_balance: '0' },
      { currency: 'CNY', total_balance: '1', granted_balance: '1' },
    ]) {
      expect(codeOf(() => mapDeepSeekBalanceResponse({ balance_infos: [entry] }, BASE)))
        .toBe('BALANCE_UNAVAILABLE')
    }
  })
})
