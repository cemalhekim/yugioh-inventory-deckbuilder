import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from 'vite'

const defaultDeckDir = '/home/ch/Downloads/KaibaPro 2/deck'

function sendJson(res: import('node:http').ServerResponse, status: number, data: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

async function readRequestBody(req: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function getSafeDeckPath(deckDir: string, fileName: string) {
  const normalizedName = path.basename(fileName).replace(/\.ydk$/i, '')
  const safeName = normalizedName.replace(/[^a-z0-9 _.-]/gi, '').trim()
  if (!safeName) throw new Error('Deck name is required.')

  const deckPath = path.resolve(deckDir, `${safeName}.ydk`)
  const resolvedDeckDir = path.resolve(deckDir)
  if (!deckPath.startsWith(`${resolvedDeckDir}${path.sep}`)) {
    throw new Error('Invalid deck path.')
  }
  return { deckPath, fileName: path.basename(deckPath) }
}

function kaibaProDecksPlugin(): Plugin {
  const deckDir = process.env.KAIBAPRO_DECK_DIR ?? defaultDeckDir

  return {
    name: 'kaibapro-decks-api',
    configureServer(server) {
      server.middlewares.use('/api/kaibapro/decks', async (req, res) => {
        try {
          await fs.mkdir(deckDir, { recursive: true })

          if (req.method === 'GET' && req.url === '/') {
            const entries = await fs.readdir(deckDir, { withFileTypes: true })
            const decks = await Promise.all(
              entries
                .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.ydk'))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(async (entry) => {
                  const stat = await fs.stat(path.join(deckDir, entry.name))
                  return {
                    fileName: entry.name,
                    name: entry.name.replace(/\.ydk$/i, ''),
                    updatedAt: stat.mtime.toISOString(),
                    size: stat.size,
                  }
                }),
            )
            sendJson(res, 200, { deckDir, decks })
            return
          }

          const match = decodeURIComponent(req.url ?? '').match(/^\/([^/]+)$/)
          if (!match) {
            sendJson(res, 404, { error: 'Not found' })
            return
          }

          const { deckPath, fileName } = getSafeDeckPath(deckDir, match[1])

          if (req.method === 'GET') {
            const content = await fs.readFile(deckPath, 'utf8')
            sendJson(res, 200, {
              deckDir,
              fileName,
              name: fileName.replace(/\.ydk$/i, ''),
              content,
            })
            return
          }

          if (req.method === 'PUT') {
            const body = JSON.parse(await readRequestBody(req)) as { content?: string }
            if (typeof body.content !== 'string') {
              sendJson(res, 400, { error: 'content must be a string' })
              return
            }
            await fs.writeFile(deckPath, body.content, 'utf8')
            sendJson(res, 200, { deckDir, fileName })
            return
          }

          sendJson(res, 405, { error: 'Method not allowed' })
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : 'KaibaPro deck API failed.',
          })
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), kaibaProDecksPlugin()],
})
