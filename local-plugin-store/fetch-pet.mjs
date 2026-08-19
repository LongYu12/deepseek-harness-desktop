// Fetch a Code Pet package from the Petdex gallery into ~/.codex/pets/<slug>,
// the directory code-pet-style plugins (deepseek-pet) load pet packages from.
// Usage: node fetch-pet.mjs [slug]   (default: boba)
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const slug = process.argv[2] ?? 'boba'
const petsDir = join(homedir(), '.codex', 'pets')
const root = join(petsDir, slug)

const manifest = await (await fetch('https://petdex.crafter.run/api/manifest')).json()
const pet = manifest.pets.find((entry) => entry.slug === slug)
if (pet === undefined) throw new Error(`petdex: no pet with slug ${JSON.stringify(slug)}`)

await mkdir(root, { recursive: true })
const [petJson, sprite] = await Promise.all([
  (await fetch(pet.petJsonUrl)).text(),
  (await fetch(pet.spritesheetUrl)).arrayBuffer(),
])
const pkg = JSON.parse(petJson)
// Petdex serves the manifest under its own filename; the pet package format
// expects pet.json whose spritesheetPath names the sheet inside the package.
pkg.spritesheetPath = 'spritesheet.webp'
await writeFile(join(root, 'pet.json'), JSON.stringify(pkg, null, 2))
await writeFile(join(root, 'spritesheet.webp'), Buffer.from(sprite))
console.log(`installed ${pet.displayName} (${slug}, v${pet.spriteVersionNumber}) -> ${root}`)
