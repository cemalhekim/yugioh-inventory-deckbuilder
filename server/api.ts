// Shared HTTP API for the deck builder. Used by the Vite dev server
// (vite.config.ts) and by the hosted Node server (server/index.ts).
//
// Handlers are connect-style: they expect req.url to be relative to the
// mount prefix ('/' for the prefix itself), exactly as server.middlewares.use
// hands it over.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'

export type ApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

export type ApiOptions = {
  /** Simulator (KaibaPro) deck directory. Mutable through the API in desktop mode. */
  deckDir: string
  /** Repository deck directory, source of truth; history lives under `.history`. */
  repoDeckDir: string
  /** JSON file holding inventory + deck state. */
  statePath: string
  /** Cardmarket Tampermonkey helper served to the browser. */
  helperPath: string
  /** Simulator application directory for the launcher. */
  simulatorDir: string
  /**
   * Hosted mode (container on the home server): no OS folder pickers, no
   * simulator launch, deck directory pinned to `deckDir`.
   */
  hosted: boolean
}

const deckBranchMetaFile = '.branches.json'
const windowsSimulatorLauncher = 'YGOPRO Dawn of a New Era Launcher Pro.exe'
const execFileAsync = promisify(execFile)

export function createApi(options: ApiOptions) {
  const repoDeckDir = path.resolve(options.repoDeckDir)
  const deckHistoryDir = path.join(repoDeckDir, '.history')
  const repoStatePath = path.resolve(options.statePath)
  const cardmarketHelperPath = path.resolve(options.helperPath)
  const hosted = options.hosted
  let deckDir = path.resolve(options.deckDir)
  let simulatorDir = path.resolve(options.simulatorDir)
  // Content hashes of decks last written by the app's autosave (no history
  // entry). The single-directory sync uses this to tell an autosave apart
  // from an external edit, which does deserve an 'external' snapshot.
  const autosavedHashes = new Map<string, string>()
  const hashContent = (content: string) =>
    createHash('sha256').update(content).digest('hex').slice(0, 12)

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

  async function pickFolder(currentDir: string, title: string) {
    if (process.platform === 'linux') {
      return runFirstAvailableFolderPicker([
        {
          command: 'zenity',
          args: [
            '--file-selection',
            '--directory',
            `--title=${title}`,
            `--filename=${currentDir}${path.sep}`,
          ],
        },
        {
          command: 'kdialog',
          args: ['--getexistingdirectory', currentDir, title],
        },
        {
          command: 'yad',
          args: [
            '--file-selection',
            '--directory',
            `--title=${title}`,
            `--filename=${currentDir}${path.sep}`,
          ],
        },
      ])
    }

    if (process.platform === 'darwin') {
      const script = `
  set initialPath to POSIX file "${currentDir.replace(/"/g, '\\"')}"
  set selectedFolder to choose folder with prompt "${title.replace(/"/g, '\\"')}" default location initialPath
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
  $dialog.Description = [Environment]::GetEnvironmentVariable('CODEX_FOLDER_PICKER_TITLE')
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
      env: {
        ...process.env,
        CODEX_FOLDER_PICKER_TITLE: title,
        KAIBAPRO_CURRENT_DECK_DIR: currentDir,
      },
    })
    return stdout.trim()
  }

  async function pickDeckFolder(currentDeckDir: string) {
    return pickFolder(currentDeckDir, 'Select your KaibaPro 2 deck folder')
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
    const branchMeta = await readDeckBranchMeta(fileName)

    const entries = await fs.readdir(historyPath, { withFileTypes: true })
    const versions = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.ydk'))
        .map(async (entry) => {
          const versionPath = path.join(historyPath, entry.name)
          const [stat, content] = await Promise.all([
            fs.stat(versionPath),
            fs.readFile(versionPath, 'utf8'),
          ])
          const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 12)
          const match = entry.name.match(
            /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}\.\d{3}Z)--([a-z-]+)--([a-f0-9]+)\.ydk$/i,
          )

          return {
            id: entry.name,
            createdAt: match ? `${match[1]}:${match[2]}:${match[3]}` : stat.mtime.toISOString(),
            source: match?.[4] ?? 'unknown',
            hash: match?.[5] ?? '',
            contentHash,
            size: stat.size,
            branchName: branchMeta[entry.name]?.branchName ?? '',
            parentId: branchMeta[entry.name]?.parentId ?? '',
            note: branchMeta[entry.name]?.note ?? '',
          }
        }),
    )

    return versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async function readDeckBranchMeta(fileName: string) {
    const metaPath = path.join(getDeckHistoryDir(fileName), deckBranchMetaFile)
    try {
      return JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<
        string,
        { branchName?: string; parentId?: string; note?: string }
      >
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  async function writeDeckBranchMeta(
    fileName: string,
    meta: Record<string, { branchName?: string; parentId?: string; note?: string }>,
  ) {
    const historyPath = getDeckHistoryDir(fileName)
    await fs.mkdir(historyPath, { recursive: true })
    await fs.writeFile(
      path.join(historyPath, deckBranchMetaFile),
      `${JSON.stringify(meta, null, 2)}\n`,
      'utf8',
    )
  }

  async function writeDeckVersion(fileName: string, content: string, source: string, note = '') {
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
    if (note.trim()) {
      const meta = await readDeckBranchMeta(fileName)
      meta[versionId] = { ...meta[versionId], note: note.trim() }
      await writeDeckBranchMeta(fileName, meta)
    }
    return versionId
  }

  async function writeDeckBranch(
    fileName: string,
    content: string,
    branchName: string,
    parentId = '',
    note = '',
  ) {
    const cleanBranchName = branchName.trim()
    if (!cleanBranchName) throw new Error('Branch name is required.')

    const historyPath = getDeckHistoryDir(fileName)
    await fs.mkdir(historyPath, { recursive: true })
    const hash = createHash('sha256')
      .update(`${cleanBranchName}\n${content}`)
      .digest('hex')
      .slice(0, 12)
    const timestamp = new Date().toISOString().replace(/:/g, '-')
    const versionId = `${timestamp}--branch--${hash}.ydk`
    const versionPath = getSafeDeckVersionPath(fileName, versionId)
    await fs.writeFile(versionPath, content, 'utf8')

    const meta = await readDeckBranchMeta(fileName)
    meta[versionId] = {
      branchName: cleanBranchName,
      parentId,
      ...(note.trim() ? { note: note.trim() } : {}),
    }
    await writeDeckBranchMeta(fileName, meta)
    return versionId
  }

  async function updateDeckVersionNote(fileName: string, versionId: string, note: string) {
    getSafeDeckVersionPath(fileName, versionId)
    const meta = await readDeckBranchMeta(fileName)
    meta[versionId] = {
      ...meta[versionId],
      note: note.trim(),
    }
    await writeDeckBranchMeta(fileName, meta)
  }

  async function deleteDeckVersionsFrom(fileName: string, versionId: string) {
    getSafeDeckVersionPath(fileName, versionId)
    const versions = await listDeckVersions(fileName)
    const targetVersion = versions.find((version) => version.id === versionId)
    if (!targetVersion) throw new Error('Deck version not found.')

    const deletedIds = versions
      .filter((version) => version.createdAt >= targetVersion.createdAt)
      .map((version) => version.id)
    const deletedIdSet = new Set(deletedIds)

    await Promise.all(
      deletedIds.map((deletedId) =>
        fs.rm(getSafeDeckVersionPath(fileName, deletedId), { force: true }),
      ),
    )

    const meta = await readDeckBranchMeta(fileName)
    for (const [metaVersionId, value] of Object.entries(meta)) {
      if (deletedIdSet.has(metaVersionId) || deletedIdSet.has(value.parentId ?? '')) {
        delete meta[metaVersionId]
      }
    }
    await writeDeckBranchMeta(fileName, meta)

    return deletedIds
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

    if (path.resolve(kaibaDeckDir) === repoDeckDir) {
      // Hosted mode: a single directory, nothing to mirror. Still record a
      // snapshot for decks edited outside the app (Nextcloud, KaibaPro sync).
      for (const fileName of await listYdkFileNames(repoDeckDir)) {
        const content = await fs.readFile(path.join(repoDeckDir, fileName), 'utf8')
        if (autosavedHashes.get(fileName) === hashContent(content)) continue
        await writeDeckVersion(fileName, content, 'external')
      }
      return { copiedToKaiba: 0, copiedToRepo: 0 }
    }

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
        await copyDeckAndRecordVersion(fileName, kaibaPath, repoPath, 'simulator-import')
        copiedToRepo += 1
        continue
      }

      if (!kaibaExists && repoExists) {
        await copyDeckAndRecordVersion(fileName, repoPath, kaibaPath, 'repo-sync')
        copiedToKaiba += 1
        continue
      }

      if (!kaibaExists || !repoExists) continue

      const [kaibaContent, repoContent] = await Promise.all([
        fs.readFile(kaibaPath, 'utf8'),
        fs.readFile(repoPath, 'utf8'),
      ])

      if (kaibaContent !== repoContent) {
        await copyDeckAndRecordVersion(fileName, repoPath, kaibaPath, 'repo-sync')
        copiedToKaiba += 1
      } else {
        await writeDeckVersion(fileName, repoContent, 'baseline')
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

  async function listFilesRecursive(rootDir: string, depth = 2): Promise<string[]> {
    if (depth < 0 || !(await pathExists(rootDir))) return []

    const entries = await fs.readdir(rootDir, { withFileTypes: true })
    const files = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(rootDir, entry.name)
        if (entry.isDirectory()) return listFilesRecursive(entryPath, depth - 1)
        if (entry.isFile()) return [entryPath]
        return []
      }),
    )
    return files.flat()
  }

  async function findSimulatorLauncher(appDir: string) {
    const resolvedAppDir = path.resolve(appDir)
    await fs.access(resolvedAppDir)

    const files = await listFilesRecursive(resolvedAppDir)
    const lowerPriorityName = (filePath: string) => {
      const baseName = path.basename(filePath).toLowerCase()
      if (baseName.includes('launcher')) return 0
      if (baseName.includes('ygopro') || baseName.includes('kaiba')) return 1
      return 2
    }

    if (process.platform === 'win32') {
      const knownPath = path.join(resolvedAppDir, windowsSimulatorLauncher)
      if (await pathExists(knownPath)) return knownPath

      const candidates = files
        .filter((filePath) => filePath.toLowerCase().endsWith('.exe'))
        .sort((a, b) => lowerPriorityName(a) - lowerPriorityName(b))
      if (candidates[0]) return candidates[0]
      throw new Error('No Windows .exe launcher was found in the selected simulator folder.')
    }

    if (process.platform === 'linux') {
      const candidates = await Promise.all(
        files.map(async (filePath) => {
          const stat = await fs.stat(filePath)
          const lowerName = filePath.toLowerCase()
          const executable = Boolean(stat.mode & 0o111)
          const runnable =
            lowerName.endsWith('.appimage') ||
            lowerName.endsWith('.sh') ||
            executable
          return runnable ? filePath : ''
        }),
      )
      const launcherPath = candidates
        .filter(Boolean)
        .sort((a, b) => lowerPriorityName(a) - lowerPriorityName(b))[0]
      if (launcherPath) return launcherPath
      throw new Error('No Linux runnable file was found in the selected simulator folder.')
    }

    if (process.platform === 'darwin') {
      const appBundle = files.find((filePath) => filePath.includes('.app/'))
      if (appBundle) return appBundle.slice(0, appBundle.indexOf('.app/') + 4)
      throw new Error('No macOS .app bundle was found in the selected simulator folder.')
    }

    throw new Error(`Simulator launch is not supported on ${process.platform}.`)
  }

  function spawnSimulator(launcherPath: string) {
    const cwd = launcherPath.endsWith('.app') ? path.dirname(launcherPath) : path.dirname(launcherPath)

    if (process.platform === 'darwin' && launcherPath.endsWith('.app')) {
      const child = spawn('open', [launcherPath], {
        cwd,
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      return
    }

    const command = process.platform === 'linux' && launcherPath.toLowerCase().endsWith('.sh')
      ? 'bash'
      : launcherPath
    const args = command === 'bash' ? [launcherPath] : []
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.unref()
  }


  const decks: ApiHandler = async (req, res) => {
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
          // Hosted: the deck directory is the mounted volume, browsers cannot move it.
          if (!hosted) deckDir = path.resolve(body.deckDir.trim())
          const syncResult = await syncDeckDirectories(deckDir)
          sendJson(res, 200, { deckDir, repoDeckDir, syncResult })
          return
        }

        if (req.method === 'POST' && req.url === '/select-folder') {
          if (hosted) {
            sendJson(res, 501, { error: 'Folder selection is not available on the hosted server.' })
            return
          }
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

        const versionActionMatch = decodeURIComponent(req.url ?? '').match(
          /^\/([^/]+)\/history\/([^/]+)\/(branch|notes)$/,
        )
        if (versionActionMatch) {
          await syncDeckDirectories(deckDir)
          const [, fileName, versionId, action] = versionActionMatch

          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Method not allowed' })
            return
          }

          const body = JSON.parse(await readRequestBody(req)) as {
            branchName?: string
            note?: string
          }

          if (action === 'branch') {
            if (typeof body.branchName !== 'string' || !body.branchName.trim()) {
              sendJson(res, 400, { error: 'branchName is required' })
              return
            }
            const content = await fs.readFile(
              getSafeDeckVersionPath(fileName, versionId),
              'utf8',
            )
            const safeFileName = getSafeDeckPath(repoDeckDir, fileName).fileName
            const branchVersionId = await writeDeckBranch(
              safeFileName,
              content,
              body.branchName,
              versionId,
            )
            sendJson(res, 200, {
              deckDir,
              repoDeckDir,
              fileName: safeFileName,
              branchName: body.branchName.trim(),
              versionId: branchVersionId,
              versions: await listDeckVersions(safeFileName),
            })
            return
          }

          if (typeof body.note !== 'string') {
            sendJson(res, 400, { error: 'note is required' })
            return
          }
          const safeFileName = getSafeDeckPath(repoDeckDir, fileName).fileName
          await updateDeckVersionNote(safeFileName, versionId, body.note)
          sendJson(res, 200, {
            deckDir,
            repoDeckDir,
            fileName: safeFileName,
            versions: await listDeckVersions(safeFileName),
          })
          return
        }

        const versionDeleteMatch = decodeURIComponent(req.url ?? '').match(
          /^\/([^/]+)\/history\/([^/]+)$/,
        )
        if (versionDeleteMatch) {
          await syncDeckDirectories(deckDir)
          const [, fileName, versionId] = versionDeleteMatch

          if (req.method !== 'DELETE') {
            sendJson(res, 405, { error: 'Method not allowed' })
            return
          }

          const safeFileName = getSafeDeckPath(repoDeckDir, fileName).fileName
          const deletedIds = await deleteDeckVersionsFrom(safeFileName, versionId)
          sendJson(res, 200, {
            deckDir,
            repoDeckDir,
            fileName: safeFileName,
            deletedIds,
            versions: await listDeckVersions(safeFileName),
          })
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

        const branchMatch = decodeURIComponent(req.url ?? '').match(/^\/([^/]+)\/branches$/)
        if (branchMatch) {
          await syncDeckDirectories(deckDir)
          const [, requestedFileName] = branchMatch
          const { deckPath, fileName } = getSafeDeckPath(deckDir, requestedFileName)

          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Method not allowed' })
            return
          }

          const body = JSON.parse(await readRequestBody(req)) as { branchName?: string }
          if (typeof body.branchName !== 'string' || !body.branchName.trim()) {
            sendJson(res, 400, { error: 'branchName is required' })
            return
          }

          const content = await fs.readFile(deckPath, 'utf8')
          const versionId = await writeDeckBranch(fileName, content, body.branchName)
          sendJson(res, 200, {
            deckDir,
            repoDeckDir,
            fileName,
            branchName: body.branchName.trim(),
            versionId,
            versions: await listDeckVersions(fileName),
          })
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
          const body = JSON.parse(await readRequestBody(req)) as {
            branchName?: string
            checkpoint?: boolean
            content?: string
            note?: string
            parentId?: string
          }
          if (typeof body.content !== 'string') {
            sendJson(res, 400, { error: 'content must be a string' })
            return
          }
          await Promise.all([
            fs.writeFile(deckPath, body.content, 'utf8'),
            fs.writeFile(repoDeckPath, body.content, 'utf8'),
          ])
          if (body.checkpoint === false) {
            // Autosave: the file is current, history is left alone.
            autosavedHashes.set(fileName, hashContent(body.content))
            sendJson(res, 200, { deckDir, repoDeckDir, fileName, checkpoint: false })
            return
          }
          autosavedHashes.delete(fileName)
          if (typeof body.branchName === 'string' && body.branchName.trim()) {
            await writeDeckBranch(
              fileName,
              body.content,
              body.branchName,
              typeof body.parentId === 'string' ? body.parentId : '',
              typeof body.note === 'string' ? body.note : '',
            )
          } else {
            await writeDeckVersion(
              fileName,
              body.content,
              'save',
              typeof body.note === 'string' ? body.note : '',
            )
          }
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
  }

  const appState: ApiHandler = async (req, res) => {
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
  }

  const simulator: ApiHandler = async (req, res) => {
      if (hosted) {
        sendJson(res, 501, { error: 'The simulator runs on your desktop, not on the hosted server.' })
        return
      }
      try {
        if (req.method === 'PUT' && req.url === '/folder') {
          const body = JSON.parse(await readRequestBody(req)) as { appDir?: string }
          if (typeof body.appDir !== 'string' || !body.appDir.trim()) {
            sendJson(res, 400, { error: 'appDir must be a folder path' })
            return
          }
          simulatorDir = path.resolve(body.appDir.trim())
          const launcherPath = await findSimulatorLauncher(simulatorDir)
          sendJson(res, 200, { appDir: simulatorDir, launcherPath })
          return
        }

        if (req.method === 'POST' && req.url === '/select-folder') {
          const selectedDir = await pickFolder(
            simulatorDir,
            'Select the simulator application folder',
          )
          if (!selectedDir) {
            sendJson(res, 200, { appDir: simulatorDir, canceled: true })
            return
          }

          simulatorDir = path.resolve(selectedDir)
          const launcherPath = await findSimulatorLauncher(simulatorDir)
          sendJson(res, 200, { appDir: simulatorDir, launcherPath })
          return
        }

        if (req.method === 'POST' && req.url === '/launch') {
          const bodyText = await readRequestBody(req)
          const body = bodyText ? JSON.parse(bodyText) as { appDir?: string } : {}
          if (body.appDir?.trim()) simulatorDir = path.resolve(body.appDir.trim())

          const launcherPath = await findSimulatorLauncher(simulatorDir)
          spawnSimulator(launcherPath)
          sendJson(res, 200, { appDir: simulatorDir, launched: true, launcherPath })
          return
        }

        sendJson(res, 404, { error: 'Not found' })
      } catch (error) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : 'Simulator launch failed.',
        })
      }
  }

  const helper: ApiHandler = async (req, res) => {
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
  }

  const host: ApiHandler = async (_req, res) => {
    sendJson(res, 200, { hosted, deckDir, repoDeckDir: hosted ? '' : repoDeckDir })
  }

  return { decks, appState, simulator, helper, host }
}
