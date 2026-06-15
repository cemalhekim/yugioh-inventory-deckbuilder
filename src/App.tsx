import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, MouseEvent } from 'react'
import {
  GitgraphCore,
  MergeStyle,
  TemplateName,
  templateExtend,
  toSvgPath,
} from '@gitgraph/core'
import './App.css'

type DeckZone = 'main' | 'extra' | 'side'
type DeckViewMode = 'list' | 'cards'
type AppPage = 'deck' | 'products'
type SearchPanelView = 'search' | 'inventory'
type SearchResultSource = 'search' | 'inventory'

type YgoCard = {
  id: number
  name: string
  type: string
  desc: string
  race?: string
  attribute?: string
  atk?: number
  def?: number
  level?: number
  scale?: number
  linkval?: number
  archetype?: string
  card_images?: { image_url: string; image_url_small: string; image_url_cropped?: string }[]
}

type YgoSet = {
  set_name: string
  set_code: string
  num_of_cards: number
  tcg_date?: string
  set_image?: string
}

type KaibaDeckFile = {
  fileName: string
  name: string
  updatedAt: string
  size: number
}

type DeckVersion = {
  id: string
  createdAt: string
  source: string
  hash: string
  contentHash: string
  size: number
  branchName?: string
  parentId?: string
  note?: string
}

type InventoryEntry = {
  card: YgoCard
  quantity: number
}

type DeckEntry = {
  card: YgoCard
  quantity: number
}

type DeckState = Record<DeckZone, DeckEntry[]>

type PersistedState = {
  inventory: InventoryEntry[]
  deck: DeckState
  deckName: string
}

const STORAGE_KEY = 'ygo-inventory-deckbuilder-v1'
const KAIBAPRO_DECK_DIR_KEY = 'kaibapro-deck-dir-v1'
const SIMULATOR_APP_DIR_KEY = 'simulator-app-dir-v1'
const maxDeckCopies = 3
const deckZoneLimits: Record<DeckZone, number> = {
  main: 60,
  extra: 15,
  side: 15,
}

const emptyDeck: DeckState = {
  main: [],
  extra: [],
  side: [],
}

const zoneLabels: Record<DeckZone, string> = {
  main: 'Main',
  extra: 'Extra',
  side: 'Side',
}

const zoneOrder: DeckZone[] = ['main', 'extra', 'side']
const cardmarketWantsUrl = 'https://www.cardmarket.com/en/YuGiOh/Wants'
const cardmarketPayloadHashKey = 'ygo-inventory-wants'
const cardDragDataType = 'application/ygo-card'
const historyRowHeight = 72
const historyLaneWidth = 34
const historyLaneStart = 18
const historyGraphInset = 26
const historyGraphYOffset = historyRowHeight / 2
const historyLaneColors = ['#39c8ff', '#f7d45c', '#e218a9', '#18df35', '#f0a21b', '#9f22ff']
const historyGraphTemplate = templateExtend(TemplateName.Metro, {
  colors: historyLaneColors,
  branch: {
    lineWidth: 4,
    mergeStyle: MergeStyle.Bezier,
    spacing: historyLaneWidth,
    label: { display: false },
  },
  commit: {
    spacing: historyRowHeight,
    message: { display: false, displayAuthor: false, displayHash: false },
    dot: { size: 12, strokeWidth: 3, strokeColor: '#07101f' },
  },
})

function isExtraDeckCard(card: YgoCard) {
  return ['Fusion', 'Synchro', 'XYZ', 'Xyz', 'Link'].some((type) =>
    card.type.includes(type),
  )
}

function getDeckSortRank(card: YgoCard) {
  const type = card.type.toLowerCase()
  const race = card.race?.toLowerCase() ?? ''

  if (type.includes('normal monster')) return 10
  if (type.includes('effect') || type.includes('tuner') || type.includes('spirit')) return 20
  if (type.includes('ritual')) return 30
  if (type.includes('pendulum')) return 40
  if (type.includes('spell')) {
    const spellRanks: Record<string, number> = {
      normal: 100,
      'quick-play': 110,
      continuous: 120,
      equip: 130,
      field: 140,
      ritual: 150,
    }
    return spellRanks[race] ?? 190
  }
  if (type.includes('trap')) {
    const trapRanks: Record<string, number> = {
      normal: 200,
      continuous: 210,
      counter: 220,
    }
    return trapRanks[race] ?? 290
  }
  if (type.includes('fusion')) return 300
  if (type.includes('synchro')) return 310
  if (type.includes('xyz')) return 320
  if (type.includes('link')) return 330
  return 900
}

function getExtraDeckSortRank(card: YgoCard) {
  const type = card.type.toLowerCase()

  if (type.includes('fusion')) return 0
  if (type.includes('synchro')) return 1
  if (type.includes('xyz')) return 2
  if (type.includes('link')) return 3
  return 9
}

function getSearchSortRank(card: YgoCard) {
  const type = card.type.toLowerCase()

  if (type.includes('normal monster')) return 10
  if (type.includes('ritual')) return 30
  if (isExtraDeckCard(card)) return 40 + getExtraDeckSortRank(card)
  if (type.includes('spell')) return 50
  if (type.includes('trap')) return 60
  if (type.includes('monster')) return 20
  return 90
}

function sortSearchCards(cards: YgoCard[]) {
  return [...cards].sort((a, b) => {
    const rankDiff = getSearchSortRank(a) - getSearchSortRank(b)
    if (rankDiff) return rankDiff

    const nameDiff = a.name.localeCompare(b.name)
    if (nameDiff) return nameDiff

    return a.id - b.id
  })
}

function sortDeckEntries(entries: DeckEntry[]) {
  return [...entries].sort((a, b) => {
    const rankDiff = getDeckSortRank(a.card) - getDeckSortRank(b.card)
    if (rankDiff) return rankDiff

    if (isExtraDeckCard(a.card) && isExtraDeckCard(b.card)) {
      return a.card.name.localeCompare(b.card.name)
    }

    const subtypeDiff = (a.card.race ?? '').localeCompare(b.card.race ?? '')
    if (subtypeDiff) return subtypeDiff

    return a.card.name.localeCompare(b.card.name)
  })
}

function sortDeckState(deck: DeckState): DeckState {
  return {
    main: sortDeckEntries(deck.main),
    extra: sortDeckEntries(deck.extra),
    side: sortDeckEntries(deck.side),
  }
}

function loadState(): PersistedState {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return { inventory: [], deck: emptyDeck, deckName: 'Untitled Deck' }
  }

  try {
    return normalizeState(JSON.parse(raw) as Partial<PersistedState>)
  } catch {
    return { inventory: [], deck: emptyDeck, deckName: 'Untitled Deck' }
  }
}

function normalizeState(state: Partial<PersistedState>): PersistedState {
  return {
    inventory: state.inventory ?? [],
    deck: sortDeckState({ ...emptyDeck, ...state.deck }),
    deckName: state.deckName ?? 'Untitled Deck',
  }
}

function upsertEntry(entries: DeckEntry[], card: YgoCard, delta: number) {
  const index = entries.findIndex((entry) => entry.card.id === card.id)
  if (index === -1) {
    return delta > 0 ? [...entries, { card, quantity: delta }] : entries
  }

  const next = [...entries]
  const quantity = next[index].quantity + delta
  if (quantity <= 0) {
    next.splice(index, 1)
    return next
  }

  next[index] = { ...next[index], quantity }
  return next
}

function countDeckCardCopies(deck: DeckState, cardId: number) {
  return zoneOrder.reduce((sum, zone) => {
    return sum + (deck[zone].find((entry) => entry.card.id === cardId)?.quantity ?? 0)
  }, 0)
}

function countDeckZoneCards(deck: DeckState, zone: DeckZone) {
  return deck[zone].reduce((sum, entry) => sum + entry.quantity, 0)
}

