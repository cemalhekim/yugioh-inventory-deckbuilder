# KaibaCorp Deck Command

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
- Save app data to `data/inventory-backup.json` (dev) or `/data/inventory-backup.json` (hosted).
- Persist data locally in the browser using `localStorage`.

Bulk adding from sealed products adds one copy of each listed card. The
YGOPRODeck set endpoints do not expose exact duplicate copy counts inside
structure decks.

## Run

```bash
npm install
npm run dev
```

## Hosted (home server)

The same app runs as a container on the home server and is reached at
`https://asuspro-homeserver.tail95ac85.ts.net:11443` over Tailscale. In that
mode `server/index.ts` serves the built `dist/` and the API from `server/api.ts`
against a single data directory (`/data`, bind-mounted from `/srv/data/ygo`):

```
/srv/data/ygo/decks/                 .ydk files, source of truth
/srv/data/ygo/decks/.history/        per-deck version snapshots
/srv/data/ygo/inventory-backup.json  inventory + current deck
/srv/data/ygo/.cache/                card dump + image cache (see below)
```

That directory is also mounted into Nextcloud as the `YuGiOh` folder, so it
syncs to every device with the Nextcloud client; the KaibaPro deck folder on a
desktop can simply be a symlink into it. Simulator launch and OS folder pickers
are desktop-only and hidden in hosted mode.

The stack lives in `/opt/stacks/ygo` on the server; `deploy.sh` there pulls
this repository and rebuilds the image:

```bash
docker build -t ygo-deckbuilder .
docker run --rm -p 3010:3000 -v /srv/data/ygo:/data --user 33:33 ygo-deckbuilder
```

`decks/` and `data/` are no longer tracked in git: the server copy is canonical
and Nextcloud carries it to desktops.

## Card data and images (YGOPRODeck mirror)

The browser never talks to YGOPRODeck directly. `server/cardDb.ts` keeps one
copy of the full card database (`cardinfo.php?misc=yes`, ~25 MB, 14.5k cards)
in `<cache>/cards.json`, re-checks `checkDBVer.php` once a day and only
re-downloads when the database version changed. Card images are fetched on
first view, stored under `<cache>/images/` and served with immutable cache
headers. Upstream requests are throttled to ~3/s. This is what the
[YGOPRODeck API guide](https://ygoprodeck.com/api-guide/) asks for: no request
bursts (limit 20/s, then a one-hour ban) and no image hotlinking.

```
GET /api/cards?ids=1,2,3     cards by passcode; alt-art ids map to the canonical card
GET /api/cards?names=a|b     cards by exact name
GET /api/cards?q=blue-eyes   name search, first 500 + total
GET /api/cards?set=Set Name  cards printed in a set
GET /api/cards/sets          cardsets.php mirror
GET /api/cards/status        loaded, version, count, source (local | upstream)
GET /api/images/<id>/<kind>  kind: small | full | cropped
```

Until the dump is on disk (first start, offline) the same queries are proxied
upstream as single batched requests, so the app works immediately. The cache
directory is `<data>/.cache` (hosted: `/srv/data/ygo/.cache`, dev:
`data/.cache`); hidden so a Nextcloud client sharing the data folder does not
sync it. Point it elsewhere with `YGO_CACHE_DIR`. Loading the dump keeps the
server at roughly 250 MB RSS.

Card data and images courtesy of YGOPRODeck.

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

The repository `decks/` folder is the source of truth during sync. Existing
repository decks are copied out to the selected simulator deck folder whenever
the files differ, so every device that pulls this repository gets the current
deck files. Simulator-only decks are imported into `decks/` only when the
repository does not already have that deck.

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
2. Click Install Helper in the Missing Cards panel and accept the Tampermonkey
   install/update screen.
3. Click Open Cardmarket Wants. The app opens Cardmarket with the helper
   payload in the URL.
4. Use the injected helper panel on Cardmarket to copy/fill the list name and
   missing-card decklist. List names use `Deck Name - YYYY-MM-DD HH-mm-ss`.
5. Use Cardmarket Shopping Wizard to choose sellers and add cards to cart.

The helper expects you to already be logged into Cardmarket in your browser. It
does not ask for or read your Cardmarket password.

Future versions can add a browser extension or official Cardmarket API support if
credentials are available.
