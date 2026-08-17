/**
 * Copy the staged dsh backend closure into the packaged resources after the
 * Electron app is assembled. electron-builder's file filter unconditionally
 * skips the root node_modules of every copied resource tree (its
 * createFilter returns false for a top-level "node_modules" entry), so an
 * extraResources entry cannot carry the deployed closure; this hook copies
 * the staging directory wholesale instead, before the installer target reads
 * the appOutDir.
 * @module apps/desktop/after-pack
 */
'use strict'

const { cp } = require('node:fs/promises')
const { join } = require('node:path')

/**
 * The electron-builder afterPack hook.
 * @param context - the electron-builder pack context.
 */
exports.default = async function afterPack(context) {
  const source = join(__dirname, 'backend')
  const destination = join(context.appOutDir, 'resources', 'dsh-backend')
  await cp(source, destination, { recursive: true, dereference: true })
  console.log(`after-pack: staged dsh backend closure at ${destination}`)
}
