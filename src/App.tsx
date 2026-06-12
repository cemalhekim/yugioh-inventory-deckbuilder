import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import './App.css'

type DeckZone = 'main' | 'extra' | 'side'

type YgoCard = {
  id: number
  name: string
  type: string
  desc: string
  race?: string
  attribute?: string
  card_images?: { image_url_small: string; image_url_cropped?: string }[]
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

function isExtraDeckCard(card: YgoCard) {
  return ['Fusion', 'Synchro', 'XYZ', 'Xyz', 'Link'].some((type) =>
    card.type.includes(type),
  )
}

function loadState(): PersistedState {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return { inventory: [], deck: emptyDeck, deckName: 'Untitled Deck' }
  }

  try {
    const parsed = JSON.parse(raw) as PersistedState
    return {
      inventory: parsed.inventory ?? [],
      deck: { ...emptyDeck, ...parsed.deck },
      deckName: parsed.deckName ?? 'Untitled Deck',
    }
  } catch {
    return { inventory: [], deck: emptyDeck, deckName: 'Untitled Deck' }
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

function addCardCopies(deck: DeckState, zone: DeckZone, card: YgoCard, copies = 1) {
  return {
    ...deck,
    [zone]: upsertEntry(deck[zone], card, copies),
  }
}

function makeEntriesFromCards(cards: YgoCard[]) {
  const entries = new Map<number, DeckEntry>()
  for (const card of cards) {
    const current = entries.get(card.id)
    entries.set(card.id, {
      card,
      quantity: (current?.quantity ?? 0) + 1,
    })
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

function App() {
  const [initialState] = useState(loadState)
  const [inventory, setInventory] = useState<InventoryEntry[]>(
    initialState.inventory,
  )
  const [deck, setDeck] = useState<DeckState>(initialState.deck)
  const [deckName, setDeckName] = useState(initialState.deckName)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<YgoCard[]>([])
  const [activeZone, setActiveZone] = useState<DeckZone>('main')
  const [status, setStatus] = useState('Search for a card to start building.')
  const [isSearching, setIsSearching] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const state: PersistedState = { inventory, deck, deckName }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [inventory, deck, deckName])

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
        setResults(payload.data.slice(0, 20))
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
    if (value.trim().length < 2) {
      setResults([])
      setStatus('Search for a card to start building.')
    }
  }

  const inventoryById = useMemo(() => {
    return new Map(inventory.map((entry) => [entry.card.id, entry.quantity]))
  }, [inventory])

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

  const deckSize = zoneOrder.reduce(
    (sum, zone) => sum + deck[zone].reduce((total, entry) => total + entry.quantity, 0),
    0,
  )
  const ownedDeckCards = Array.from(deckTotals.values()).reduce(
    (sum, entry) => sum + Math.min(entry.quantity, inventoryById.get(entry.card.id) ?? 0),
    0,
  )
  const missingCount = missingEntries.reduce((sum, entry) => sum + entry.missing, 0)

  function addToInventory(card: YgoCard, delta = 1) {
    setInventory((current) => {
      const next = upsertEntry(current, card, delta)
      return next.sort((a, b) => a.card.name.localeCompare(b.card.name))
    })
  }

  function addToDeck(card: YgoCard) {
    const targetZone = activeZone === 'main' && isExtraDeckCard(card) ? 'extra' : activeZone
    setDeck((current) => addCardCopies(current, targetZone, card))
  }

  function copyMissingList() {
    const list = missingEntries
      .map((entry) => `${entry.missing}x ${entry.card.name}`)
      .join('\n')
    void navigator.clipboard.writeText(list)
    setStatus('Missing-card list copied for Cardmarket Wants.')
  }

  function downloadYdk() {
    const blob = new Blob([createYdk(deck, deckName)], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${deckName.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'deck'}.ydk`
    link.click()
    URL.revokeObjectURL(url)
    setStatus('YDK exported.')
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
        nextDeck[zone] = makeEntriesFromCards(cards)
      }

      setDeck(nextDeck)
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

  async function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const parsed = JSON.parse(await file.text()) as PersistedState
      setInventory(parsed.inventory ?? [])
      setDeck({ ...emptyDeck, ...parsed.deck })
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
        <div>
          <p className="eyebrow">Yu-Gi-Oh! inventory and deck builder</p>
          <h1>Build from what you own. Buy only what is missing.</h1>
        </div>
        <div className="topbar-actions">
          <button type="button" onClick={downloadYdk}>Download YDK</button>
          <button type="button" onClick={copyMissingList} disabled={!missingEntries.length}>
            Copy Missing
          </button>
        </div>
      </header>

      <section className="stats-row" aria-label="Deck summary">
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
        <div>
          <span>{missingCount}</span>
          Missing
        </div>
      </section>

      <section className="workspace-grid">
        <section className="panel search-panel">
          <div className="panel-heading">
            <h2>Card Search</h2>
            <p>{status}</p>
          </div>
          <input
            className="search-input"
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            placeholder="Search by card name"
          />
          <div className="zone-toggle" aria-label="Target deck zone">
            {zoneOrder.map((zone) => (
              <button
                key={zone}
                className={activeZone === zone ? 'active' : ''}
                type="button"
                onClick={() => setActiveZone(zone)}
              >
                {zoneLabels[zone]}
              </button>
            ))}
          </div>
          <div className="result-list">
            {isSearching ? <p className="muted">Searching...</p> : null}
            {results.map((card) => (
              <article className="card-result" key={card.id}>
                <img src={card.card_images?.[0]?.image_url_small} alt="" />
                <div>
                  <strong>{card.name}</strong>
                  <span>{card.type}</span>
                </div>
                <div className="row-actions">
                  <button type="button" onClick={() => addToInventory(card)}>
                    + Inv
                  </button>
                  <button type="button" onClick={() => addToDeck(card)}>
                    + Deck
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="panel deck-panel">
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
            </div>
          </div>
          <div className="deck-zones">
            {zoneOrder.map((zone) => (
              <div className="deck-zone" key={zone}>
                <h3>
                  {zoneLabels[zone]}
                  <span>{deck[zone].reduce((sum, entry) => sum + entry.quantity, 0)}</span>
                </h3>
                {deck[zone].length ? (
                  deck[zone].map((entry) => (
                    <div className="line-item" key={entry.card.id}>
                      <span>{entry.quantity}x</span>
                      <strong>{entry.card.name}</strong>
                      <small>
                        owned {inventoryById.get(entry.card.id) ?? 0}
                      </small>
                      <button
                        type="button"
                        onClick={() =>
                          setDeck((current) => ({
                            ...current,
                            [zone]: upsertEntry(current[zone], entry.card, -1),
                          }))
                        }
                      >
                        -
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="empty-state">No cards yet.</p>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="panel inventory-panel">
          <div className="panel-heading">
            <h2>Inventory</h2>
            <div className="file-actions">
              <button type="button" onClick={exportBackup}>Backup JSON</button>
              <label className="file-button">
                Restore
                <input type="file" accept="application/json" onChange={importBackup} hidden />
              </label>
            </div>
          </div>
          <div className="inventory-list">
            {inventory.length ? (
              inventory.map((entry) => (
                <div className="line-item inventory-item" key={entry.card.id}>
                  <span>{entry.quantity}x</span>
                  <strong>{entry.card.name}</strong>
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
        </section>

        <section className="panel missing-panel">
          <div className="panel-heading">
            <h2>Missing Cards</h2>
            <p>Copy this list into Cardmarket Wants.</p>
          </div>
          <textarea
            readOnly
            value={missingEntries.map((entry) => `${entry.missing}x ${entry.card.name}`).join('\n')}
            placeholder="Cards missing from your inventory will appear here."
          />
        </section>
      </section>
    </main>
  )
}

export default App
