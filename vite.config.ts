import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Plugin } from 'vite'

const defaultDeckDir = '/home/ch/Downloads/KaibaPro 2/deck'
const repoDeckDir = path.resolve(process.cwd(), 'decks')
const deckHistoryDir = path.join(repoDeckDir, '.history')
const repoStatePath = path.resolve(process.cwd(), 'data', 'inventory-backup.json')
const cardmarketHelperPath = path.resolve(process.cwd(), 'tools', 'cardmarket-wants-helper.user.js')
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

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function runFirstAvailableFolderPicker(
  candidates: Array<{ command: string; args: string[] }>,
) {
  const errors: string[] = []

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.command, candidate.args)
      return stdout.trim()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        errors.push(candidate.command)
        continue
      }
      throw error
    }
  }

  throw new Error(`No folder picker is available. Install one of: ${errors.join(', ')}.`)
}

async function pickDeckFolder(currentDeckDir: string) {
  if (process.platform === 'linux') {
    return runFirstAvailableFolderPicker([
      {
        command: 'zenity',
        args: [
          '--file-selection',
          '--directory',
          '--title=Select your KaibaPro 2 deck folder',
          `--filename=${currentDeckDir}${path.sep}`,
        ],
      },
      {
        command: 'kdialog',
        args: ['--getexistingdirectory', currentDeckDir, 'Select your KaibaPro 2 deck folder'],
      },
      {
        command: 'yad',
        args: [
          '--file-selection',
          '--directory',
          '--title=Select your KaibaPro 2 deck folder',
          `--filename=${currentDeckDir}${path.sep}`,
        ],
      },
    ])
  }

  if (process.platform === 'darwin') {
    const script = `
set initialPath to POSIX file "${currentDeckDir.replace(/"/g, '\\"')}"
set selectedFolder to choose folder with prompt "Select your KaibaPro 2 deck folder" default location initialPath
POSIX path of selectedFolder
`
    const { stdout } = await execFileAsync('osascript', ['-e', script])
    return stdout.trim()
  }

  if (process.platform !== 'win32') {
    throw new Error(`Folder picker is not supported on ${process.platform}.`)
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

async function listYdkFileNames(deckDir: string) {
  if (!(await pathExists(deckDir))) return []

  const entries = await fs.readdir(deckDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.ydk'))
    .map((entry) => entry.name)
}

async function copyDeckWithTimestamps(sourcePath: string, targetPath: string) {
  const sourceStat = await fs.stat(sourcePath)
  await fs.copyFile(sourcePath, targetPath)
  await fs.utimes(targetPath, sourceStat.atime, sourceStat.mtime)
}

function getDeckHistoryDir(fileName: string) {
  const safeFileName = getSafeDeckPath(repoDeckDir, fileName).fileName
  const deckName = safeFileName.replace(/\.ydk$/i, '')
  const historyPath = path.resolve(deckHistoryDir, deckName)
  const resolvedHistoryDir = path.resolve(deckHistoryDir)

  if (!historyPath.startsWith(`${resolvedHistoryDir}${path.sep}`)) {
    throw new Error('Invalid deck history path.')
  }
  return historyPath
}

function getSafeDeckVersionPath(fileName: string, versionId: string) {
  const safeVersionId = path.basename(versionId)
  if (!/^[a-z0-9_.-]+\.ydk$/i.test(safeVersionId)) {
    throw new Error('Invalid deck version.')
  }

  const historyPath = getDeckHistoryDir(fileName)
  const versionPath = path.resolve(historyPath, safeVersionId)
  if (!versionPath.startsWith(`${historyPath}${path.sep}`)) {
    throw new Error('Invalid deck version path.')
  }
  return versionPath
}

async function listDeckVersions(fileName: string) {
  const historyPath = getDeckHistoryDir(fileName)
  if (!(await pathExists(historyPath))) return []

  const entries = await fs.readdir(historyPath, { withFileTypes: true })
  const versions = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.ydk'))
      .map(async (entry) => {
        const stat = await fs.stat(path.join(historyPath, entry.name))
        const match = entry.name.match(
          /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}\.\d{3}Z)--([a-z-]+)--([a-f0-9]+)\.ydk$/i,
        )

        return {
          id: entry.name,
          createdAt: match ? `${match[1]}:${match[2]}:${match[3]}` : stat.mtime.toISOString(),
          source: match?.[4] ?? 'unknown',
          hash: match?.[5] ?? '',
          size: stat.size,
        }
      }),
  )

  return versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function writeDeckVersion(fileName: string, content: string, source: string) {
  const historyPath = getDeckHistoryDir(fileName)
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 12)
  const versions = await listDeckVersions(fileName)
  if (versions.some((version) => version.hash === hash)) return null

  const latestVersion = versions[0]

  if (latestVersion) {
    const latestContent = await fs.readFile(
      getSafeDeckVersionPath(fileName, latestVersion.id),
      'utf8',
    )
    if (latestContent === content) return null
  }

  await fs.mkdir(historyPath, { recursive: true })
  const timestamp = new Date().toISOString().replace(/:/g, '-')
  const safeSource = source.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  const versionId = `${timestamp}--${safeSource}--${hash}.ydk`
  const versionPath = getSafeDeckVersionPath(fileName, versionId)
  await fs.writeFile(versionPath, content, 'utf8')
  return versionId
}

