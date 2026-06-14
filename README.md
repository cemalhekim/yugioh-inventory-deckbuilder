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
- Toggle deck display between list view and card-image view.
- Auto-route Extra Deck monsters when adding from search.
- Import and export `.ydk` files.
- Read, open, save, and auto-sync decks from a local KaibaPro 2 deck folder.
- Launch YGOPRO The Dawn of a New Era from the local install path.
- Calculate missing cards from your deck against your inventory.
- Copy missing cards as `3x Card Name` lines for Cardmarket Wants.
- Prepare a Cardmarket Wants workflow by generating a timestamped list name,
  opening the Wants page, and copying the missing-card list.
- Backup and restore app data as JSON.
- Save app data to `data/inventory-backup.json` in this repository.
- Persist data locally in the browser using `localStorage`.

Bulk adding from sealed products adds one copy of each listed card. The
YGOPRODeck set endpoints do not expose exact duplicate copy counts inside
structure decks.

## Run

```bash
npm install
npm run dev
```

When running through the Vite dev server, the app first checks for
`data/inventory-backup.json`. If that repository backup exists, it loads the
saved inventory, deck, and deck name on startup. App changes are automatically
saved back to that repository backup while the dev server is running.

## KaibaPro 2 Sync

When running through Vite dev server, the app exposes a local-only API for the
KaibaPro 2 deck directory:

```bash
/home/ch/Downloads/KaibaPro 2/deck
```

Use the KaibaPro Sync panel to:

- refresh the simulator deck list,
- open an existing `.ydk`,
- save the current app deck back to the selected simulator deck,
- save the current deck as a new simulator `.ydk`.

After a KaibaPro deck is selected, app deck changes are automatically synced
back to that selected `.ydk`.

To use another deck directory, start the dev server with:

```bash
KAIBAPRO_DECK_DIR="/path/to/KaibaPro 2/deck" npm run dev
```

## YGOPRO Launch

When running through the Vite dev server on Windows, the Launch YGOPRO button
starts:

```bash
C:\Yu-Gi-Oh! The Dawn of a New Era\YGOPRO Dawn of a New Era Launcher Pro.exe
```

## Build

```bash
npm run build
```

## Cardmarket Scope

The MVP does not directly log in to Cardmarket or add cards to a Cardmarket
basket. Cardmarket API access is restricted, and the app should not collect or
store Cardmarket account passwords.

The supported workflow is:

1. Build a deck.
2. Install `tools/cardmarket-wants-helper.user.js` in Tampermonkey.
3. Click Open Cardmarket Wants. The app opens Cardmarket with the helper
   payload in the URL.
4. Use the injected helper panel on Cardmarket to copy/fill the list name and
   missing-card decklist. List names use `Deck Name - YYYY-MM-DD HH-mm-ss`.
5. Use Cardmarket Shopping Wizard to choose sellers and add cards to cart.

The helper expects you to already be logged into Cardmarket in your browser. It
does not ask for or read your Cardmarket password.

Future versions can add a browser extension or official Cardmarket API support if
credentials are available.
