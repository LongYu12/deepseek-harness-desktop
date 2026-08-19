// Local plugin-store index server: serves index.json over http for the
// desktop app's store catalog (indexUrl). No dependencies.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const port = 8787

// Step aside when another instance (a manual launcher, or a previous desktop
// session) already owns the port: both must never fight over one index.
const portInUse = await new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port })
  socket.once('connect', () => {
    socket.destroy()
    resolve(true)
  })
  socket.once('error', () => resolve(false))
})
if (portInUse) {
  console.log(`port ${port} already serves the store — exiting`)
  process.exit(0)
}

const server = createServer(async (_req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Access-Control-Allow-Origin', '*')
  try {
    res.end(await readFile(path.join(dir, 'index.json')))
  } catch (error) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: String(error) }))
  }
})
server.on('error', (error) => {
  console.error(`failed to listen on ${port}: ${String(error)}`)
  process.exit(1)
})
server.listen(port, '127.0.0.1', () => {
  console.log(`plugin store index: http://127.0.0.1:${port}/`)
})
