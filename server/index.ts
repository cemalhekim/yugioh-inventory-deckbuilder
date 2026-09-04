// Hosted server for the deck builder: serves the built SPA from dist/ and the
// same API the Vite dev server exposes, against a single data directory.
//
//   YGO_DATA_DIR  (default /data)   decks/ + inventory-backup.json live here
//   PORT          (default 3000)
//
// Runs directly under Node >= 22.18 (type stripping), no build step.
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { createApi, type ApiHandler } from './api.ts'

const port = Number(process.env.PORT ?? 3000)
const dataDir = path.resolve(process.env.YGO_DATA_DIR ?? '/data')
const appRoot = path.resolve(import.meta.dirname, '..')
const distDir = path.resolve(process.env.YGO_DIST_DIR ?? path.join(appRoot, 'dist'))
const deckDir = path.join(dataDir, 'decks')

const api = createApi({
  deckDir,
  repoDeckDir: deckDir,
  statePath: path.join(dataDir, 'inventory-backup.json'),
  helperPath: path.join(appRoot, 'tools', 'cardmarket-wants-helper.user.js'),
  simulatorDir: dataDir,
  hosted: true,
})

const routes: Array<[string, ApiHandler]> = [
  ['/api/kaibapro/decks', api.decks],
  ['/api/app-state', api.appState],
  ['/api/ygopro', api.simulator],
  ['/api/host', api.host],
  ['/cardmarket-wants-helper.user.js', api.helper],
]

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
}

async function serveStatic(pathname: string, res: http.ServerResponse) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '')
  let filePath = path.resolve(distDir, relative || 'index.html')
  if (!filePath.startsWith(`${distDir}${path.sep}`) && filePath !== distDir) {
    res.statusCode = 403
    res.end('Forbidden')
    return
  }

  let stat = await fs.stat(filePath).catch(() => null)
  if (!stat || stat.isDirectory()) {
    // SPA fallback: unknown paths get the app shell.
    filePath = path.join(distDir, 'index.html')
    stat = await fs.stat(filePath)
  }

  const ext = path.extname(filePath).toLowerCase()
  res.statusCode = 200
  res.setHeader('Content-Type', mimeTypes[ext] ?? 'application/octet-stream')
  res.setHeader('Content-Length', stat.size)
  // Vite fingerprints everything under assets/; the shell must stay fresh.
  res.setHeader(
    'Cache-Control',
    filePath.includes(`${path.sep}assets${path.sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  )
  res.end(await fs.readFile(filePath))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname

  try {
    if (pathname === '/healthz') {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      res.end('ok')
      return
    }

    for (const [prefix, handler] of routes) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        // Match connect's behaviour: hand the handler a URL relative to the mount.
        const rest = pathname.slice(prefix.length)
        req.url = `${rest || '/'}${url.search}`
        await handler(req, res)
        return
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.end('Method not allowed')
      return
    }
    await serveStatic(pathname, res)
  } catch (error) {
    console.error(error)
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
    }
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Server error' }))
  }
})

await fs.mkdir(deckDir, { recursive: true })
server.listen(port, '0.0.0.0', () => {
  console.log(`ygo deckbuilder listening on :${port}, data in ${dataDir}, dist ${distDir}`)
})
