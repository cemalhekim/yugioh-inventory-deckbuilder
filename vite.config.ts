import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Plugin } from 'vite'

const defaultDeckDir = '/home/ch/Downloads/KaibaPro 2/deck'
const repoStatePath = path.resolve(process.cwd(), 'data', 'inventory-backup.json')
const ygoproDir = 'C:\\Yu-Gi-Oh! The Dawn of a New Era'
const ygoproLauncher = 'YGOPRO Dawn of a New Era Launcher Pro.exe'
const execFileAsync = promisify(execFile)

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

async function pickDeckFolder(currentDeckDir: string) {
  if (process.platform !== 'win32') {
    throw new Error('Folder picker is only available on Windows. Set KAIBAPRO_DECK_DIR instead.')
  }

  const script = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select your KaibaPro 2 deck folder'
$dialog.ShowNewFolderButton = $true
$initialPath = [Environment]::GetEnvironmentVariable('KAIBAPRO_CURRENT_DECK_DIR')
if ($initialPath -and (Test-Path -LiteralPath $initialPath)) {
  $dialog.SelectedPath = $initialPath
}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-STA',
    '-Command',
    script,
  ], {
    env: { ...process.env, KAIBAPRO_CURRENT_DECK_DIR: currentDeckDir },
  })
  return stdout.trim()
}

function kaibaProDecksPlugin(): Plugin {
  let deckDir = process.env.KAIBAPRO_DECK_DIR ?? defaultDeckDir

  return {
    name: 'kaibapro-decks-api',
    configureServer(server) {
      server.middlewares.use('/api/kaibapro/decks', async (req, res) => {
        try {
          if (req.method === 'GET' && req.url === '/') {
            await fs.mkdir(deckDir, { recursive: true })
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

          if (req.method === 'PUT' && req.url === '/folder') {
            const body = JSON.parse(await readRequestBody(req)) as { deckDir?: string }
            if (typeof body.deckDir !== 'string' || !body.deckDir.trim()) {
              sendJson(res, 400, { error: 'deckDir must be a folder path' })
              return
            }
            deckDir = path.resolve(body.deckDir.trim())
            await fs.mkdir(deckDir, { recursive: true })
            sendJson(res, 200, { deckDir })
            return
          }

          if (req.method === 'POST' && req.url === '/select-folder') {
            const selectedDeckDir = await pickDeckFolder(deckDir)
            if (!selectedDeckDir) {
              sendJson(res, 200, { deckDir, canceled: true })
              return
            }
            deckDir = path.resolve(selectedDeckDir)
            await fs.mkdir(deckDir, { recursive: true })
            sendJson(res, 200, { deckDir })
            return
          }

          const match = decodeURIComponent(req.url ?? '').match(/^\/([^/]+)$/)
          if (!match) {
            sendJson(res, 404, { error: 'Not found' })
            return
          }

          await fs.mkdir(deckDir, { recursive: true })
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

function appStatePlugin(): Plugin {
  return {
    name: 'repo-app-state-api',
    configureServer(server) {
      server.middlewares.use('/api/app-state', async (req, res) => {
        try {
          if (req.method === 'GET') {
            try {
              const content = await fs.readFile(repoStatePath, 'utf8')
              sendJson(res, 200, { state: JSON.parse(content) })
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                sendJson(res, 200, { state: null })
                return
              }
              throw error
            }
            return
          }

          if (req.method === 'PUT') {
            const body = JSON.parse(await readRequestBody(req)) as { state?: unknown }
            if (!body.state || typeof body.state !== 'object') {
              sendJson(res, 400, { error: 'state must be an object' })
              return
            }
            await fs.mkdir(path.dirname(repoStatePath), { recursive: true })
            await fs.writeFile(repoStatePath, `${JSON.stringify(body.state, null, 2)}\n`, 'utf8')
            sendJson(res, 200, { filePath: repoStatePath })
            return
          }

          sendJson(res, 405, { error: 'Method not allowed' })
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : 'App state API failed.',
          })
        }
      })
    },
  }
}

function ygoproLauncherPlugin(): Plugin {
  return {
    name: 'ygopro-launcher-api',
    configureServer(server) {
      server.middlewares.use('/api/ygopro/launch', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Method not allowed' })
            return
          }

          if (process.platform !== 'win32') {
            sendJson(res, 400, { error: 'YGOPRO launch is only available on Windows.' })
            return
          }

          const launcherPath = path.join(ygoproDir, ygoproLauncher)
          await fs.access(launcherPath)

          const child = spawn(launcherPath, [], {
            cwd: ygoproDir,
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
          })
          child.unref()

          sendJson(res, 200, { launched: true, launcherPath })
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : 'YGOPRO launch failed.',
          })
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), kaibaProDecksPlugin(), appStatePlugin(), ygoproLauncherPlugin()],
})