function addCardCopies(deck: DeckState, zone: DeckZone, card: YgoCard, copies = 1) {
  if (copies <= 0) {
    return {
      ...deck,
      [zone]: sortDeckEntries(upsertEntry(deck[zone], card, copies)),
    }
  }

  const availableCopies = Math.max(maxDeckCopies - countDeckCardCopies(deck, card.id), 0)
  const availableZoneSlots = Math.max(deckZoneLimits[zone] - countDeckZoneCards(deck, zone), 0)
  const nextCopies = Math.min(copies, availableCopies, availableZoneSlots)
  if (nextCopies <= 0) return deck

  return {
    ...deck,
    [zone]: sortDeckEntries(upsertEntry(deck[zone], card, nextCopies)),
  }
}

function entriesToRepeatedIds(entries: DeckEntry[]) {
  return entries.flatMap((entry) =>
    Array.from({ length: entry.quantity }, () => entry.card.id),
  )
}

function createYdk(deck: DeckState, deckName: string) {
  const lines = [
    '#created by YGO Inventory Deckbuilder',
    `#name ${deckName}`,
    '#main',
    ...entriesToRepeatedIds(deck.main).map(String),
    '#extra',
    ...entriesToRepeatedIds(deck.extra).map(String),
    '!side',
    ...entriesToRepeatedIds(deck.side).map(String),
    '',
  ]

  return lines.join('\n')
}

async function createContentHash(content: string) {
  const data = new TextEncoder().encode(content)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}

function parseYdk(text: string) {
  const ids: Record<DeckZone, number[]> = { main: [], extra: [], side: [] }
  let zone: DeckZone = 'main'

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line === '#main') {
      zone = 'main'
      continue
    }
    if (line === '#extra') {
      zone = 'extra'
      continue
    }
    if (line === '!side') {
      zone = 'side'
      continue
    }
    if (line.startsWith('#')) continue

    const id = Number(line)
    if (Number.isFinite(id)) ids[zone].push(id)
  }

  return ids
}

function makeEntriesFromCards(cards: YgoCard[], zone: DeckZone) {
  const entries = new Map<number, DeckEntry>()
  let zoneSize = 0
  for (const card of cards) {
    const totalCopies = entries.get(card.id)?.quantity ?? 0
    if (totalCopies >= maxDeckCopies) continue
    if (zoneSize >= deckZoneLimits[zone]) break

    const current = entries.get(card.id)
    entries.set(card.id, {
      card,
      quantity: (current?.quantity ?? 0) + 1,
    })
    zoneSize += 1
  }
  return Array.from(entries.values()).sort((a, b) =>
    a.card.name.localeCompare(b.card.name),
  )
}

async function fetchCardsByIds(ids: number[]) {
  const uniqueIds = Array.from(new Set(ids))
  const cards = await Promise.all(
    uniqueIds.map(async (id) => {
      const response = await fetch(
        `https://db.ygoprodeck.com/api/v7/cardinfo.php?id=${id}`,
      )
      if (!response.ok) throw new Error(`Could not load card ${id}`)
      const payload = (await response.json()) as { data: YgoCard[] }
      return payload.data[0]
    }),
  )

  return new Map(cards.map((card) => [card.id, card]))
}

function getSetKind(setName: string) {
  const name = setName.toLowerCase()
  if (name.includes('structure deck')) return 'Structure'
  if (name.includes('starter deck') || name.includes('starter set')) return 'Starter'
  if (name.includes('tin')) return 'Tin'
  if (name.includes('booster') || name.includes('pack')) return 'Booster'
  return 'Other'
}