async function copyDeckAndRecordVersion(
  fileName: string,
  sourcePath: string,
  targetPath: string,
  source: string,
) {
  await copyDeckWithTimestamps(sourcePath, targetPath)
  const content = await fs.readFile(sourcePath, 'utf8')
  await writeDeckVersion(fileName, content, source)
}

async function syncDeckDirectories(kaibaDeckDir: string) {
  await fs.mkdir(kaibaDeckDir, { recursive: true })
  await fs.mkdir(repoDeckDir, { recursive: true })
  await fs.mkdir(deckHistoryDir, { recursive: true })

  const fileNames = new Set([
    ...(await listYdkFileNames(kaibaDeckDir)),
    ...(await listYdkFileNames(repoDeckDir)),
  ])

  let copiedToKaiba = 0
  let copiedToRepo = 0

  for (const fileName of fileNames) {
    const kaibaPath = path.join(kaibaDeckDir, fileName)
    const repoPath = path.join(repoDeckDir, fileName)
    const kaibaExists = await pathExists(kaibaPath)
    const repoExists = await pathExists(repoPath)

    if (kaibaExists && !repoExists) {
      await copyDeckAndRecordVersion(fileName, kaibaPath, repoPath, 'kaibapro-sync')
      copiedToRepo += 1
      continue
    }

    if (!kaibaExists && repoExists) {
      await copyDeckAndRecordVersion(fileName, repoPath, kaibaPath, 'repo-sync')
      copiedToKaiba += 1
      continue
    }

    if (!kaibaExists || !repoExists) continue

    const [kaibaStat, repoStat] = await Promise.all([
      fs.stat(kaibaPath),
      fs.stat(repoPath),
    ])
    const mtimeDelta = kaibaStat.mtimeMs - repoStat.mtimeMs

    if (mtimeDelta > 1000) {
      await copyDeckAndRecordVersion(fileName, kaibaPath, repoPath, 'kaibapro-sync')
      copiedToRepo += 1
    } else if (mtimeDelta < -1000) {
      await copyDeckAndRecordVersion(fileName, repoPath, kaibaPath, 'repo-sync')
      copiedToKaiba += 1
    } else {
      const content = await fs.readFile(repoPath, 'utf8')
      await writeDeckVersion(fileName, content, 'baseline')
    }
  }

  return { copiedToKaiba, copiedToRepo }
}

