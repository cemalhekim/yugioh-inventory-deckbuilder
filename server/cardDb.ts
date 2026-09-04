// Local YGOPRODeck mirror: one card dump on disk, served to the browser as
// `/api/cards`, plus an on-demand image cache served as `/api/images`.
//
// Why: YGOPRODeck allows at most 20 requests/s per IP (an hour-long ban above
// that) and forbids hotlinking card images. Opening a 60-card deck used to be
// 60 parallel cardinfo.php calls and every tile hotlinked images.ygoprodeck.com.
// Now the browser only ever talks to this server; upstream sees one dump
// download per database version and at most ~3 image fetches per second.
//
//   GET /api/cards?ids=1,2,3        cards by passcode (alt-art ids resolve to
//                                   the canonical card, see `aliases`)
//   GET /api/cards?names=a|b        cards by exact name (case-insensitive)
//   GET /api/cards?q=blue-eyes      fuzzy name search, `total` + first 500
//   GET /api/cards?set=Set Name     every card printed in a set
//   GET /api/cards/sets             cardsets.php mirror
//   GET /api/cards/status           version, count, source
//   GET /api/images/<id>/<kind>     kind: small | full | cropped, cached on disk
//
// Until the dump has been downloaded (first start, or offline) the same
// queries are proxied upstream as single batched requests, so the app works
// from the first second and still stays within the API rules.
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import type { ServerResponse } from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { ApiHandler } from './api.ts'

const upstreamApi = 'https://db.ygoprodeck.com/api/v7'
const upstreamImages = 'https://images.ygoprodeck.com/images'
const imageKinds = { small: 'cards_small', full: 'cards', cropped: 'cards_cropped' } as const
type ImageKind = keyof typeof imageKinds

/** Minimum gap between two upstream requests: 3/s, well under the 20/s limit. */
const upstreamMinIntervalMs = 350
/** Re-check `checkDBVer.php` this often while the server runs. */
const versionCheckIntervalMs = 24 * 60 * 60 * 1000
const searchLimit = 500
const maxIdsPerQuery = 500

export type CardDbOptions = {
  /** Where cards.json, cardsets.json and images/ live. */
  cacheDir: string
  /** Absolute URL prefix the browser uses for images, default `/api/images`. */
  imageBasePath?: string
  log?: (message: string) => void
}

type CardImage = {
  id: number
  image_url: string
  image_url_small: string
  image_url_cropped?: string
}

type Card = {
  id: number
  name: string
  card_images?: CardImage[]
  card_sets?: { set_name: string; set_code: string; set_rarity?: string; set_price?: string }[]
  [key: string]: unknown
}

type Dump = {
  version: string
  lastUpdate: string
  fetchedAt: string
  data: Card[]
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

async function writeFileAtomic(filePath: string, content: string | Buffer) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmpPath, content)
  await fs.rename(tmpPath, filePath)
}