function createTimestampedName(prefix = 'YGO Missing') {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const timestamp = [
    String(date.getFullYear()).slice(-2),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
  const cleanPrefix = (prefix.trim() || 'YGO Missing')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
  const baseName = cleanPrefix || 'YGOMISSING'
  return `${baseName}${timestamp}`.slice(0, 30)
}

function encodePayloadForUrl(payload: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function App() {
  const [initialState] = useState(loadState)
  const [inventory, setInventory] = useState<InventoryEntry[]>(
    initialState.inventory,
  )
  const [deck, setDeck] = useState<DeckState>(initialState.deck)
  const [deckName, setDeckName] = useState(initialState.deckName)
  const [appPage, setAppPage] = useState<AppPage>('deck')
  const [deckViewMode, setDeckViewMode] = useState<DeckViewMode>('cards')
  const [searchPanelView, setSearchPanelView] = useState<SearchPanelView>('search')
  const [previewCard, setPreviewCard] = useState<YgoCard | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<YgoCard[]>([])
  const [searchResultSource, setSearchResultSource] = useState<SearchResultSource>('search')
  const [status, setStatus] = useState('Search for a card to start building.')
  const [isSearching, setIsSearching] = useState(false)
  const [sets, setSets] = useState<YgoSet[]>([])
  const [productQuery, setProductQuery] = useState('')
  const [setKindFilter, setSetKindFilter] = useState('All')
  const [selectedSet, setSelectedSet] = useState<YgoSet | null>(null)
  const [selectedSetCards, setSelectedSetCards] = useState<YgoCard[]>([])
  const [productStatus, setProductStatus] = useState('Loading product catalog...')
  const [isSetLoading, setIsSetLoading] = useState(false)
  const [kaibaDecks, setKaibaDecks] = useState<KaibaDeckFile[]>([])
  const [kaibaDeckDir, setKaibaDeckDir] = useState(
    () => localStorage.getItem(KAIBAPRO_DECK_DIR_KEY) ?? '',
  )
  const [simulatorAppDir, setSimulatorAppDir] = useState(
    () => localStorage.getItem(SIMULATOR_APP_DIR_KEY) ?? '',
  )
  const [repoDeckDir, setRepoDeckDir] = useState('')
  const [selectedKaibaDeck, setSelectedKaibaDeck] = useState('')
  const [kaibaStatus, setKaibaStatus] = useState('Connect to KaibaPro decks.')
  const [isKaibaFolderPicking, setIsKaibaFolderPicking] = useState(false)
  const [deckHistory, setDeckHistory] = useState<DeckVersion[]>([])
  const [activeDeckContentHash, setActiveDeckContentHash] = useState('')
  const [activeDeckBranchName, setActiveDeckBranchName] = useState('')
  const [deckContextMenu, setDeckContextMenu] = useState<{
    fileName: string
    x: number
    y: number
  } | null>(null)
  const [versionContextMenu, setVersionContextMenu] = useState<{
    version: DeckVersion
    x: number
    y: number
  } | null>(null)
  const [cardmarketListName, setCardmarketListName] = useState(createTimestampedName)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const initialKaibaDeckDirRef = useRef(kaibaDeckDir)

  useEffect(() => {
    const state: PersistedState = { inventory, deck, deckName }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [inventory, deck, deckName])

  useEffect(() => {
    if (!selectedKaibaDeck) {
      setActiveDeckContentHash('')
      return
    }

    let canceled = false

    async function updateActiveDeckHash() {
      try {
        const hash = await createContentHash(createYdk(deck, deckName))
        if (!canceled) setActiveDeckContentHash(hash)
      } catch {
        if (!canceled) setActiveDeckContentHash('')
      }
    }

    void updateActiveDeckHash()

    return () => {
      canceled = true
    }
  }, [deck, deckName, selectedKaibaDeck])

  useEffect(() => {
    let canceled = false

    async function loadRepoState() {
      try {
        const response = await fetch('/api/app-state')
        if (!response.ok) return
        const payload = (await response.json()) as {
          state: Partial<PersistedState> | null
        }
        if (!payload.state || canceled) return

        const nextState = normalizeState(payload.state)
        setInventory(nextState.inventory)
        setDeck(nextState.deck)
        setDeckName(nextState.deckName)
        setStatus('Loaded inventory from repository backup.')
      } catch {
        // Static previews do not provide the local repo state API.
      }
    }

    void loadRepoState()

    return () => {
      canceled = true
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    async function loadSets() {
      try {
        const response = await fetch(
          'https://db.ygoprodeck.com/api/v7/cardsets.php',
          { signal: controller.signal },
        )
        if (!response.ok) throw new Error('Could not load product catalog.')
        const payload = (await response.json()) as YgoSet[]
        setSets(payload)
        setProductStatus(`Loaded ${payload.length} sets and sealed products.`)
      } catch (error) {
        if (!controller.signal.aborted) {
          setProductStatus(
            error instanceof Error ? error.message : 'Could not load sets.',
          )
        }
      }
    }

    void loadSets()

    return () => controller.abort()
  }, [])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) return

    const controller = new AbortController()
    const timeout = window.setTimeout(async () => {
      setIsSearching(true)
      try {
        const response = await fetch(
          `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        )
        if (!response.ok) throw new Error('No cards found')
        const payload = (await response.json()) as { data: YgoCard[] }
        setSearchResultSource('search')
        setResults(sortSearchCards(payload.data).slice(0, 20))
        setStatus(`Found ${payload.data.length} matching cards.`)
      } catch (error) {
        if (!controller.signal.aborted) {
          setResults([])
          setStatus(error instanceof Error ? error.message : 'Search failed.')
        }
      } finally {
        if (!controller.signal.aborted) setIsSearching(false)
      }
    }, 300)

    return () => {
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [query])

  function updateQuery(value: string) {
    setQuery(value)
    setSearchResultSource('search')
    if (value.trim().length < 2) {
      setResults([])
      setStatus('Search for a card to start building.')
    }
  }

  const inventoryById = useMemo(() => {
    return new Map(inventory.map((entry) => [entry.card.id, entry.quantity]))
  }, [inventory])

  const visibleResults = results

  const deckTotals = useMemo(() => {
    const totals = new Map<number, { card: YgoCard; quantity: number }>()
    for (const zone of zoneOrder) {
      for (const entry of deck[zone]) {
        const current = totals.get(entry.card.id)
        totals.set(entry.card.id, {
          card: entry.card,
          quantity: (current?.quantity ?? 0) + entry.quantity,
        })
      }
    }
    return totals
  }, [deck])

  const missingEntries = useMemo(() => {
    return Array.from(deckTotals.values())
      .map((entry) => ({
        ...entry,
        missing: Math.max(entry.quantity - (inventoryById.get(entry.card.id) ?? 0), 0),
      }))
      .filter((entry) => entry.missing > 0)
      .sort((a, b) => a.card.name.localeCompare(b.card.name))
  }, [deckTotals, inventoryById])

  const missingListText = useMemo(() => {
    return missingEntries
      .map((entry) => `${entry.missing}x ${entry.card.name}`)
      .join('\n')
  }, [missingEntries])

  const deckSize = zoneOrder.reduce(
    (sum, zone) => sum + deck[zone].reduce((total, entry) => total + entry.quantity, 0),
    0,
  )
  const ownedDeckCards = Array.from(deckTotals.values()).reduce(
    (sum, entry) => sum + Math.min(entry.quantity, inventoryById.get(entry.card.id) ?? 0),
    0,
  )
  const missingCount = missingEntries.reduce((sum, entry) => sum + entry.missing, 0)
  const activeDeckVersionId = useMemo(
    () =>
      activeDeckContentHash
        ? (deckHistory.find((version) => version.contentHash === activeDeckContentHash)?.id ?? '')
        : '',
    [activeDeckContentHash, deckHistory],
  )

  const deckHistoryGraph = useMemo(() => {
    const branchNames = Array.from(
      new Set(deckHistory.map((version) => version.branchName).filter(Boolean) as string[]),
    )
    const graph = new GitgraphCore({
      branchLabelOnEveryCommit: false,
      commitMessage: '',
      template: historyGraphTemplate,
    })
    const gitgraph = graph.getUserApi()
    const chronologicalHistory = [...deckHistory].reverse()
    const branches = new Map<string, ReturnType<typeof gitgraph.branch>>()
    const commitHashesByVersionId = new Map<string, string>()
    const main = gitgraph.branch('main')
    branches.set('main', main)

    for (const version of chronologicalHistory) {
      const commitHash = version.hash || version.id.replace(/\.ydk$/i, '')
      const subject = version.branchName ? `branch: ${version.branchName}` : version.source

      if (!version.branchName) {
        main.commit({ hash: commitHash, subject })
        commitHashesByVersionId.set(version.id, commitHash)
        continue
      }

      const parentHash = version.parentId
        ? commitHashesByVersionId.get(version.parentId)
        : undefined
      const branchName = version.branchName
      const branch =
        branches.get(branchName) ??
        gitgraph.branch({
          from: parentHash ?? main,
          name: branchName,
        })

      branches.set(branchName, branch)
      branch.commit({ hash: commitHash, subject })
      commitHashesByVersionId.set(version.id, commitHash)
    }

    const rendered = graph.getRenderedData()
    const versionByHash = new Map(
      deckHistory.map((version) => [
        version.hash || version.id.replace(/\.ydk$/i, ''),
        version,
      ]),
    )
    const commits = rendered.commits.map((commit) => {
      const version = versionByHash.get(commit.hash)
      return {
        color: commit.style.color ?? historyLaneColors[0],
        hash: commit.hash,
        isActive: version?.id === activeDeckVersionId,
        x: commit.x,
        y: commit.y,
      }
    })
    const rows = [...commits]
      .sort((a, b) => a.y - b.y)
      .map((commit) => versionByHash.get(commit.hash))
      .filter((version): version is DeckVersion => Boolean(version))
    const paths = Array.from(rendered.branchesPaths).map(([branch, coordinates]) => ({
      color: branch.style.color ?? historyLaneColors[0],
      d: toSvgPath(coordinates, true, true),
    }))
    const maxX = Math.max(...commits.map((commit) => commit.x), 0)
    const maxY = Math.max(...commits.map((commit) => commit.y), 0)

    return {
      commits,
      graphHeight: maxY + historyRowHeight,
      graphWidth: Math.max(
        historyLaneStart + Math.max(branchNames.length, 1) * historyLaneWidth + 42,
        maxX + historyGraphInset * 2 + 24,
      ),
      paths,
      rows,
    }
  }, [activeDeckVersionId, deckHistory])

  const filteredSets = useMemo(() => {
    const normalizedQuery = productQuery.trim().toLowerCase()
    return sets
      .filter((set) => {
        const matchesKind =
          setKindFilter === 'All' || getSetKind(set.set_name) === setKindFilter
        const matchesQuery =
          !normalizedQuery ||
          set.set_name.toLowerCase().includes(normalizedQuery) ||
          set.set_code.toLowerCase().includes(normalizedQuery)
        return matchesKind && matchesQuery
      })
      .sort((a, b) => {
        const aTime = a.tcg_date ? Date.parse(a.tcg_date) : 0
        const bTime = b.tcg_date ? Date.parse(b.tcg_date) : 0
        if (aTime !== bTime) return bTime - aTime
        return a.set_name.localeCompare(b.set_name)
      })
      .slice(0, 80)
  }, [productQuery, setKindFilter, sets])

  function addToInventory(card: YgoCard, delta = 1) {
    setInventory((current) => {
      const next = upsertEntry(current, card, delta)
      return next.sort((a, b) => a.card.name.localeCompare(b.card.name))
    })
  }

  function addManyToInventory(cards: YgoCard[], copies = 1) {
    setInventory((current) => {
      let next = current
      for (const card of cards) {
        next = upsertEntry(next, card, copies)
      }
      return next.sort((a, b) => a.card.name.localeCompare(b.card.name))
    })
  }

  function addCardToZone(card: YgoCard, targetZone: DeckZone) {
    setDeck((current) => {
      if (targetZone === 'main' && isExtraDeckCard(card)) {
        setStatus(`${card.name} belongs in the Extra Deck.`)
        return current
      }
      if (targetZone === 'extra' && !isExtraDeckCard(card)) {
        setStatus(`${card.name} belongs in the Main or Side Deck.`)
        return current
      }
      if (countDeckZoneCards(current, targetZone) >= deckZoneLimits[targetZone]) {
        setStatus(`${zoneLabels[targetZone]} Deck is already at ${deckZoneLimits[targetZone]} cards.`)
        return current
      }
      if (countDeckCardCopies(current, card.id) >= maxDeckCopies) {
        setStatus(`${card.name} is already at ${maxDeckCopies} copies in the deck.`)
        return current
      }
      return addCardCopies(current, targetZone, card)
    })
  }

  function addToDeck(card: YgoCard) {
    addCardToZone(card, isExtraDeckCard(card) ? 'extra' : 'main')
  }

  function addToSideDeck(card: YgoCard) {
    addCardToZone(card, 'side')
  }

  function handleSearchCardDragStart(event: DragEvent<HTMLImageElement>, card: YgoCard) {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(cardDragDataType, JSON.stringify(card))
  }

  function handleDeckZoneDragOver(event: DragEvent<HTMLDivElement>) {
    if (!Array.from(event.dataTransfer.types).includes(cardDragDataType)) return

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  function handleDeckZoneDrop(event: DragEvent<HTMLDivElement>, zone: DeckZone) {
    const rawCard = event.dataTransfer.getData(cardDragDataType)
    if (!rawCard) return

    event.preventDefault()
    try {
      addCardToZone(JSON.parse(rawCard) as YgoCard, zone)
    } catch {
      setStatus('Could not add dragged card.')
    }
  }

  function updateDeckCard(zone: DeckZone, card: YgoCard, delta: number) {
    setDeck((current) => {
      if (delta > 0 && countDeckZoneCards(current, zone) >= deckZoneLimits[zone]) {
        setStatus(`${zoneLabels[zone]} Deck is already at ${deckZoneLimits[zone]} cards.`)
        return current
      }
      if (delta > 0 && countDeckCardCopies(current, card.id) >= maxDeckCopies) {
        setStatus(`${card.name} is already at ${maxDeckCopies} copies in the deck.`)
        return current
      }
      return addCardCopies(current, zone, card, delta)
    })
  }

  function handleDeckCardMouseDown(
    event: MouseEvent<HTMLImageElement>,
    zone: DeckZone,
    card: YgoCard,
  ) {
    if (event.button !== 1) return

    event.preventDefault()
    updateDeckCard(zone, card, 1)
  }

  function prepareCardmarketWants() {
    const listName = createTimestampedName(deckName)
    setCardmarketListName(listName)
    void navigator.clipboard.writeText(missingListText)
    const payload = encodePayloadForUrl({
      name: listName,
      decklist: missingListText,
      createdAt: new Date().toISOString(),
    })
    window.open(
      `${cardmarketWantsUrl}?${cardmarketPayloadHashKey}=${payload}&ygo-auto=1`,
      '_blank',
      'noopener,noreferrer',
    )
    setStatus('Cardmarket opened.')
  }

  async function selectSimulatorAppFolder() {
    const response = await fetch('/api/ygopro/select-folder', { method: 'POST' })
    if (!response.ok) throw new Error('Could not select simulator application folder.')
    const payload = (await response.json()) as {
      appDir: string
      launcherPath?: string
      canceled?: boolean
    }
    if (payload.canceled) return ''

    setSimulatorAppDir(payload.appDir)
    localStorage.setItem(SIMULATOR_APP_DIR_KEY, payload.appDir)
    setStatus(`Simulator launcher found: ${payload.launcherPath ?? payload.appDir}`)
    return payload.appDir
  }

  async function launchSimulator() {
    let appDir = simulatorAppDir

    if (!appDir) {
      const confirmed = window.confirm(
        'No valid simulator application path is configured yet. After you press OK, select the root folder where the simulator application is installed. The launcher will inspect that folder, use a .exe launcher on Windows, or run the first suitable Linux executable/AppImage/shell launcher it finds, then store this folder for future launches.',
      )
      if (!confirmed) return
      appDir = await selectSimulatorAppFolder()
      if (!appDir) {
        setStatus('Simulator folder selection canceled.')
        return
      }
    }

    setStatus('Launching simulator...')
    try {
      const response = await fetch('/api/ygopro/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appDir }),
      })
      if (!response.ok) throw new Error('Could not launch simulator.')
      const payload = (await response.json()) as { appDir: string; launcherPath: string }
      setSimulatorAppDir(payload.appDir)
      localStorage.setItem(SIMULATOR_APP_DIR_KEY, payload.appDir)
      setStatus(`Simulator started: ${payload.launcherPath}`)
    } catch (error) {
      const shouldSelectAgain = window.confirm(
        'The configured simulator path could not be launched. Press OK to select the simulator application folder again.',
      )
      if (!shouldSelectAgain) {
        setStatus(error instanceof Error ? error.message : 'Simulator launch failed.')
        return
      }

      try {
        const nextDir = await selectSimulatorAppFolder()
        if (!nextDir) {
          setStatus('Simulator folder selection canceled.')
          return
        }
        const response = await fetch('/api/ygopro/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appDir: nextDir }),
        })
        if (!response.ok) {
          setStatus('Could not launch simulator.')
          return
        }
        const payload = (await response.json()) as { appDir: string; launcherPath: string }
        setStatus(`Simulator started: ${payload.launcherPath}`)
      } catch (launchError) {
        setStatus(launchError instanceof Error ? launchError.message : 'Simulator launch failed.')
      }
    }
  }

  async function loadSetCards(set: YgoSet) {
    setSelectedSet(set)
    setSelectedSetCards([])
    setIsSetLoading(true)
    setProductStatus(`Loading ${set.set_name}...`)

    try {
      const response = await fetch(
        `https://db.ygoprodeck.com/api/v7/cardinfo.php?cardset=${encodeURIComponent(set.set_name)}`,
      )
      if (!response.ok) throw new Error(`No cards found for ${set.set_name}.`)
      const payload = (await response.json()) as { data: YgoCard[] }
      const cards = payload.data.sort((a, b) => a.name.localeCompare(b.name))
      setSelectedSetCards(cards)
      setProductStatus(`${set.set_name}: ${cards.length} listed cards.`)
    } catch (error) {
      setSelectedSetCards([])
      setProductStatus(error instanceof Error ? error.message : 'Set load failed.')
    } finally {
      setIsSetLoading(false)
    }
  }

  const refreshKaibaDecks = useCallback(async () => {
    try {
      const response = await fetch('/api/kaibapro/decks/')
      if (!response.ok) throw new Error('Could not connect to KaibaPro deck folder.')
      const payload = (await response.json()) as {
        deckDir: string
        repoDeckDir: string
        decks: KaibaDeckFile[]
        syncResult?: { copiedToKaiba: number; copiedToRepo: number }
      }
      setKaibaDeckDir(payload.deckDir)
      setRepoDeckDir(payload.repoDeckDir)
      localStorage.setItem(KAIBAPRO_DECK_DIR_KEY, payload.deckDir)
      setKaibaDecks(payload.decks)
      const copied = (payload.syncResult?.copiedToKaiba ?? 0) + (payload.syncResult?.copiedToRepo ?? 0)
      setKaibaStatus(
        copied
          ? `Synced ${copied} decks. Found ${payload.decks.length} KaibaPro decks.`
          : `Found ${payload.decks.length} KaibaPro decks.`,
      )
    } catch (error) {
      setKaibaStatus(
        error instanceof Error ? error.message : 'KaibaPro connection failed.',
      )
    }
  }, [])

  useEffect(() => {
    let canceled = false

    async function connectKaibaFolder() {
      try {
        const savedDeckDir = initialKaibaDeckDirRef.current
        if (savedDeckDir) {
          const response = await fetch('/api/kaibapro/decks/folder', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deckDir: savedDeckDir }),
          })
          if (!response.ok) throw new Error('Could not use saved KaibaPro folder.')
        }
        if (!canceled) await refreshKaibaDecks()
      } catch (error) {
        if (!canceled) {
          setKaibaStatus(
            error instanceof Error ? error.message : 'KaibaPro connection failed.',
          )
        }
      }
    }

    void connectKaibaFolder()

    return () => {
      canceled = true
    }
  }, [refreshKaibaDecks])

  async function chooseKaibaDeckFolder() {
    const confirmed = window.confirm(
      'Select the simulator deck directory that contains the active .ydk deck files. After you press OK, the operating system folder picker will open. Once a folder is selected, the app will scan that directory, mirror all .ydk files into this repository\'s decks/ folder, copy newer deck files in both directions based on file modification time, update the KaibaPro deck list, and create per-deck version-history snapshots under decks/.history so previous deck states can be restored later.',
    )
    if (!confirmed) return

    setKaibaStatus('Select your KaibaPro deck folder...')
    setIsKaibaFolderPicking(true)
    try {
      const response = await fetch('/api/kaibapro/decks/select-folder', {
        method: 'POST',
      })
      if (!response.ok) throw new Error('Could not select KaibaPro deck folder.')
      const payload = (await response.json()) as {
        deckDir: string
        repoDeckDir?: string
        canceled?: boolean
      }
      if (payload.canceled) {
        setKaibaStatus('Folder selection canceled.')
        return
      }

      setSelectedKaibaDeck('')
      setDeckHistory([])
      setKaibaDeckDir(payload.deckDir)
      if (payload.repoDeckDir) setRepoDeckDir(payload.repoDeckDir)
      localStorage.setItem(KAIBAPRO_DECK_DIR_KEY, payload.deckDir)
      await refreshKaibaDecks()
    } catch (error) {
      setKaibaStatus(error instanceof Error ? error.message : 'Folder selection failed.')
    } finally {
      setIsKaibaFolderPicking(false)
    }
  }

  function listInventoryCards() {
    setQuery('')
    setSearchResultSource('inventory')
    const cards = sortSearchCards(inventory.map((entry) => entry.card))
    setResults(cards)
    setStatus(`Listed ${cards.length} inventory cards.`)
  }

  async function openKaibaDeck(fileName: string) {
    setKaibaStatus(`Opening ${fileName}...`)
    try {
      const response = await fetch(`/api/kaibapro/decks/${encodeURIComponent(fileName)}`)
      if (!response.ok) throw new Error(`Could not open ${fileName}.`)
      const payload = (await response.json()) as {
        fileName: string
        name: string
        content: string
      }
      const parsed = parseYdk(payload.content)
      const allIds = [...parsed.main, ...parsed.extra, ...parsed.side]
      const cardsById = await fetchCardsByIds(allIds)
      const nextDeck: DeckState = { main: [], extra: [], side: [] }

      for (const zone of zoneOrder) {
        const cards = parsed[zone]
          .map((id) => cardsById.get(id))
          .filter((card): card is YgoCard => Boolean(card))
        nextDeck[zone] = makeEntriesFromCards(cards, zone)
      }

      setDeck(sortDeckState(nextDeck))
      setDeckName(payload.name)
      setSelectedKaibaDeck(payload.fileName)
      setActiveDeckBranchName('')
      setDeckContextMenu(null)
      setKaibaStatus(`Loaded ${payload.fileName}.`)
      await loadDeckHistory(payload.fileName)
    } catch (error) {
      setKaibaStatus(error instanceof Error ? error.message : 'Open deck failed.')
    }
  }

  async function loadDeckHistory(fileName = selectedKaibaDeck) {
    if (!fileName) {
      setKaibaStatus('Open a deck before loading history.')
      return
    }

    try {
      const response = await fetch(
        `/api/kaibapro/decks/${encodeURIComponent(fileName)}/history`,
      )
      if (!response.ok) throw new Error(`Could not load history for ${fileName}.`)
      const payload = (await response.json()) as {
        fileName: string
        versions: DeckVersion[]
      }
      setDeckHistory(payload.versions)
      setKaibaStatus(`Loaded ${payload.versions.length} versions for ${payload.fileName}.`)
    } catch (error) {
      setKaibaStatus(error instanceof Error ? error.message : 'Load history failed.')
    }
  }

  function openVersionContextMenu(event: MouseEvent<HTMLDivElement>, version: DeckVersion) {
    event.preventDefault()
    setDeckContextMenu(null)
    setVersionContextMenu({
      version,
      x: event.clientX,
      y: event.clientY,
    })
  }

  async function branchDeckVersion(versionId: string) {
    if (!selectedKaibaDeck) {
      setKaibaStatus('Open a deck before branching.')
      return
    }

    const branchName = window.prompt('Branch name')
    if (!branchName?.trim()) return

    try {
      const response = await fetch(
        `/api/kaibapro/decks/${encodeURIComponent(selectedKaibaDeck)}/history/${encodeURIComponent(versionId)}/branch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branchName: branchName.trim() }),
        },
      )
      if (!response.ok) throw new Error(`Could not branch ${selectedKaibaDeck}.`)
      const payload = (await response.json()) as {
        branchName: string
        versions: DeckVersion[]
      }
      setDeckHistory(payload.versions)
      setVersionContextMenu(null)
      setKaibaStatus(`Created branch ${payload.branchName} from ${selectedKaibaDeck}.`)
    } catch (error) {
      setKaibaStatus(error instanceof Error ? error.message : 'Branch deck failed.')
    }
  }

  async function addDeckVersionNote(version: DeckVersion) {
    if (!selectedKaibaDeck) return

    const note = window.prompt('Version note', version.note || version.createdAt)
    if (note === null) return

    try {
      const response = await fetch(
        `/api/kaibapro/decks/${encodeURIComponent(selectedKaibaDeck)}/history/${encodeURIComponent(version.id)}/notes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note }),
        },
      )
      if (!response.ok) throw new Error(`Could not save note for ${selectedKaibaDeck}.`)
      const payload = (await response.json()) as { versions: DeckVersion[] }
      setDeckHistory(payload.versions)
      setVersionContextMenu(null)
      setKaibaStatus('Version note saved.')
    } catch (error) {
      setKaibaStatus(error instanceof Error ? error.message : 'Save note failed.')
    }
  }

  async function restoreDeckVersion(
    versionId: string,
    confirmFirst = true,
    nextBranchName = '',
  ) {
    if (!selectedKaibaDeck) return

    if (confirmFirst) {
      const confirmed = window.confirm(`Restore ${selectedKaibaDeck} to this version?`)
      if (!confirmed) return
    }

    setKaibaStatus(`Restoring ${selectedKaibaDeck}...`)
    try {
      const response = await fetch(
        `/api/kaibapro/decks/${encodeURIComponent(selectedKaibaDeck)}/history/${encodeURIComponent(versionId)}/restore`,
        { method: 'POST' },
      )
      if (!response.ok) throw new Error(`Could not restore ${selectedKaibaDeck}.`)
      const payload = (await response.json()) as { fileName: string }
      await openKaibaDeck(payload.fileName)
      setActiveDeckBranchName(nextBranchName)
      await refreshKaibaDecks()
      await loadDeckHistory(payload.fileName)
      setVersionContextMenu(null)
      setKaibaStatus(`Restored ${payload.fileName}.`)
    } catch (error) {
      setKaibaStatus(error instanceof Error ? error.message : 'Restore failed.')
    }
  }

  async function deleteDeckVersion(version: DeckVersion) {
    if (!selectedKaibaDeck) return

    const label = version.note?.trim() || version.branchName || version.source
    const confirmed = window.confirm(
      `Delete "${label}" and every version after it from ${selectedKaibaDeck} history?`,
    )
    if (!confirmed) return

    setKaibaStatus(`Deleting history from ${selectedKaibaDeck}...`)
    try {
      const response = await fetch(
        `/api/kaibapro/decks/${encodeURIComponent(selectedKaibaDeck)}/history/${encodeURIComponent(version.id)}`,
        { method: 'DELETE' },
      )
      if (!response.ok) throw new Error(`Could not delete history for ${selectedKaibaDeck}.`)
      const payload = (await response.json()) as {
        deletedIds: string[]
        versions: DeckVersion[]
      }
      setDeckHistory(payload.versions)
      setVersionContextMenu(null)
      setKaibaStatus(`Deleted ${payload.deletedIds.length} history versions.`)
    } catch (error) {
      setKaibaStatus(error instanceof Error ? error.message : 'Delete history failed.')
    }
  }

  async function deleteKaibaDeck(fileName: string) {
    const confirmed = window.confirm(`Delete ${fileName} from the KaibaPro deck folder?`)
    if (!confirmed) return

    setKaibaStatus(`Deleting ${fileName}...`)
    try {
      const response = await fetch(`/api/kaibapro/decks/${encodeURIComponent(fileName)}`, {
        method: 'DELETE',
      })
      if (!response.ok) throw new Error(`Could not delete ${fileName}.`)

      if (selectedKaibaDeck === fileName) {
        setSelectedKaibaDeck('')
        setDeckHistory([])
        setActiveDeckBranchName('')
      }

      setDeckContextMenu(null)
      setKaibaStatus(`Deleted ${fileName}.`)
      await refreshKaibaDecks()
    } catch (error) {
      setKaibaStatus(error instanceof Error ? error.message : 'Delete deck failed.')
    }
  }

  const saveKaibaDeck = useCallback(async (fileNameOrName: string, quiet = false, note = '') => {
    const target = fileNameOrName.trim()
    if (!target) {
      setKaibaStatus('Choose a KaibaPro deck or enter a save-as name.')
      return
    }

    try {
      const response = await fetch(`/api/kaibapro/decks/${encodeURIComponent(target)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branchName: activeDeckBranchName,
          content: createYdk(deck, deckName),
          note,
          parentId: activeDeckVersionId,
        }),
      })
      if (!response.ok) throw new Error('Could not save KaibaPro deck.')
      const payload = (await response.json()) as { fileName: string }
      setSelectedKaibaDeck(payload.fileName)
      if (!quiet) {
        setKaibaStatus(
          activeDeckBranchName
            ? `Saved ${payload.fileName} on branch ${activeDeckBranchName}.`
            : `Saved ${payload.fileName}.`,
        )
      }
      await refreshKaibaDecks()
      await loadDeckHistory(payload.fileName)
    } catch (error) {
      setKaibaStatus(error instanceof Error ? error.message : 'Save deck failed.')
    }
  }, [activeDeckBranchName, activeDeckVersionId, deck, deckName, refreshKaibaDecks])

  function saveCurrentWorkingDeck() {
    const target = selectedKaibaDeck || deckName
    const note = window.prompt('Save note', new Date().toLocaleString())
    if (note === null) return
    void saveKaibaDeck(target, false, note)
  }

  function openDeckContextMenu(event: MouseEvent<HTMLButtonElement>, fileName: string) {
    event.preventDefault()
    setVersionContextMenu(null)
    setDeckContextMenu({ fileName, x: event.clientX, y: event.clientY })
  }

  async function importYdk(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setStatus('Importing YDK...')
    try {
      const text = await file.text()
      const parsed = parseYdk(text)
      const allIds = [...parsed.main, ...parsed.extra, ...parsed.side]
      const cardsById = await fetchCardsByIds(allIds)
      const nextDeck: DeckState = { main: [], extra: [], side: [] }

      for (const zone of zoneOrder) {
        const cards = parsed[zone]
          .map((id) => cardsById.get(id))
          .filter((card): card is YgoCard => Boolean(card))
        nextDeck[zone] = makeEntriesFromCards(cards, zone)
      }

      setDeck(sortDeckState(nextDeck))
      setDeckName(file.name.replace(/\.ydk$/i, '') || 'Imported Deck')
      setStatus(`Imported ${allIds.length} cards from ${file.name}.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'YDK import failed.')
    } finally {
      event.target.value = ''
    }
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify({ inventory, deck, deckName }, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'ygo-inventory-backup.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  const saveRepoBackup = useCallback(async (quiet = false) => {
    try {
      const response = await fetch('/api/app-state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: { inventory, deck, deckName } }),
      })
      if (!response.ok) throw new Error('Could not save repository backup.')
      const payload = (await response.json()) as { filePath: string }
      if (!quiet) setStatus(`Repository backup saved: ${payload.filePath}`)
    } catch (error) {
      if (!quiet) {
        setStatus(error instanceof Error ? error.message : 'Repository backup failed.')
      }
    }
  }, [deck, deckName, inventory])

  async function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const parsed = JSON.parse(await file.text()) as PersistedState
      setInventory(parsed.inventory ?? [])
      setDeck(sortDeckState({ ...emptyDeck, ...parsed.deck }))
      setDeckName(parsed.deckName ?? 'Imported Deck')
      setStatus('Backup imported.')
    } catch {
      setStatus('Backup import failed.')
    } finally {
      event.target.value = ''
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <img className="kc-emblem" src="/kaibacorp-logo.png" alt="" aria-hidden="true" />
          <div>
            <p className="eyebrow">KaibaCorp deck command</p>
            <h1>Build from what you own. Buy only what is missing.</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="view-toggle" aria-label="App page">
            <button
              className={appPage === 'deck' ? 'active' : ''}
              type="button"
              onClick={() => setAppPage('deck')}
            >
              Deck Command
            </button>
            <button
              className={appPage === 'products' ? 'active' : ''}
              type="button"
              onClick={() => setAppPage('products')}
            >
              Sets & Products
            </button>
          </div>
          <button type="button" onClick={() => void launchSimulator()}>
            Launch Simulator
          </button>
          <button
            type="button"
            disabled={isKaibaFolderPicking}
            onClick={() => void chooseKaibaDeckFolder()}
          >
            Synch Simulator
          </button>
        </div>
      </header>

      {appPage === 'deck' ? <section className="stats-row" aria-label="Deck summary">
        <div>
          <span>{inventory.reduce((sum, entry) => sum + entry.quantity, 0)}</span>
          Inventory cards
        </div>
        <div>
          <span>{deckSize}</span>
          Deck cards
        </div>
        <div>
          <span>{ownedDeckCards}/{deckSize || 0}</span>
          Owned in deck
        </div>
        <div className="missing-stat" tabIndex={0}>
          <span>{missingCount}</span>
          Missing
          <div className="missing-dropdown">
            <div className="cardmarket-prep">
              <label>
                Wants list name
                <input readOnly value={cardmarketListName} />
              </label>
              <button
                type="button"
                onClick={prepareCardmarketWants}
                disabled={!missingEntries.length}
              >
                Open Wants
              </button>
            </div>
            <textarea
              readOnly
              value={missingListText}
              placeholder="Cards missing from your inventory will appear here."
            />
          </div>
        </div>
      </section> : null}

      <section className="workspace-grid">
        <section className="panel search-panel" hidden={appPage !== 'deck'}>
          <div className="panel-heading">
            <div>
              <h2>{searchPanelView === 'search' ? 'Card Search' : 'Inventory'}</h2>
              <p>{status}</p>
            </div>
            <div className="view-toggle" aria-label="Search panel view">
              <button
                className={searchPanelView === 'search' ? 'active' : ''}
                type="button"
                onClick={() => setSearchPanelView('search')}
              >
                Search
              </button>
              <button
                className={searchPanelView === 'inventory' ? 'active' : ''}
                type="button"
                onClick={() => setSearchPanelView('inventory')}
              >
                Inventory
              </button>
            </div>
          </div>
          {searchPanelView === 'search' ? (
            <>
              <input
                className="search-input"
                value={query}
                onChange={(event) => updateQuery(event.target.value)}
                placeholder="Search by card name"
              />
              <div className="search-tools">
                <button type="button" onClick={listInventoryCards} disabled={isSearching}>
                  List Inventory
                </button>
              </div>
              <div className="result-list">
                {isSearching ? <p className="muted">Searching...</p> : null}
                {visibleResults.map((card) => (
                  <article className="card-result" key={card.id}>
                    <img
                      src={card.card_images?.[0]?.image_url_small}
                      alt=""
                      draggable
                      title="Drag to Main, Extra, or Side Deck."
                      onDragStart={(event) => handleSearchCardDragStart(event, card)}
                      onClick={() => setPreviewCard(card)}
                    />
                    <div className="clickable-card-text" onClick={() => setPreviewCard(card)}>
                      <strong>{card.name}</strong>
                      <span>
                        {card.type}
                      </span>
                    </div>
                    <div className="row-actions">
                      {searchResultSource === 'search' ? (
                        <button type="button" onClick={() => addToInventory(card)}>
                          + Inv
                        </button>
                      ) : null}
                      <button type="button" onClick={() => addToDeck(card)}>
                        + Deck
                      </button>
                      <button type="button" onClick={() => addToSideDeck(card)}>
                        + Side
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="inventory-tools">
                <button type="button" onClick={() => void saveRepoBackup()}>
                  Save Repo
                </button>
                <button type="button" onClick={exportBackup}>Backup JSON</button>
                <label className="file-button">
                  Restore
                  <input type="file" accept="application/json" onChange={importBackup} hidden />
                </label>
              </div>
              <div className="inventory-list">
                {inventory.length ? (
                  inventory.map((entry) => (
                    <div className="line-item inventory-item" key={entry.card.id}>
                      <img
                        className="line-thumb"
                        src={entry.card.card_images?.[0]?.image_url_small}
                        alt=""
                        onClick={() => setPreviewCard(entry.card)}
                      />
                      <span>{entry.quantity}x</span>
                      <strong onClick={() => setPreviewCard(entry.card)}>
                        {entry.card.name}
                      </strong>
                      <button type="button" onClick={() => addToInventory(entry.card, 1)}>
                        +
                      </button>
                      <button type="button" onClick={() => addToInventory(entry.card, -1)}>
                        -
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="empty-state">Add cards from search results.</p>
                )}
              </div>
            </>
          )}
        </section>

        <section
          className={`panel sets-panel ${appPage === 'products' ? 'full-page-panel' : ''}`}
          hidden={appPage !== 'products'}
        >
          <div className="panel-heading">
            <div>
              <h2>Sets & Products</h2>
              <p>{productStatus}</p>
            </div>
          </div>
          <div className="set-tools">
            <input
              className="search-input set-search"
              value={productQuery}
              onChange={(event) => setProductQuery(event.target.value)}
              placeholder="Search sets, tins, structure decks"
            />
            <select
              value={setKindFilter}
              onChange={(event) => setSetKindFilter(event.target.value)}
              aria-label="Product type"
            >
              {['All', 'Structure', 'Starter', 'Booster', 'Tin', 'Other'].map(
                (kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ),
              )}
            </select>
          </div>
          <div className="set-browser">
            <div className="set-list">
              {filteredSets.map((set) => (
                <button
                  className={selectedSet?.set_name === set.set_name ? 'selected' : ''}
                  key={`${set.set_name}-${set.set_code}`}
                  type="button"
                  onClick={() => void loadSetCards(set)}
                >
                  <img src={set.set_image || '/kaibacorp-logo.png'} alt="" />
                  <strong>{set.set_name}</strong>
                  <span>
                    {set.set_code} · {getSetKind(set.set_name)} · {set.num_of_cards}
                  </span>
                </button>
              ))}
            </div>
            <div className="set-card-list">
              {selectedSet ? (
                <div className="set-summary">
                  <div>
                    <strong>{selectedSet.set_name}</strong>
                    <span>
                      {selectedSet.set_code} · {selectedSet.tcg_date ?? 'date unknown'}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={!selectedSetCards.length}
                    onClick={() => {
                      addManyToInventory(selectedSetCards)
                      setProductStatus(
                        `Added ${selectedSetCards.length} cards from ${selectedSet.set_name}.`,
                      )
                    }}
                  >
                    Add All
                  </button>
                </div>
              ) : (
                <p className="empty-state">Select a set or sealed product.</p>
              )}
              {isSetLoading ? <p className="muted">Loading cards...</p> : null}
              {selectedSetCards.map((card) => (
                <div className="line-item set-card-item" key={card.id}>
                  <img
                    className="line-thumb"
                    src={card.card_images?.[0]?.image_url_small}
                    alt=""
                    onClick={() => setPreviewCard(card)}
                  />
                  <span>{inventoryById.get(card.id) ?? 0}x</span>
                  <strong onClick={() => setPreviewCard(card)}>{card.name}</strong>
                  <small>{card.type}</small>
                  <button type="button" onClick={() => addToInventory(card)}>
                    +
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="panel deck-panel" hidden={appPage !== 'deck'}>
          <div className="panel-heading deck-heading">
            <div>
              <h2>Deck</h2>
              <input
                className="deck-name"
                value={deckName}
                onChange={(event) => setDeckName(event.target.value)}
                aria-label="Deck name"
              />
            </div>
            <div className="deck-tools">
              <div className="view-toggle" aria-label="Deck view mode">
                <button
                  className={deckViewMode === 'list' ? 'active' : ''}
                  type="button"
                  onClick={() => setDeckViewMode('list')}
                >
                  List
                </button>
                <button
                  className={deckViewMode === 'cards' ? 'active' : ''}
                  type="button"
                  onClick={() => setDeckViewMode('cards')}
                >
                  Cards
                </button>
              </div>
              <div className="file-actions">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".ydk,text/plain"
                  onChange={importYdk}
                  hidden
                />
                <button type="button" onClick={() => fileInputRef.current?.click()}>
                  Import YDK
                </button>
                <button type="button" onClick={saveCurrentWorkingDeck}>
                  Save Deck
                </button>
              </div>
            </div>
          </div>
          <div className={`deck-zones ${deckViewMode === 'cards' ? 'card-view' : ''}`}>
            {zoneOrder.map((zone) => (
              <div
                className="deck-zone"
                key={zone}
                onDragOver={handleDeckZoneDragOver}
                onDrop={(event) => handleDeckZoneDrop(event, zone)}
              >
                <h3>
                  {zoneLabels[zone]}
                  <span>
                    {deck[zone].reduce((sum, entry) => sum + entry.quantity, 0)}
                    /{deckZoneLimits[zone]}
                  </span>
                </h3>
                {deck[zone].length ? (
                  deckViewMode === 'cards' ? (
                    <div className="deck-card-grid">
                      {deck[zone].flatMap((entry) =>
                        Array.from({ length: entry.quantity }, (_, copyIndex) => (
                          <article className="deck-card" key={`${entry.card.id}-${copyIndex}`}>
                            <img
                              src={entry.card.card_images?.[0]?.image_url_small}
                              alt={entry.card.name}
                              title="Right-click to remove one. Middle-click to add one."
                              onMouseDown={(event) =>
                                handleDeckCardMouseDown(event, zone, entry.card)
                              }
                              onClick={() => setPreviewCard(entry.card)}
                              onContextMenu={(event) => {
                                event.preventDefault()
                                updateDeckCard(zone, entry.card, -1)
                              }}
                            />
                          </article>
                        )),
                      )}
                    </div>
                  ) : (
                    deck[zone].map((entry) => (
                      <div className="line-item deck-list-item" key={entry.card.id}>
                        <img
                          className="line-thumb"
                          src={entry.card.card_images?.[0]?.image_url_small}
                          alt=""
                          onClick={() => setPreviewCard(entry.card)}
                        />
                        <span>{entry.quantity}x</span>
                        <strong onClick={() => setPreviewCard(entry.card)}>
                          {entry.card.name}
                        </strong>
                        <small>
                          owned {inventoryById.get(entry.card.id) ?? 0}
                        </small>
                      </div>
                    ))
                  )
                ) : (
                  <p className="empty-state">No cards yet.</p>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="panel kaiba-panel" hidden={appPage !== 'deck'}>
          <div className="panel-heading">
            <div>
              <h2>Decks</h2>
              <p>{kaibaDeckDir || kaibaStatus}</p>
              {repoDeckDir ? <p>Repo mirror: {repoDeckDir}</p> : null}
            </div>
            <div className="kaiba-folder-actions">
              <button type="button" onClick={() => void refreshKaibaDecks()}>
                Refresh
              </button>
            </div>
          </div>
          <div className="kaiba-deck-list">
            {kaibaDecks.length ? (
              kaibaDecks.map((deckFile) => (
                <div
                  className={
                    selectedKaibaDeck === deckFile.fileName
                      ? 'kaiba-deck-row selected'
                      : 'kaiba-deck-row'
                  }
                  key={deckFile.fileName}
                >
                  <button
                    className="kaiba-deck-open"
                    type="button"
                    onClick={() => void openKaibaDeck(deckFile.fileName)}
                    onContextMenu={(event) => openDeckContextMenu(event, deckFile.fileName)}
                  >
                    <img src="/kaibacorp-logo.png" alt="" />
                    <strong>{deckFile.name}</strong>
                    <span>{new Date(deckFile.updatedAt).toLocaleString()}</span>
                  </button>
                </div>
              ))
            ) : (
              <p className="empty-state">Refresh to list KaibaPro decks.</p>
            )}
          </div>
          {selectedKaibaDeck ? (
            <div className="deck-history">
              <div className="deck-history-heading">
                <strong>{selectedKaibaDeck} history</strong>
                <span>{deckHistory.length} versions</span>
              </div>
              {deckHistory.length ? (
                <div
                  className="deck-history-graph"
                  style={{
                    ['--history-graph-width' as string]: `${deckHistoryGraph.graphWidth}px`,
                  }}
                >
                  <svg
                    aria-hidden="true"
                    className="deck-history-lines"
                    height={deckHistoryGraph.graphHeight}
                    viewBox={`0 0 ${deckHistoryGraph.graphWidth} ${deckHistoryGraph.graphHeight}`}
                    width={deckHistoryGraph.graphWidth}
                  >
                    <g transform={`translate(${historyGraphInset}, ${historyGraphYOffset})`}>
                      {deckHistoryGraph.paths.map((path) => (
                        <path d={path.d} key={`${path.color}-${path.d}`} stroke={path.color} />
                      ))}
                      {deckHistoryGraph.commits.map((commit) => (
                        <circle
                          className={commit.isActive ? 'active-history-dot' : undefined}
                          cx={commit.x}
                          cy={commit.y}
                          fill="var(--kc-bg)"
                          key={commit.hash}
                          r={commit.isActive ? 9 : 7}
                          stroke={commit.color}
                        />
                      ))}
                    </g>
                  </svg>
                  {deckHistoryGraph.rows.map((version) => {
                    const isActiveVersion = version.id === activeDeckVersionId
                    return (
                      <div
                        className={[
                          'deck-history-row',
                          version.branchName ? 'branch-version' : '',
                          isActiveVersion ? 'active-history-version' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        key={version.id}
                        onContextMenu={(event) => openVersionContextMenu(event, version)}
                        onDoubleClick={() =>
                          void restoreDeckVersion(version.id, false, version.branchName ?? '')
                        }
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter') return
                          event.preventDefault()
                          void restoreDeckVersion(version.id, false, version.branchName ?? '')
                        }}
                        role="button"
                        tabIndex={0}
                      >
                        <div
                          className="deck-history-node"
                          aria-label="Version actions"
                        />
                        <div>
                          <strong>
                            {version.branchName
                              ? `branch: ${version.branchName}`
                              : version.source}
                          </strong>
                          <span>
                            {version.hash || version.id}
                          </span>
                        </div>
                        <span className="deck-history-note">
                          {version.note?.trim() || new Date(version.createdAt).toLocaleString()}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="empty-state">No versions yet.</p>
              )}
            </div>
          ) : null}
          {deckContextMenu ? (
            <div
              className="deck-context-menu"
              style={{ left: deckContextMenu.x, top: deckContextMenu.y }}
              onMouseLeave={() => setDeckContextMenu(null)}
            >
              <button
                className="danger-button"
                type="button"
                onClick={() => void deleteKaibaDeck(deckContextMenu.fileName)}
              >
                Delete
              </button>
            </div>
          ) : null}
          {versionContextMenu ? (
            <div
              className="deck-context-menu version-context-menu"
              style={{ left: versionContextMenu.x, top: versionContextMenu.y }}
              onMouseLeave={() => setVersionContextMenu(null)}
            >
              <button
                type="button"
                onClick={() => void restoreDeckVersion(versionContextMenu.version.id)}
              >
                Restore
              </button>
              <button
                type="button"
                onClick={() => void branchDeckVersion(versionContextMenu.version.id)}
              >
                Branch
              </button>
              <button
                type="button"
                onClick={() => void addDeckVersionNote(versionContextMenu.version)}
              >
                Add Notes
              </button>
              <button
                type="button"
                className="context-danger-button"
                onClick={() => void deleteDeckVersion(versionContextMenu.version)}
              >
                Delete
              </button>
            </div>
          ) : null}
        </section>

      </section>

      {previewCard ? (
        <div
          className="card-preview-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={previewCard.name}
          onClick={() => setPreviewCard(null)}
        >
          <div className="card-preview" onClick={(event) => event.stopPropagation()}>
            <button
              className="card-preview-close"
              type="button"
              onClick={() => setPreviewCard(null)}
              aria-label="Close card preview"
            >
              Close
            </button>
            <div className="card-preview-art">
              <img
                src={
                  previewCard.card_images?.[0]?.image_url_cropped ??
                  previewCard.card_images?.[0]?.image_url ??
                  previewCard.card_images?.[0]?.image_url_small
                }
                alt={previewCard.name}
              />
            </div>
            <div className="card-preview-details">
              <h2>{previewCard.name}</h2>
              <div className="detail-grid">
                <span>Type</span>
                <strong>{previewCard.type}</strong>
                {previewCard.race ? (
                  <>
                    <span>Subtype</span>
                    <strong>{previewCard.race}</strong>
                  </>
                ) : null}
                {previewCard.attribute ? (
                  <>
                    <span>Attribute</span>
                    <strong>{previewCard.attribute}</strong>
                  </>
                ) : null}
                {previewCard.level ? (
                  <>
                    <span>Level/Rank</span>
                    <strong>{previewCard.level}</strong>
                  </>
                ) : null}
                {previewCard.linkval ? (
                  <>
                    <span>Link</span>
                    <strong>{previewCard.linkval}</strong>
                  </>
                ) : null}
                {previewCard.scale ? (
                  <>
                    <span>Scale</span>
                    <strong>{previewCard.scale}</strong>
                  </>
                ) : null}
                {typeof previewCard.atk === 'number' ? (
                  <>
                    <span>ATK</span>
                    <strong>{previewCard.atk}</strong>
                  </>
                ) : null}
                {typeof previewCard.def === 'number' ? (
                  <>
                    <span>DEF</span>
                    <strong>{previewCard.def}</strong>
                  </>
                ) : null}
                {previewCard.archetype ? (
                  <>
                    <span>Archetype</span>
                    <strong>{previewCard.archetype}</strong>
                  </>
                ) : null}
              </div>
              <section className="effect-box">
                <h3>Effect</h3>
                <p>{previewCard.desc}</p>
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

export default App
