/**
 * Live profile recomposition: reapply the full patch stack through the root
 * Include without a file watch — the handoff the plugin store uses to apply
 * bundle-layer mutations (install/remove/update) without a restart.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { boot, refreshProfileComposition } from '../src/index.ts'

const NAME = 'dsh-test-bin'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Boot a profile-shaped tree: an empty root config, every row a patch. */
async function bootProfile(basePatches: Parameters<typeof boot>[2]): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-compose-'))
  writeFileSync(join(dir, 'noop.mjs'), [
    'export const name = "noop"',
    'export function apply(_ctx, config = {}) {',
    '  if (config.fail) throw new Error("candidate config failed")',
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const ctx = await boot(NAME, join(dir, 'cordis.yml'), basePatches)
  contexts.push(ctx)
  return ctx
}

function entryIds(ctx: Context): string[] {
  return [...ctx.loader.entries()].map(entry => entry.options.id)
}

describe('refreshProfileComposition', () => {
  it('reapplies a fresh composition to the running tree', async () => {
    const ctx = await bootProfile([
      { insert: [{ id: 'noop', name: './noop.mjs', config: { value: 'base' } }] },
    ])
    expect(entryIds(ctx)).toContain('noop')

    await refreshProfileComposition(ctx, NAME, () => [
      { insert: [{ id: 'noop', name: './noop.mjs', config: { value: 'live' } }] },
      { insert: [{ id: 'added', name: './noop.mjs' }] },
    ])
    const noop = [...ctx.loader.entries()].find(entry => entry.options.id === 'noop')
    expect(noop?.options.config).toMatchObject({ value: 'live' })
    expect(entryIds(ctx)).toContain('added')
  })

  it('disposes entries whose rows leave the composition', async () => {
    const ctx = await bootProfile([
      { insert: [{ id: 'noop', name: './noop.mjs' }, { id: 'second', name: './noop.mjs' }] },
    ])
    expect(entryIds(ctx)).toEqual(expect.arrayContaining(['noop', 'second']))

    await refreshProfileComposition(ctx, NAME, () => [
      { insert: [{ id: 'noop', name: './noop.mjs' }] },
    ])
    expect(entryIds(ctx)).toContain('noop')
    expect(entryIds(ctx)).not.toContain('second')
  })

  it('fails loud when the composition rejects', async () => {
    const ctx = await bootProfile([
      { insert: [{ id: 'noop', name: './noop.mjs' }] },
    ])
    await expect(refreshProfileComposition(ctx, NAME, () => {
      throw new Error('patch exploded')
    })).rejects.toThrow('patch exploded')
    // The previous composition still serves: the failed generation did not
    // touch the running tree.
    expect(entryIds(ctx)).toContain('noop')
  })
})
