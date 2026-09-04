import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import type { Plugin } from 'vite'
import { createApi, type ApiHandler } from './server/api.ts'

// Desktop/dev mode: the repository is the source of truth for decks and the
// app state, the simulator deck folder is mirrored, and OS folder pickers and
// the simulator launcher are available. The hosted container (server/index.ts)
// uses the same API with hosted: true.
const api = createApi({
  deckDir: process.env.KAIBAPRO_DECK_DIR ?? '/home/ch/Downloads/KaibaPro 2/deck',
  repoDeckDir: path.resolve(process.cwd(), 'decks'),
  statePath: path.resolve(process.cwd(), 'data', 'inventory-backup.json'),
  helperPath: path.resolve(process.cwd(), 'tools', 'cardmarket-wants-helper.user.js'),
  simulatorDir:
    process.env.YGOPRO_DIR ??
    process.env.SIMULATOR_APP_DIR ??
    (process.platform === 'win32' ? 'C:\\Yu-Gi-Oh! The Dawn of a New Era' : process.cwd()),
  hosted: false,
})

function apiPlugin(name: string, prefix: string, handler: ApiHandler): Plugin {
  return {
    name,
    configureServer(server) {
      server.middlewares.use(prefix, (req, res) => {
        void handler(req, res)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    apiPlugin('kaibapro-decks-api', '/api/kaibapro/decks', api.decks),
    apiPlugin('repo-app-state-api', '/api/app-state', api.appState),
    apiPlugin('ygopro-launcher-api', '/api/ygopro', api.simulator),
    apiPlugin('host-info-api', '/api/host', api.host),
    apiPlugin('cardmarket-helper-userscript', '/cardmarket-wants-helper.user.js', api.helper),
  ],
})