async function removeDeckIfExists(deckPath: string) {
  try {
    await fs.unlink(deckPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function kaibaProDecksPlugin(): Plugin {
  let deckDir = process.env.KAIBAPRO_DECK_DIR ?? defaultDeckDir

  return {
    name: 'kaibapro-decks-api',
    configureServer(server) {
      server.middlewares.use('/api/kaibapro/decks', async (req, res) => {
        try {
          if (req.method === 'GET' && req.url === '/') {
            const syncResult = await syncDeckDirectories(deckDir)
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
            sendJson(res, 200, { deckDir, repoDeckDir, decks, syncResult })
            return
          }

          if (req.method === 'PUT' && req.url === '/folder') {
            const body = JSON.parse(await readRequestBody(req)) as { deckDir?: string }
            if (typeof body.deckDir !== 'string' || !body.deckDir.trim()) {
              sendJson(res, 400, { error: 'deckDir must be a folder path' })
              return
            }
            deckDir = path.resolve(body.deckDir.trim())
            const syncResult = await syncDeckDirectories(deckDir)
            sendJson(res, 200, { deckDir, repoDeckDir, syncResult })
            return
          }

          if (req.method === 'POST' && req.url === '/select-folder') {
            const selectedDeckDir = await pickDeckFolder(deckDir)
            if (!selectedDeckDir) {
              sendJson(res, 200, { deckDir, canceled: true })
              return
            }
            deckDir = path.resolve(selectedDeckDir)
            const syncResult = await syncDeckDirectories(deckDir)
            sendJson(res, 200, { deckDir, repoDeckDir, syncResult })
            return
          }

          const historyMatch = decodeURIComponent(req.url ?? '').match(
            /^\/([^/]+)\/history(?:\/([^/]+)\/restore)?$/,
          )
          if (historyMatch) {
            await syncDeckDirectories(deckDir)
            const [, fileName, versionId] = historyMatch

            if (req.method === 'GET' && !versionId) {
              sendJson(res, 200, {
                deckDir,
                repoDeckDir,
                fileName: getSafeDeckPath(repoDeckDir, fileName).fileName,
                versions: await listDeckVersions(fileName),
              })
              return
            }

            if (req.method === 'POST' && versionId) {
              const content = await fs.readFile(
                getSafeDeckVersionPath(fileName, versionId),
                'utf8',
              )
              const { deckPath, fileName: safeFileName } = getSafeDeckPath(deckDir, fileName)
              const { deckPath: repoDeckPath } = getSafeDeckPath(repoDeckDir, fileName)
              await Promise.all([
                fs.writeFile(deckPath, content, 'utf8'),
                fs.writeFile(repoDeckPath, content, 'utf8'),
              ])
              await writeDeckVersion(safeFileName, content, 'restore')
              sendJson(res, 200, { deckDir, repoDeckDir, fileName: safeFileName })
              return
            }

            sendJson(res, 405, { error: 'Method not allowed' })
            return
          }

          const match = decodeURIComponent(req.url ?? '').match(/^\/([^/]+)$/)
          if (!match) {
            sendJson(res, 404, { error: 'Not found' })
            return
          }

          await syncDeckDirectories(deckDir)
          const { deckPath, fileName } = getSafeDeckPath(deckDir, match[1])
          const { deckPath: repoDeckPath } = getSafeDeckPath(repoDeckDir, match[1])

          if (req.method === 'GET') {
            const content = await fs.readFile(deckPath, 'utf8')
            sendJson(res, 200, {
              deckDir,
              repoDeckDir,
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
            await Promise.all([
              fs.writeFile(deckPath, body.content, 'utf8'),
              fs.writeFile(repoDeckPath, body.content, 'utf8'),
            ])
            await writeDeckVersion(fileName, body.content, 'save')
            sendJson(res, 200, { deckDir, repoDeckDir, fileName })
            return
          }

          if (req.method === 'DELETE') {
            await Promise.all([
              removeDeckIfExists(deckPath),
              removeDeckIfExists(repoDeckPath),
            ])
            sendJson(res, 200, { deckDir, repoDeckDir, fileName, deleted: true })
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

function cardmarketHelperPlugin(): Plugin {
  return {
    name: 'cardmarket-helper-userscript',
    configureServer(server) {
      server.middlewares.use('/cardmarket-wants-helper.user.js', async (req, res) => {
        try {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'Method not allowed' })
            return
          }

          const content = await fs.readFile(cardmarketHelperPath, 'utf8')
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(content)
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : 'Cardmarket helper failed.',
          })
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    kaibaProDecksPlugin(),
    appStatePlugin(),
    ygoproLauncherPlugin(),
    cardmarketHelperPlugin(),
  ],
})
