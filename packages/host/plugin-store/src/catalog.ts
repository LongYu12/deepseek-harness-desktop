/** The store catalog: a shipped builtin index, optionally overridden by a remote index URL. */

import { assertRegistryPackageName } from './pnpm.ts'
import type { StoreCatalog, StoreCatalogEntry } from './types.ts'

/** The official bundles the builtin catalog ships with. */
export const BUILTIN_CATALOG: readonly StoreCatalogEntry[] = [
  {
    name: '@deepseek-ai/dsh-base',
    description: 'Core bundle: agents, sessions, tools, and the base composition.',
    descriptionZh: '核心 bundle：agent、会话、工具与基础组合。',
    author: 'DeepSeek AI',
    tags: ['official', 'core'],
  },
  {
    name: '@deepseek-ai/dsh-web-app',
    description: 'Web application bundle: browser UI over the local webserver.',
    descriptionZh: 'Web 应用 bundle：本地 webserver 之上的浏览器界面。',
    author: 'DeepSeek AI',
    tags: ['official', 'web'],
  },
  {
    name: '@deepseek-ai/dsh-headless',
    description: 'Headless bundle: terminal-only operation without a browser UI.',
    descriptionZh: 'Headless bundle：无浏览器界面的纯终端运行。',
    author: 'DeepSeek AI',
    tags: ['official', 'headless'],
  },
  {
    name: '@linxin666/dsh-web-ui-all',
    description: 'One-click aggregate of the whole dsh web UI family: task board, git graph, pet, remote web UI, live stats (balance view), and skin center.',
    descriptionZh: 'DSH Web UI 全家桶聚合插件：一键安装任务看板、git 图谱、宠物、远程 Web UI、实时统计（余额查看）与皮肤中心等功能插件。',
    author: 'linxin666',
    tags: ['community', 'web-ui'],
  },
  {
    name: 'dsh-usage-stats',
    description: 'Lightweight usage analytics for DeepSeek Harness: token trends, activity heatmaps, model breakdowns, and exports.',
    descriptionZh: 'DSH 用量统计：token 趋势、活跃热力图、模型用量拆分与导出。',
    author: 'lanlandeli',
    tags: ['community', 'usage'],
  },
  {
    name: 'dshmarket',
    description: 'Visual plugin market inside DeepSeek Harness: browse, search, and one-click install community plugins from a sidebar entry.',
    descriptionZh: 'DSH 可视化插件市场：浏览、搜索并一键安装社区插件，提供侧边栏入口以丰富侧边栏。',
    author: 'fkysly',
    tags: ['community', 'marketplace'],
  },
  {
    name: 'dsh-skin-market',
    description: 'Skin marketplace: browse and apply community skins for the DeepSeek Harness web UI.',
    descriptionZh: '皮肤市场：浏览并应用 DeepSeek Harness Web 界面的社区皮肤。',
    author: '',
    tags: ['community', 'skin'],
  },
]

/** Catalog resolution inputs. */
export interface StoreCatalogOptions {
  /** Remote index URL; the builtin catalog is returned when unset. */
  indexUrl?: string
  /** Remote fetch timeout in milliseconds. */
  fetchTimeoutMs: number
  /** Injectable fetch implementation (tests substitute a fake). */
  fetchImpl?: typeof fetch
}

/**
 * Resolve the store catalog. Without `indexUrl` the shipped builtin catalog
 * is returned; with it, the remote index is fetched under
 * {@link StoreCatalogOptions.fetchTimeoutMs} and validated against the same
 * entry schema. A fetch, HTTP, parse, or validation failure throws — a
 * configured index that cannot serve a valid catalog is a misconfiguration,
 * never a silent fallback to the builtin index.
 * @param options - source selection, timeout, and fetch implementation.
 * @returns the resolved catalog with its source label.
 */
export async function loadStoreCatalog(options: StoreCatalogOptions): Promise<StoreCatalog> {
  const { indexUrl } = options
  if (indexUrl === undefined) return { source: 'builtin', entries: BUILTIN_CATALOG }
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(indexUrl, { signal: AbortSignal.timeout(options.fetchTimeoutMs) })
  } catch (error) {
    throw new Error(`plugin-store: failed to fetch catalog index ${indexUrl}: ${String(error)}`)
  }
  if (!response.ok) {
    throw new Error(`plugin-store: catalog index ${indexUrl} returned HTTP ${String(response.status)}`)
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch (error) {
    throw new Error(`plugin-store: catalog index ${indexUrl} is not valid JSON: ${String(error)}`)
  }
  return { source: 'remote', entries: parseCatalogEntries(indexUrl, parsed) }
}

/**
 * Validate one remote catalog document: a top-level JSON array of entries.
 * Every entry needs a registry package `name` and a string `description`;
 * `descriptionZh` falls back to `description`, `author` to the empty string,
 * and `tags` to the empty list.
 * @param indexUrl - the source URL, quoted in every rejection.
 * @param parsed - the parsed JSON document.
 * @returns the validated entries.
 * @throws when the document or any entry violates the schema.
 */
function parseCatalogEntries(indexUrl: string, parsed: unknown): readonly StoreCatalogEntry[] {
  if (!Array.isArray(parsed)) {
    throw new Error(`plugin-store: catalog index ${indexUrl} must be a top-level JSON array of entries`)
  }
  return parsed.map((raw, index) => parseCatalogEntry(indexUrl, index, raw))
}

/** Validate and normalize one catalog entry. */
function parseCatalogEntry(indexUrl: string, index: number, raw: unknown): StoreCatalogEntry {
  const where = `plugin-store: catalog index ${indexUrl} entry ${String(index + 1)}`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} must be an object`)
  }
  const entry = raw as Record<string, unknown>
  if (typeof entry.name !== 'string') throw new Error(`${where} must hold a string "name"`)
  assertCatalogName(where, entry.name)
  if (typeof entry.description !== 'string') throw new Error(`${where} must hold a string "description"`)
  const descriptionZh = entry.descriptionZh === undefined ? entry.description : entry.descriptionZh
  if (typeof descriptionZh !== 'string') throw new Error(`${where} holds a non-string "descriptionZh"`)
  const author = entry.author === undefined ? '' : entry.author
  if (typeof author !== 'string') throw new Error(`${where} holds a non-string "author"`)
  const tags = entry.tags === undefined ? [] : entry.tags
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) {
    throw new Error(`${where} holds a "tags" value that is not an array of strings`)
  }
  return {
    name: entry.name,
    description: entry.description,
    descriptionZh,
    author,
    tags: tags as string[],
  }
}

/** A catalog entry's install target must itself pass the store's name guard. */
function assertCatalogName(where: string, name: string): void {
  try {
    assertRegistryPackageName(name)
  } catch {
    throw new Error(`${where} holds a "name" that is not a registry package name: ${JSON.stringify(name)}`)
  }
}