function normalizeName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function createCardDb(options: CardDbOptions) {
  const cacheDir = path.resolve(options.cacheDir)
  const dumpPath = path.join(cacheDir, 'cards.json')
  const setsPath = path.join(cacheDir, 'cardsets.json')
  const imagesDir = path.join(cacheDir, 'images')
  const imageBasePath = (options.imageBasePath ?? '/api/images').replace(/\/$/, '')
  const log = options.log ?? ((message: string) => console.log(`${new Date().toISOString()} carddb ${message}`))

  // ---- upstream throttle -------------------------------------------------
  let upstreamChain: Promise<unknown> = Promise.resolve()
  let lastUpstreamAt = 0
  function throttled<T>(task: () => Promise<T>): Promise<T> {
    const run = upstreamChain.then(async () => {
      const wait = lastUpstreamAt + upstreamMinIntervalMs - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      lastUpstreamAt = Date.now()
      return task()
    })
    upstreamChain = run.catch(() => undefined)
    return run
  }

  async function fetchUpstream(url: string, init?: RequestInit) {
    return throttled(() =>
      fetch(url, {
        ...init,
        headers: { 'User-Agent': 'yugioh-inventory-deckbuilder (self-hosted)', ...init?.headers },
        signal: AbortSignal.timeout(60_000),
      }),
    )
  }

  // ---- in-memory index ---------------------------------------------------
  let dump: Dump | null = null
  let byId = new Map<number, Card>()
  let aliasToId = new Map<number, number>()
  let byName = new Map<string, Card>()
  let bySet: Map<string, Card[]> | null = null

  /** Rewrite upstream image URLs to this server and drop the fields nobody renders. */
  function localizeCard(raw: Card): Card {
    const card: Card = { ...raw }
    delete card.card_prices
    delete card.ygoprodeck_url
    const images = (raw.card_images ?? []).map((image) => {
      const id = Number(image.id) || Number(String(image.image_url).match(/(\d+)\.jpg$/)?.[1]) || raw.id
      return {
        id,
        image_url: `${imageBasePath}/${id}/full`,
        image_url_small: `${imageBasePath}/${id}/small`,
        image_url_cropped: `${imageBasePath}/${id}/cropped`,
      }
    })
    return { ...card, card_images: images }
  }

  function index(next: Dump) {
    const nextById = new Map<number, Card>()
    const nextAlias = new Map<number, number>()
    const nextByName = new Map<string, Card>()
    const data = next.data.map(localizeCard)
    for (const card of data) {
      nextById.set(card.id, card)
      // Alternate artworks are separate entries with the same name; the
      // canonical printing comes first in the dump, keep that one.
      const key = normalizeName(card.name)
      if (!nextByName.has(key)) nextByName.set(key, card)
      for (const image of card.card_images ?? []) {
        if (image.id !== card.id) nextAlias.set(image.id, card.id)
      }
    }
    dump = { ...next, data }
    byId = nextById
    aliasToId = nextAlias
    byName = nextByName
    bySet = null
  }

  function resolve(id: number) {
    return byId.get(id) ?? byId.get(aliasToId.get(id) ?? -1)
  }

  function getBySet() {
    if (bySet) return bySet
    bySet = new Map()
    for (const card of byId.values()) {
      for (const set of card.card_sets ?? []) {
        const list = bySet.get(set.set_name) ?? []
        if (!list.includes(card)) list.push(card)
        bySet.set(set.set_name, list)
      }
    }
    return bySet
  }

  // ---- dump lifecycle ----------------------------------------------------
  async function loadFromDisk() {
    try {
      const parsed = JSON.parse(await fs.readFile(dumpPath, 'utf8')) as Dump
      if (!Array.isArray(parsed.data)) throw new Error('cards.json has no data array')
      index(parsed)
      log(`loaded ${byId.size} cards, db ${parsed.version} (${parsed.lastUpdate}) from disk`)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`cards.json unreadable: ${String(error)}`)
      return false
    }
  }

  async function fetchVersion() {
    const response = await fetchUpstream(`${upstreamApi}/checkDBVer.php`)
    if (!response.ok) throw new Error(`checkDBVer ${response.status}`)
    const [info] = (await response.json()) as { database_version: string; last_update: string }[]
    return { version: String(info.database_version), lastUpdate: String(info.last_update) }
  }

  let refreshing: Promise<void> | null = null
  async function refresh(force = false) {
    if (refreshing) return refreshing
    refreshing = (async () => {
      const remote = await fetchVersion()
      if (!force && dump && dump.version === remote.version) {
        log(`db ${remote.version} unchanged`)
        return
      }
      log(`downloading card dump ${remote.version} (${remote.lastUpdate})`)
      const startedAt = Date.now()
      const response = await fetchUpstream(`${upstreamApi}/cardinfo.php?misc=yes`)
      if (!response.ok) throw new Error(`cardinfo dump ${response.status}`)
      const payload = (await response.json()) as { data: Card[] }
      const next: Dump = {
        version: remote.version,
        lastUpdate: remote.lastUpdate,
        fetchedAt: new Date().toISOString(),
        data: payload.data,
      }
      await writeFileAtomic(dumpPath, JSON.stringify(next))
      index(next)
      log(`dump ready: ${byId.size} cards in ${Date.now() - startedAt}ms`)

      const setsResponse = await fetchUpstream(`${upstreamApi}/cardsets.php`)
      if (setsResponse.ok) await writeFileAtomic(setsPath, Buffer.from(await setsResponse.arrayBuffer()))
    })().finally(() => {
      refreshing = null
    })
    return refreshing
  }

  let timer: NodeJS.Timeout | null = null
  /** Load the disk copy, then check upstream in the background. Never throws. */
  async function start() {
    await fs.mkdir(imagesDir, { recursive: true })
    await loadFromDisk()
    const tick = () =>
      refresh().catch((error) => {
        const cause = (error as { cause?: unknown }).cause
        log(`refresh failed: ${String(error)}${cause ? ` (${String(cause)})` : ''}`)
      })
    void tick()
    timer = setInterval(tick, versionCheckIntervalMs)
    timer.unref()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  // ---- queries (local first, upstream fallback) --------------------------
  async function upstreamCards(params: Record<string, string>): Promise<Card[]> {
    const url = `${upstreamApi}/cardinfo.php?${new URLSearchParams(params)}`
    const response = await fetchUpstream(url)
    // YGOPRODeck answers "no match" with a 400 and an error object.
    if (response.status === 400) return []
    if (!response.ok) throw new Error(`YGOPRODeck ${response.status}`)
    const payload = (await response.json()) as { data?: Card[] }
    return (payload.data ?? []).map(localizeCard)
  }

  async function cardsByIds(ids: number[]) {
    const unique = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)))
    const found: Card[] = []
    const aliases: Record<number, number> = {}
    const missing: number[] = []
    if (dump) {
      for (const id of unique) {
        const card = resolve(id)
        if (!card) missing.push(id)
        else {
          if (!found.includes(card)) found.push(card)
          if (card.id !== id) aliases[id] = card.id
        }
      }
      return { data: found, aliases, missing }
    }
    for (let start = 0; start < unique.length; start += 100) {
      const chunk = unique.slice(start, start + 100)
      const cards = await upstreamCards({ id: chunk.join(',') })
      const chunkById = new Map<number, Card>()
      for (const card of cards) {
        chunkById.set(card.id, card)
        for (const image of card.card_images ?? []) chunkById.set(image.id, card)
      }
      for (const id of chunk) {
        const card = chunkById.get(id)
        if (!card) missing.push(id)
        else {
          if (!found.includes(card)) found.push(card)
          if (card.id !== id) aliases[id] = card.id
        }
      }
    }
    return { data: found, aliases, missing }
  }

  async function cardsByNames(names: string[]) {
    const unique = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)))
    const found: Record<string, Card> = {}
    const missing: string[] = []
    if (dump) {
      for (const name of unique) {
        const card = byName.get(normalizeName(name))
        if (card) found[name] = card
        else missing.push(name)
      }
      return { found, missing }
    }
    for (let start = 0; start < unique.length; start += 50) {
      const chunk = unique.slice(start, start + 50)
      const cards = await upstreamCards({ name: chunk.join('|') })
      const chunkByName = new Map(cards.map((card) => [normalizeName(card.name), card]))
      for (const name of chunk) {
        const card = chunkByName.get(normalizeName(name))
        if (card) found[name] = card
        else missing.push(name)
      }
    }
    return { found, missing }
  }

  async function search(query: string) {
    const needle = normalizeName(query)
    if (!needle) return { data: [], total: 0 }
    if (dump) {
      const matches: Card[] = []
      for (const card of byId.values()) {
        if (normalizeName(card.name).includes(needle)) matches.push(card)
      }
      matches.sort((a, b) => a.name.localeCompare(b.name))
      return { data: matches.slice(0, searchLimit), total: matches.length }
    }
    const cards = await upstreamCards({ fname: query })
    return { data: cards.slice(0, searchLimit), total: cards.length }
  }

  async function cardsInSet(setName: string) {
    if (dump) return getBySet().get(setName) ?? []
    return upstreamCards({ cardset: setName })
  }

  async function sets(): Promise<string> {
    try {
      return await fs.readFile(setsPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const response = await fetchUpstream(`${upstreamApi}/cardsets.php`)
    if (!response.ok) throw new Error(`cardsets ${response.status}`)
    const text = await response.text()
    await writeFileAtomic(setsPath, text)
    return text
  }

  // ---- handlers ----------------------------------------------------------
  const cards: ApiHandler = async (req, res) => {
    try {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      res.setHeader('Cache-Control', 'no-cache')

      if (url.pathname === '/status') {
        sendJson(res, 200, {
          loaded: Boolean(dump),
          version: dump?.version ?? '',
          lastUpdate: dump?.lastUpdate ?? '',
          fetchedAt: dump?.fetchedAt ?? '',
          count: byId.size,
          source: dump ? 'local' : 'upstream',
        })
        return
      }
      if (url.pathname === '/sets') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(await sets())
        return
      }
      if (url.pathname !== '/') {
        sendJson(res, 404, { error: 'Not found' })
        return
      }

      const ids = url.searchParams.get('ids')
      if (ids !== null) {
        const list = ids.split(',').map((value) => Number(value.trim())).filter(Boolean)
        if (list.length > maxIdsPerQuery) {
          sendJson(res, 400, { error: `At most ${maxIdsPerQuery} ids per request` })
          return
        }
        sendJson(res, 200, await cardsByIds(list))
        return
      }
      const names = url.searchParams.get('names')
      if (names !== null) {
        sendJson(res, 200, await cardsByNames(names.split('|')))
        return
      }
      const q = url.searchParams.get('q')
      if (q !== null) {
        sendJson(res, 200, await search(q))
        return
      }
      const set = url.searchParams.get('set')
      if (set !== null) {
        const data = await cardsInSet(set)
        sendJson(res, 200, { data, total: data.length })
        return
      }
      sendJson(res, 400, { error: 'Use ids=, names=, q= or set=' })
    } catch (error) {
      sendJson(res, 502, { error: error instanceof Error ? error.message : 'Card database failed.' })
    }
  }

  const imageFetches = new Map<string, Promise<string>>()
  async function ensureImage(id: number, kind: ImageKind) {
    const filePath = path.join(imagesDir, imageKinds[kind], `${id}.jpg`)
    const key = `${kind}/${id}`
    const pending = imageFetches.get(key)
    if (pending) return pending
    const task = (async () => {
      try {
        await fs.access(filePath)
        return filePath
      } catch {
        // not cached yet
      }
      const response = await fetchUpstream(`${upstreamImages}/${imageKinds[kind]}/${id}.jpg`)
      if (response.status === 404) throw Object.assign(new Error('Image not found'), { status: 404 })
      if (!response.ok || !response.body) throw new Error(`image upstream ${response.status}`)
      await writeFileAtomic(filePath, Buffer.from(await response.arrayBuffer()))
      return filePath
    })().finally(() => {
      imageFetches.delete(key)
    })
    imageFetches.set(key, task)
    return task
  }

  const images: ApiHandler = async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'Method not allowed' })
        return
      }
      const match = (req.url ?? '').split('?')[0].match(/^\/(\d{1,12})\/(small|full|cropped)$/)
      if (!match) {
        sendJson(res, 404, { error: 'Use /api/images/<id>/<small|full|cropped>' })
        return
      }
      const id = Number(match[1])
      const kind = match[2] as ImageKind
      let filePath: string
      try {
        filePath = await ensureImage(id, kind)
      } catch (error) {
        const status = (error as { status?: number }).status === 404 ? 404 : 502
        sendJson(res, status, { error: error instanceof Error ? error.message : 'Image failed.' })
        return
      }
      const stat = await fs.stat(filePath)
      const etag = `"${id}-${kind}-${stat.size}"`
      res.setHeader('ETag', etag)
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304
        res.end()
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'image/jpeg')
      res.setHeader('Content-Length', stat.size)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      await pipeline(createReadStream(filePath), res)
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : 'Image failed.' })
      } else {
        res.destroy()
      }
    }
  }

  return { cards, images, start, stop, refresh }
}
