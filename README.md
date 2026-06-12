# YGO Inventory Deckbuilder

Local-first MVP for tracking a Yu-Gi-Oh! card inventory, building decks, exporting
`.ydk` files, and copying missing cards into a Cardmarket-ready wants list.

## Features

- Search cards from the YGOPRODeck public API.
- Browse sets, tins, starter decks, and structure decks from YGOPRODeck.
- Add cards to inventory with quantities.
- Add individual cards from a selected set/product to inventory.
- Bulk-add all listed cards from a selected set/product to inventory.
- Build Main, Extra, and Side Deck zones.
- Auto-route Extra Deck monsters when adding from search.
- Import and export `.ydk` files.
- Calculate missing cards from your deck against your inventory.
- Copy missing cards as `3x Card Name` lines for Cardmarket Wants.
- Backup and restore app data as JSON.
- Persist data locally in the browser using `localStorage`.

Bulk adding from sealed products adds one copy of each listed card. The
YGOPRODeck set endpoints do not expose exact duplicate copy counts inside
structure decks.

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Cardmarket Scope

The MVP does not directly add cards to a Cardmarket basket. Cardmarket API access
is restricted, so the first workflow is:

1. Build a deck.
2. Copy the missing-card list.
3. Paste it into a Cardmarket Wants list.
4. Use Cardmarket Shopping Wizard to choose sellers and add cards to cart.

Future versions can add a browser extension or official Cardmarket API support if
credentials are available.
