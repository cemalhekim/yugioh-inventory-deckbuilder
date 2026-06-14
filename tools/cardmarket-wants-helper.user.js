// ==UserScript==
// @name         YGO Inventory Cardmarket Wants Helper
// @namespace    https://github.com/cemalhekim/yugioh-inventory-deckbuilder
// @version      0.1.4
// @description  Reads YGO Inventory payloads on Cardmarket Wants and helps create/fill a Wants list while you stay logged in normally.
// @match        https://www.cardmarket.com/*/YuGiOh/Wants*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @include      https://www.cardmarket.com/*/YuGiOh/Wants*
// @include      http://localhost:*/*
// @include      http://127.0.0.1:*/*
// @run-at       document-end
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict'

  const hashKey = 'ygo-inventory-wants'
  const helperCheckEvent = 'ygo-inventory-cardmarket-helper-check'
  const helperReadyEvent = 'ygo-inventory-cardmarket-helper-ready'
  const helperVersion = '0.1.4'
  const autoParam = 'ygo-auto'

  document.documentElement.setAttribute('data-ygo-inventory-cardmarket-helper', helperVersion)

  window.addEventListener(helperCheckEvent, () => {
    window.dispatchEvent(new CustomEvent(helperReadyEvent, {
      detail: { version: helperVersion },
    }))
  })

  if (!window.location.hostname.includes('cardmarket.com')) return

  function decodePayload() {
    const params = new URLSearchParams(window.location.search)
    const queryPayload = params.get(hashKey)
    const hashMatch = window.location.hash.match(new RegExp(`${hashKey}=([^&]+)`))
    const encodedPayload = queryPayload || hashMatch?.[1]
    if (!encodedPayload) return null

    try {
      const padded = encodedPayload.replace(/-/g, '+').replace(/_/g, '/')
      const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
      return JSON.parse(new TextDecoder().decode(bytes))
    } catch (error) {
      console.error('Could not decode YGO Inventory payload', error)
      return null
    }
  }

  function copyText(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text)
      return
    }
    void navigator.clipboard.writeText(text)
  }

  function visible(element) {
    const rect = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }

  function normalize(text) {
    return text.replace(/\s+/g, ' ').trim().toLowerCase()
  }

  function insideHelper(element) {
    return Boolean(element.closest('#ygo-inventory-cardmarket-helper'))
  }

  function findClickable(labels) {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
    return candidates.find((element) => {
      if (insideHelper(element)) return false
      if (!visible(element)) return false
      const text = normalize(element.innerText || element.value || element.getAttribute('aria-label') || '')
      return labels.some((label) => text.includes(label))
    })
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
  }

  async function waitFor(getValue, timeout = 8000, interval = 250) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeout) {
      const value = getValue()
      if (value) return value
      await sleep(interval)
    }
    return null
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function findTextInput(labels) {
    const fields = Array.from(document.querySelectorAll('input:not([type]), input[type="text"], textarea'))
      .filter((field) => visible(field) && !insideHelper(field))
    return fields.find((field) => {
      const clue = normalize([
        field.name,
        field.id,
        field.placeholder,
        field.getAttribute('aria-label'),
        field.closest('label')?.innerText,
      ].filter(Boolean).join(' '))
      return labels.some((label) => clue.includes(label))
    }) || fields[0]
  }

  function findLargestTextarea() {
    return Array.from(document.querySelectorAll('textarea'))
      .filter((field) => visible(field) && !insideHelper(field))
      .sort((a, b) => (b.rows * b.cols) - (a.rows * a.cols))[0]
  }

  function findSubmitButton(labels = []) {
    return findClickable([
      ...labels,
      'create',
      'save',
      'submit',
      'add',
      'import',
      'continue',
      'ok',
    ])
  }

  async function runAutoCreate(payload, note) {
    if (!payload?.name || !payload?.decklist) {
      note.textContent = 'Auto create skipped: no YGO Inventory payload was found in the URL.'
      return
    }

    const runKey = `ygo-inventory-auto-create-${payload.createdAt || payload.name}`
    if (window.sessionStorage.getItem(runKey)) {
      note.textContent = 'Auto create already ran for this payload. Use Auto create to retry.'
      return
    }
    window.sessionStorage.setItem(runKey, '1')

    try {
      note.textContent = 'Auto create: opening new Wants list form...'
      const newListButton = await waitFor(() =>
        findClickable([
          'new list',
          'create list',
          'create wants list',
          'new wants',
          'wants list',
          'add list',
        ]),
      )
      if (newListButton) {
        newListButton.click()
        await sleep(700)
      }

      note.textContent = 'Auto create: filling list name...'
      const nameInput = await waitFor(() => findTextInput(['name', 'title', 'list']))
      if (!nameInput) throw new Error('Could not find the Wants list name field.')
      setNativeValue(nameInput, payload.name)
      await sleep(250)

      const createButton = findSubmitButton(['create', 'save'])
      if (createButton) {
        note.textContent = 'Auto create: creating list...'
        createButton.click()
        await sleep(1500)
      }

      note.textContent = 'Auto create: opening decklist import...'
      const deckListButton = await waitFor(() =>
        findClickable([
          'add deck list',
          'deck list',
          'decklist',
          'add cards',
          'add want',
          'add wants',
          'import',
        ]),
      )
      if (deckListButton) {
        deckListButton.click()
        await sleep(700)
      }

      note.textContent = 'Auto create: filling missing-card decklist...'
      const deckTextarea = await waitFor(findLargestTextarea)
      if (!deckTextarea) throw new Error('Could not find the decklist textarea.')
      setNativeValue(deckTextarea, payload.decklist)
      await sleep(250)

      const addButton = findSubmitButton(['add deck list', 'add cards', 'add wants', 'import'])
      if (!addButton) {
        note.textContent = 'Decklist filled. Could not find the final add/import button.'
        return
      }

      note.textContent = 'Auto create: submitting decklist...'
      addButton.click()
      await sleep(1000)
      note.textContent = 'Auto create finished. Check the Wants list before using Shopping Wizard.'
    } catch (error) {
      note.textContent = error instanceof Error
        ? `Auto create stopped: ${error.message}`
        : 'Auto create stopped.'
    }
  }

  function injectPanel(payload) {
    if (document.getElementById('ygo-inventory-cardmarket-helper')) return
    const safePayload = payload || {}

    const panel = document.createElement('div')
    panel.id = 'ygo-inventory-cardmarket-helper'
    panel.innerHTML = `
      <div class="ygo-helper-title">YGO Inventory Wants Helper</div>
      <label>List name<input id="ygo-helper-name" readonly></label>
      <label>Deck list<textarea id="ygo-helper-list" readonly></textarea></label>
      <div class="ygo-helper-actions">
        <button id="ygo-helper-auto-create">Auto create</button>
        <button id="ygo-helper-copy-name">Copy name</button>
        <button id="ygo-helper-copy-list">Copy decklist</button>
        <button id="ygo-helper-fill-name">Fill name field</button>
        <button id="ygo-helper-fill-list">Fill decklist field</button>
      </div>
      <div class="ygo-helper-note" id="ygo-helper-note"></div>
    `

    const style = document.createElement('style')
    style.textContent = `
      #ygo-inventory-cardmarket-helper {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 999999;
        width: min(420px, calc(100vw - 36px));
        padding: 14px;
        border: 1px solid #39c8ff;
        border-radius: 8px;
        background: #07101f;
        color: #eaf7ff;
        box-shadow: 0 0 28px rgba(45, 170, 255, 0.35);
        font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #ygo-inventory-cardmarket-helper .ygo-helper-title {
        color: #39c8ff;
        font-weight: 800;
        margin-bottom: 10px;
        text-transform: uppercase;
      }
      #ygo-inventory-cardmarket-helper label {
        display: grid;
        gap: 4px;
        margin: 8px 0;
      }
      #ygo-inventory-cardmarket-helper input,
      #ygo-inventory-cardmarket-helper textarea {
        width: 100%;
        border: 1px solid rgba(57, 200, 255, 0.55);
        border-radius: 4px;
        background: #030a14;
        color: #eaf7ff;
        padding: 8px;
        font: inherit;
      }
      #ygo-inventory-cardmarket-helper textarea {
        height: 120px;
        resize: vertical;
      }
      #ygo-inventory-cardmarket-helper .ygo-helper-actions {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 8px;
      }
      #ygo-inventory-cardmarket-helper button {
        border: 1px solid rgba(57, 200, 255, 0.65);
        border-radius: 4px;
        background: linear-gradient(180deg, #39c8ff, #1f6fff);
        color: #03101d;
        cursor: pointer;
        font-weight: 800;
        padding: 8px;
      }
      #ygo-inventory-cardmarket-helper .ygo-helper-note {
        color: #8fb4cf;
        margin-top: 10px;
      }
    `

    document.documentElement.appendChild(style)
    document.body.appendChild(panel)

    const nameField = document.getElementById('ygo-helper-name')
    const listField = document.getElementById('ygo-helper-list')
    const note = document.getElementById('ygo-helper-note')
    nameField.value = safePayload.name || ''
    listField.value = safePayload.decklist || ''
    note.textContent = safePayload.name || safePayload.decklist
      ? 'Open/create a Wants list on Cardmarket, then use the fill buttons. The script never reads your password.'
      : 'Helper is running, but no YGO Inventory payload was found in the URL. Reopen Cardmarket from the app.'

    document.getElementById('ygo-helper-copy-name').addEventListener('click', () => copyText(nameField.value))
    document.getElementById('ygo-helper-copy-list').addEventListener('click', () => copyText(listField.value))
    document.getElementById('ygo-helper-auto-create').addEventListener('click', () => {
      window.sessionStorage.removeItem(`ygo-inventory-auto-create-${safePayload.createdAt || safePayload.name}`)
      void runAutoCreate(safePayload, note)
    })
    document.getElementById('ygo-helper-fill-name').addEventListener('click', () => {
      const newListButton = findClickable(['new list', 'create list', 'new wants', 'create wants'])
      newListButton?.click()
      window.setTimeout(() => {
        const input = findTextInput(['name', 'title', 'list'])
        if (input) setNativeValue(input, nameField.value)
      }, 300)
    })
    document.getElementById('ygo-helper-fill-list').addEventListener('click', () => {
      const addDeckButton = findClickable(['add deck list', 'deck list', 'decklist'])
      addDeckButton?.click()
      window.setTimeout(() => {
        const textarea = findLargestTextarea()
        if (textarea) setNativeValue(textarea, listField.value)
      }, 300)
    })

    const params = new URLSearchParams(window.location.search)
    if (params.get(autoParam) === '1') {
      window.setTimeout(() => {
        void runAutoCreate(safePayload, note)
      }, 800)
    }
  }

  const payload = decodePayload()
  if (document.body) injectPanel(payload)
  else window.addEventListener('DOMContentLoaded', () => injectPanel(payload))
})()
