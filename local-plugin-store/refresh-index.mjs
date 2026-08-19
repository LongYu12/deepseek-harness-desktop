// Refresh the local plugin-store index from GitHub community plugins.
// Pipeline per candidate repo:
//   1. GitHub search for topic:dsh-plugin (and a narrower cordis.yml query).
//   2. Fetch the repo's package.json; the store only installs bare npm
//      registry names, so repos without one are skipped.
//   3. Verify the package actually exists on the npm registry — the store's
//      install runs `pnpm add <name>`, so a name nobody published would fail.
//   4. Merge surviving entries into index.json (existing entries kept, deduped
//      by name), keeping the builtin official bundles first.
// GitHub API search is rate-limited (10 req/min unauthenticated); reruns are
// safe since the index file keeps prior entries.
import { writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const indexFile = path.join(dir, 'index.json')
const GH = 'https://api.github.com'
const UA = { 'User-Agent': 'dsh-store-refresh', 'Accept': 'application/vnd.github+json' }

/** Bare npm registry package name — mirrors the store's own allowlist. */
const REGISTRY_PACKAGE_NAME = /^@?[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)?$/

async function searchRepos(query) {
  const url = `${GH}/search/repositories?q=${encodeURIComponent(query)}&per_page=30&sort=updated`
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15_000) })
  if (res.status === 403 || res.status === 429) {
    throw new Error(`GitHub rate limit hit (HTTP ${res.status}) — wait a minute and rerun`)
  }
  if (!res.ok) throw new Error(`GitHub search failed: HTTP ${res.status}`)
  return (await res.json()).items ?? []
}

async function fetchPackageJson(repo) {
  const raw = `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/package.json`
  const res = await fetch(raw, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) return undefined // no package.json on the default branch
  try {
    return await res.json()
  } catch {
    return undefined // not valid JSON
  }
}

/** npm registry existence check: 200 with a publishable latest means installable, 404 means unpublished. */
async function existsOnRegistry(name) {
  const encoded = name.startsWith('@') ? name.replace('/', '%2F') : name
  const res = await fetch(`https://registry.npmjs.org/${encoded}`, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) {
    if (res.status === 404) return false
    throw new Error(`npm registry check for ${name} failed: HTTP ${res.status}`)
  }
  // HTTP 200 alone is not enough: a package whose versions were all
  // unpublished carries no dist-tags, and `pnpm add` fails on it with
  // ERR_PNPM_MALFORMED_METADATA. The store installs `latest`, so a missing
  // latest tag means the package is not installable either.
  const doc = await res.json()
  if (doc?.['dist-tags']?.latest === undefined) return false
  if (doc.versions?.[doc['dist-tags'].latest] === undefined) return false
  return true
}

const current = JSON.parse(await readFile(indexFile, 'utf8'))
const known = new Set(current.map(entry => entry.name))
const added = []
const skipped = []

for (const repo of [...(await searchRepos('topic:dsh-plugin')), ...(await searchRepos('"cordis.yml" "deepseek-harness"'))]) {
  if (known.has(repo.full_name)) continue
  if (repo.owner?.login === 'deepseek-ai') continue // official org ships its own catalog
  const pkg = await fetchPackageJson(repo)
  if (pkg === undefined || typeof pkg.name !== 'string' || !REGISTRY_PACKAGE_NAME.test(pkg.name)) {
    skipped.push({ repo: repo.full_name, reason: 'no valid registry package name' })
    continue
  }
  let published
  try {
    published = await existsOnRegistry(pkg.name)
  } catch (error) {
    skipped.push({ repo: repo.full_name, reason: String(error) })
    continue
  }
  if (!published) {
    skipped.push({ repo: repo.full_name, name: pkg.name, reason: 'not published on npm' })
    continue
  }
  const description = repo.description ?? pkg.description ?? ''
  current.push({
    name: pkg.name,
    description,
    descriptionZh: description,
    author: repo.owner.login,
    tags: [...(repo.topics ?? []).filter(tag => tag !== 'dsh-plugin').slice(0, 4), 'community'],
  })
  known.add(pkg.name)
  added.push(pkg.name)
}

await writeFile(indexFile, JSON.stringify(current, null, 2) + '\n', 'utf8')
console.log(`index: ${current.length} entries (${added.length} added)`)
for (const name of added) console.log('+', name)
for (const item of skipped) console.log(`- ${item.repo}: ${item.reason}`)
